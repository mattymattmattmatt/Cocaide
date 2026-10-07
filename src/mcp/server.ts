// The Cocaide MCP server: the agent's tools over stdio, one document per
// server. The host decides the document, the write scope and where files go;
// the agent cannot change those.
//
//   tsx src/mcp/server.ts --doc part.cocaide.json [--scope hole_1,+] [--out dir] [--log file]
//                         [--camera name=dx,dy,dz[/ux,uy,uz]]...

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AgentSession, type CallResult } from "../agent/session";
import { parseDocumentText } from "../doc/format";
import { VIEWS, type Camera } from "../render/raster";
import { INSTRUCTIONS, REFERENCE } from "./reference";

const VERSION = "0.3.0";

const obj = z.record(z.string(), z.unknown());
const vec3 = z.array(z.number()).length(3);
const selector = obj.describe(
  'A face selector ({"type":"planar","normal":[0,0,1],"pick":"largest"} or {"type":"cylindrical",...}) or an edge selector ({"type":"edge",...,"pick":"all"}). See cocaide://reference.',
);

interface ToolSpec {
  description: string;
  input?: z.ZodRawShape;
  readOnly?: boolean;
}

export const TOOLS: Record<string, ToolSpec> = {
  listFeatures: {
    description: "The document at a glance: name, revision, write scope, parameters, each feature with its rebuild status and fields, and the part's volume and size.",
    readOnly: true,
  },
  getFeature: {
    description: "One feature's full JSON, its rebuild status, and its values with expressions resolved.",
    input: { id: z.string() },
    readOnly: true,
  },
  addFeature: {
    description: "Add a feature (see cocaide://reference for every op). Appended unless index is given. id is optional. Kept only if the part still rebuilds with nothing newly failing.",
    input: { feature: obj.describe('e.g. {"op":"hole","face":{"type":"planar","normal":[0,0,1],"pick":"largest"},"center":[30,0],"diameter":6.6,"depth":"through"}'), index: z.number().int().optional() },
  },
  updateFeature: {
    description: "Change fields of a feature: patch is merged into it (null removes a field). Rolled back if the part no longer rebuilds.",
    input: { id: z.string(), patch: obj.describe('e.g. {"diameter": 8}') },
  },
  deleteFeature: {
    description: "Delete a feature. Refused while another feature uses it.",
    input: { id: z.string() },
  },
  reorderFeature: {
    description: "Move a feature to another position in the build order. Refused if a feature would come before something it uses.",
    input: { id: z.string(), index: z.number().int() },
  },
  suppressFeature: {
    description: "Suppress a feature (kept in the document, skipped by the rebuild), or unsuppress it.",
    input: { id: z.string(), suppressed: z.boolean() },
  },
  setParameter: {
    description: 'Set a document parameter (creating it if new). Fields written as "=name" follow it; sketches whose dimensions use it are re-solved.',
    input: { name: z.string(), value: z.number() },
  },
  deleteParameter: {
    description: "Delete a parameter that nothing uses.",
    input: { name: z.string() },
  },
  setDimension: {
    description: 'Change one sketch dimension (the constraint at index in the sketch\'s constraints) to a number or "=expression", and re-solve the sketch geometry.',
    input: { sketch: z.string(), index: z.number().int(), value: z.union([z.number(), z.string()]) },
  },
  addEntity: {
    description: "Add an entity (line, circle, arc, rect, slot) to a sketch; id is optional. The sketch re-solves.",
    input: { sketch: z.string(), entity: obj },
  },
  updateEntity: {
    description: "Change fields of a sketch entity (null removes one, e.g. construction). The fields you set are held while the sketch re-solves; a change its constraints forbid is refused.",
    input: { sketch: z.string(), id: z.string(), patch: obj },
  },
  deleteEntity: {
    description: "Delete a sketch entity and every constraint on it.",
    input: { sketch: z.string(), id: z.string() },
  },
  addConstraint: {
    description: "Add a constraint to a sketch; the geometry moves to meet it. A constraint the sketch already implies, or that contradicts it, is refused.",
    input: { sketch: z.string(), constraint: obj },
  },
  deleteConstraint: {
    description: "Delete the constraint at index in a sketch's constraints.",
    input: { sketch: z.string(), index: z.number().int() },
  },
  rebuild: {
    description: "Rebuild the part from the document and report each failing feature.",
    readOnly: true,
  },
  validate: {
    description: "Check the document: schema errors, rebuild errors, and selector health (each selector picks exactly one thing, and is not about to pick another).",
    readOnly: true,
  },
  measure: {
    description: "Without a selector: volume, area, bounding box, mass, holes. With a selector: what it picks on the current part (faces with area, normal, offset, radius; or edges with length and ends).",
    input: { selector: selector.optional() },
    readOnly: true,
  },
  exportSTEP: {
    description: "Write the part as STEP (AP214, mm) to the output folder. Refused if the part has errors.",
    input: { file: z.string().optional().describe("File name; default <document name>.step") },
  },
  exportSTL: {
    description: "Write the part as binary STL (a mesh, for printing) to the output folder.",
    input: { file: z.string().optional().describe("File name; default <document name>.stl") },
  },
  screenshot: {
    description: "Render one view of the part as a PNG. view is a named camera; or give direction (from the part toward the eye). highlight paints what a selector picks.",
    input: {
      view: z.string().optional().describe(`One of ${Object.keys(VIEWS).join(", ")} (default iso), or a camera the host named`),
      direction: vec3.optional(),
      up: vec3.optional(),
      highlight: selector.optional(),
      hiddenEdges: z.boolean().optional().describe("Also draw edges hidden behind material, faintly"),
      width: z.number().int().optional(),
      height: z.number().int().optional(),
    },
    readOnly: true,
  },
  undo: { description: "Step back to the previous revision." },
  redo: { description: "Step forward again after undo." },
};

export function createServer(session: AgentSession): McpServer {
  const server = new McpServer({ name: "cocaide", version: VERSION }, { instructions: INSTRUCTIONS });
  for (const [name, spec] of Object.entries(TOOLS)) {
    server.registerTool(
      name,
      {
        description: spec.description,
        inputSchema: spec.input ?? {},
        annotations: { readOnlyHint: spec.readOnly ?? false, destructiveHint: false, openWorldHint: false },
      },
      async (args: Record<string, unknown>) => toMcp(await session.call(name, args)),
    );
  }
  server.registerResource(
    "reference",
    "cocaide://reference",
    { title: "Cocaide document reference", description: "Every op, field and selector", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: REFERENCE }] }),
  );
  server.registerResource(
    "document",
    "cocaide://document",
    { title: "The document", description: "The current .cocaide.json text", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: session.text }] }),
  );
  return server;
}

function toMcp(out: CallResult) {
  const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
    { type: "text", text: JSON.stringify(out.result) },
  ];
  if (out.image) content.push({ type: "image", data: Buffer.from(out.image).toString("base64"), mimeType: "image/png" });
  return { content, isError: !out.result.ok };
}

export interface ServerArgs {
  doc: string;
  scope?: string[];
  out?: string;
  log?: string;
  cameras: Record<string, Camera>;
}

export function parseArgs(argv: string[]): ServerArgs {
  const args: ServerArgs = { doc: "", cameras: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--doc") args.doc = value();
    else if (a === "--scope") args.scope = value().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--out") args.out = value();
    else if (a === "--log") args.log = value();
    else if (a === "--camera") {
      const m = /^([A-Za-z_][\w-]*)=([-\d.e]+),([-\d.e]+),([-\d.e]+)(?:\/([-\d.e]+),([-\d.e]+),([-\d.e]+))?$/.exec(value());
      if (!m) throw new Error("--camera takes name=dx,dy,dz or name=dx,dy,dz/ux,uy,uz");
      const n = m.slice(2).map(Number);
      args.cameras[m[1]] = { direction: n.slice(0, 3), up: m[5] !== undefined ? n.slice(3, 6) : undefined };
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!args.doc) throw new Error("--doc <file.cocaide.json> is required");
  return args;
}

export async function main(argv: string[]) {
  const args = parseArgs(argv);
  const docPath = resolve(args.doc);
  let doc: unknown;
  if (existsSync(docPath)) {
    const parsed = parseDocumentText(readFileSync(docPath, "utf8"));
    if (!parsed.ok) throw new Error(`${docPath}: ${parsed.error}`);
    doc = parsed.value;
  } else {
    doc = AgentSession.emptyDocument(docPath);
  }
  const session = await AgentSession.open({
    doc,
    docPath,
    logPath: resolve(args.log ?? docPath.replace(/(\.cocaide)?\.json$/, "") + ".cocaide.log.jsonl"),
    outDir: args.out ? resolve(args.out) : undefined,
    writeScope: args.scope && !args.scope.includes("*") ? args.scope : undefined,
    cameras: args.cameras,
  });
  const server = createServer(session);
  await server.connect(new StdioServerTransport());
  const stop = () => {
    session.close();
    process.exit(0);
  };
  process.stdin.on("close", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`cocaide mcp: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

// The Cocaide MCP server: the agent's tools over stdio, one document per
// server. The host decides the document, the write scope and where files go;
// the agent cannot change those.
//
//   tsx src/mcp/server.ts --doc part.cocaide.json [--scope hole_1,+] [--out dir] [--log file]
//                         [--camera name=dx,dy,dz[/ux,uy,uz]]...

import { ADD_LIBRARY_PROFILE_HELP, LIBRARY_SIZE_RULE } from "../weldment/libraryTool";
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
import { SPECS } from "../ask/tools/specs";

const VERSION = "0.7.0";

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
    description:
      "Move a feature to another position in the build order. Refused (saying why) if a feature would come before something it uses: its sketch, a feature whose faces or edges its selectors name by createdBy, a sketch whose dimensions it reads. folder: the tree folder it goes in (null: none); left out, it joins a folder it lands inside.",
    input: { id: z.string(), index: z.number().int(), folder: z.string().nullable().optional() },
  },
  setFolder: {
    description: 'Add, rename or regroup a folder of the feature tree ({ "name", "features": [ids next to each other in the history] }), or remove it (folder: null; its features stay). Folders change nothing that is built.',
    input: { id: z.string(), folder: obj.nullable().describe('{ "name"?: text, "features"?: [feature ids] } or null') },
  },
  suppressFolder: {
    description: "Suppress (or unsuppress) every feature of a tree folder, as one step.",
    input: { id: z.string(), suppressed: z.boolean() },
  },
  suppressFeature: {
    description: "Suppress a feature (kept in the document, skipped by the rebuild), or unsuppress it.",
    input: { id: z.string(), suppressed: z.boolean() },
  },
  setParameter: {
    description:
      'Set a document parameter (creating it if new): a number, or an "=expression" over other parameters and sketch dimensions ("=sketch_1.width / 2"; a cycle is refused). Fields written as "=name" follow it; sketches whose dimensions use it are re-solved.',
    input: { name: z.string(), value: z.union([z.number(), z.string()]) },
  },
  renameParameter: {
    description: "Rename a parameter. Every expression that reads it follows.",
    input: { from: z.string(), to: z.string() },
  },
  renameBody: {
    description: "Rename a body. Every feature and selector that names it follows.",
    input: { from: z.string(), to: z.string() },
  },
  setNode: {
    description: 'Add or move a frame node (coordinates are numbers or "=expressions"), or remove one nothing names (at: null). Members on it move with it.',
    input: { name: z.string(), at: z.array(z.union([z.number(), z.string()])).length(3).nullable() },
  },
  renameNode: {
    description: "Rename a frame node. The members, joints and gussets that name it follow.",
    input: { from: z.string(), to: z.string() },
  },
  setWeld: {
    description: 'Add or replace a weld in the weld table by id, or remove it (weld: null). A weld is a note: { "between": [bodies], "type": "fillet" | "butt" | "plug", "size", "length", "allRound"?, "note"? }.',
    input: { id: z.string(), weld: obj.nullable() },
  },
  deleteParameter: {
    description: "Delete a parameter that nothing uses.",
    input: { name: z.string() },
  },
  setDimension: {
    description:
      'Change one sketch dimension, by index (its place in the sketch\'s constraints) or name ("d2", "width"), to a number or "=expression", and re-solve the sketch geometry. A driven dimension is refused: setDriven false first.',
    input: { sketch: z.string(), index: z.number().int().optional(), name: z.string().optional(), value: z.union([z.number(), z.string()]) },
  },
  renameDimension: {
    description: "Name a sketch dimension (by index or its current name). Expressions anywhere read it as <sketch>.<to>; those that read the old name follow.",
    input: { sketch: z.string(), index: z.number().int().optional(), name: z.string().optional(), to: z.string() },
  },
  setDriven: {
    description: "Make a sketch dimension driven (a reference dimension: measured from the geometry, never solved) or driving again (refused if that would over-define the sketch).",
    input: { sketch: z.string(), index: z.number().int().optional(), name: z.string().optional(), driven: z.boolean() },
  },
  addEntity: {
    description: "Add an entity (line, circle, arc, point, ellipse, spline; rect and slot for older documents) to a sketch; id is optional. The sketch re-solves; the result gives the entity's id and solved geometry.",
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
    description: "Add a constraint to a sketch; the geometry moves to meet it. A constraint the sketch already implies, or that contradicts it, is refused. The result gives its index.",
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
  setBodyMaterial: {
    description: 'Give a body its own material ({ "name": "aluminium 6061", "densityKgPerM3": 2700 }), or put it back on the part\'s (material: null). Its mass, the part\'s and the cut list\'s follow.',
    input: { body: z.string(), material: obj.nullable() },
  },
  setProperties: {
    description: 'Change the part\'s properties: { "partNumber", "description", "revision", "author", "finish", "custom": { name: text } }. Merged in; null removes a field. The drawing\'s title block, the cut list CSV, STEP export and export file names read them.',
    input: { patch: obj },
  },
  addLibraryProfile: {
    description: `${ADD_LIBRARY_PROFILE_HELP} ${LIBRARY_SIZE_RULE}`,
    input: { query: z.string(), sizes: z.array(z.string()).optional(), extraSizes: z.array(z.object({ designation: z.string(), values: z.record(z.string(), z.number()) })).optional(), name: z.string().optional() },
  },
  setCutList: {
    description: "Change the cut list's text and nesting settings (merged): { \"itemText\": [{ \"item\": 1, \"members\": [\"rail_front\", \"rail_back\"], \"description\"?, \"finish\"?, \"notes\"?, \"weldPrep\"?, \"group\"?, \"properties\"?: { \"Supplier\": \"Steel & Co\" } }] } sets text on cut list items (members from the cut list; the kept item sharing them keeps its number; \"\" or null removes a field); \"members\": { \"<member id or body>\": { ...text } } sets one member's own text (alike members with different text become separate items); \"stock\": { \"lengths\": [6000, 6100], \"kerf\": 3, \"trim\": 0, \"minOffcut\": 300, \"profiles\": { \"SHS 40x40x3\": { \"lengths\": [8000] } } } for nesting; \"tolerance\": mm within which lengths are one item (0.5). null removes a field.",
    input: { patch: obj },
  },
  cutList: {
    description: "The cut list as a workshop reads it: every item (members grouped by size, length and end cuts with their orientation; plates and other bodies) with its number, quantity, description, material, length, ends, mass, paint area and typed text; the totals; and the nesting: stock bars to buy and each bar's cuts.",
    readOnly: true,
  },
  exportCutList: {
    description: 'Write the cut list to the output folder: format "csv" (columns: item, quantity, description, profile, designation, standard, material, grade, length, width, thickness, angle1, angle2, orientation, face, ends, cuts, massEach, massTotal, areaEach, areaTotal, plateArea, finish, weldPrep, group, notes, members, "prop:<name>"), "xlsx" (cut list, stock buy list, cutting plan, plates, welds) or "plan" (a printable cutting plan page, HTML).',
    input: { format: z.enum(["csv", "xlsx", "plan"]).optional(), columns: z.array(z.string()).optional(), file: z.string().optional() },
    readOnly: true,
  },
  importStep: {
    description: "Read a STEP file (.step/.stp, any units) from disk into the part as an import feature: each solid becomes a body (newBody, newBody_2 ...), turned by rotate (degrees about X, then Y, then Z) and moved by at. A relative path is from the document's folder.",
    input: { path: z.string(), newBody: z.string().optional(), at: vec3.optional(), rotate: vec3.optional() },
  },
  exportDxf: {
    description: 'Write DXF (ASCII R2000 in mm, or version "R12") to the output folder: what "sketch" (a sketch in its own plane), "face" (a flat face\'s outline, by selector) or "plates" (every flat plate laid flat for cutting: a ZIP of one DXF per plate, an overview and a cutting list).',
    input: { what: z.enum(["sketch", "face", "plates"]), sketch: z.string().optional(), face: selector.optional(), file: z.string().optional(), version: z.enum(["R2000", "R12"]).optional() },
  },
  saveBody: {
    description: "Write one body as a part of its own (.cocaide.json) to the output folder: a copy of this part that keeps only that body, in its material. Fully parametric; not a link.",
    input: { body: z.string(), file: z.string().optional().describe("File name; default <part>-<body>.cocaide.json") },
  },
  newDrawing: {
    description:
      "Make the part's drawing, planned by code: an A3 ISO sheet with a front view, top and right views projected from it (a section through hidden insides instead of the right view, a detail of small crowded features), an iso, the overall size dimensioned, every hole called out, centre marks and lines, a balloon per cut list item, the cut list and weld tables, the title block and general tolerance. Replaces a drawing the part has.",
    input: { date: z.string().optional().describe("The title block's date, e.g. 2026-10-08") },
  },
  setSheet: {
    description:
      'Change a sheet (default the first): its format { "size": "A4".."A0" | "ANSI A".."ANSI E", "orientation": "landscape" | "portrait", "template": "iso" | "ansi" | "minimal" | "classic", title-block fields "title", "subtitle", "number", "revision", "drawnBy", "date", "checkedBy", "checkedDate", "approvedBy", "approvedDate", "company", "material", "finish", "mass" (text; may link $PRP:"name") }, "scale": "1:10" (null: what fits now; New drawing and fitViews store one, and moving views never changes it), "projection": "third" | "first", "name". Format fields may be given flat. Merged in; null removes a field.',
    input: { patch: obj, sheet: z.string().optional() },
  },
  addSheet: {
    description: "Add a sheet (after the others, or at index): it takes its format, projection and title block from the sheet before it unless given in sheet.",
    input: { id: z.string().optional(), sheet: obj.optional(), index: z.number().int().optional() },
  },
  renameSheet: { description: "Rename a sheet's tab (\"\" for the default name).", input: { id: z.string(), name: z.string() } },
  deleteSheet: { description: "Delete a sheet with its views and annotations (never the last one).", input: { id: z.string() } },
  moveSheet: { description: "Move a sheet to place index (0 = first).", input: { id: z.string(), index: z.number().int() } },
  setDrawingOptions: {
    description:
      'The drawing\'s settings: { "standard": "ISO" | "ASME", "units": "mm" | "in", "generalTolerance": "ISO 2768-mK" (or a tolerance block "X.X ±0.5, X.XX ±0.1, ANG ±0.5°"), "properties": { name: text } (title-block links $PRP:"name"), "revisions": [{ rev, description, date, by, approved, zone }] }. Merged in; null removes one; properties and revisions are replaced whole.',
    input: { patch: obj },
  },
  setView: {
    description:
      'Add or replace a view by id, or remove it (view: null) with its annotations and the views made from it. Kinds (see cocaide://reference drawing): model { look: "front".."iso" | "dimetric" | "trimetric" } or { orientation: { eye, up } }; projected { parent, direction: "left" | "right" | "up" | "down" | "upLeft" ... }; section { parent, line: [[x, y], ...] on the parent, half?, aligned?, flip?, depth?, showBehind?, hatch? }; detail { parent, circle: { at, r } or profile, scale?, style? }; auxiliary { parent, edge: "<parent>:e<edge>" }. Any view: at, scale, display ("visible" | "hidden" | "removed" | "shaded" | "shadedEdges"), tangent, threads, breaks, crop, brokenOut, bodies, showLabel, showScale. A new section, detail or auxiliary view gets the next free label.',
    input: { id: z.string(), view: obj.nullable(), sheet: z.string().optional() },
  },
  moveView: {
    description: "Move a view: to at [x, y] on its sheet (null: back to its automatic place; a projected view stays lined up with its parent, and the views lined up with it go with it), and/or to another sheet with its annotations. Never changes a scale or where the other views are; a view off the sheet keeps its scale (the checks say it is off).",
    input: { id: z.string(), at: z.array(z.number()).length(2).nullable().optional(), sheet: z.string().optional() },
  },
  fitViews: {
    description:
      "Fit views to sheet: lay a sheet's views out afresh (the places they were moved to let go, an iso's scale chosen again) at the largest standard scale at which they fit, and store that scale on the sheet. The sheet's scale never changes otherwise, except by setSheet { scale }: moving views never changes it.",
    input: { sheet: z.string().optional() },
  },
  setAnnotation: {
    description:
      "Add or replace an annotation by id, or remove it (annotation: null): a dimension (linear, angular, radius, diameter, ordinate, baseline, chain, arcLength, chamfer, pathLength; tolerances incl. ISO 286 fits), hole callout, balloon, weld symbol (ISO 2553 / AWS), gdt (feature control frame), datum, datumTarget, surface (texture), cosmeticThread, note (rich, leaders, numbered), leader, text, line, sketch, revisionCloud, table, centerMark or centerline (see cocaide://reference drawing). It goes on its view's sheet. What it reads is measured on the rebuild; the result says what it reads.",
    input: { id: z.string(), annotation: obj.nullable(), sheet: z.string().optional() },
  },
  editAnnotation: {
    description:
      'Change some fields of an annotation, keeping the rest: { "tolerance": { "kind": "fit", "fit": "H7" } }, { "at": [x, y] }, { "typ": true }, a frame\'s "rows"; null removes a field. Every kind is in cocaide://reference drawing.',
    input: { id: z.string(), patch: obj },
  },
  setTable: {
    description:
      'Add or replace a table on a sheet by id, or remove it (table: null): { "kind": "cutList" | "bom" | "holes" | "welds" | "revisions" | "general" | "stock", "title"?, "columns"?, "sort"?, "group"?, "maxRows"?, "anchor"?: { "corner": "aboveTitleBlock" | "topRight" ... } or { "at": [x, y] }, "view" and "origin" (holes: a view and "@lowerLeft" or a GeoRef), "header"/"rows" (general) } (see cocaide://reference cutList). Views and annotations keep clear of it.',
    input: { id: z.string(), table: obj.nullable(), sheet: z.string().optional() },
  },
  drawing: {
    description: "The drawing as composed: every sheet's size, template, scale and projection, each view's kind, scale and place, what each annotation reads (or why it can't be drawn), and the drawing checks.",
    readOnly: true,
  },
  geoRefs: {
    description:
      'What a view offers to attach annotations to, as GeoRefs: each edge ("<view>:e<edge>", a line with its true length, an arc or circle with its radius, a curve), each end of one ("<view>:v<edge>.0" / ".1"), each circle\'s centre ("<view>:c<edge>"), with the feature that made it and where it is on the sheet. Edge keys follow the model, so they survive rebuilds.',
    input: { view: z.string() },
    readOnly: true,
  },
  exportDrawing: {
    description: "Write the drawing to the output folder: a vector PDF (every sheet a page, the font embedded; one sheet with sheet), or one sheet (the first unless named) as SVG or DXF (R2000, a layer per kind of line).",
    input: { format: z.enum(["pdf", "svg", "dxf"]), file: z.string().optional().describe("File name; default <document name>-drawing.<format>"), sheet: z.string().optional() },
  },
  // Detailing (wave Q3B): the plan by rules, carrying it out, the critic, the sheet as a picture.
  detailPlan: {
    description:
      'The detailing plan by rules for the drawing (or one view): the part\'s design intent (each hole\'s purpose: clearance per ISO 273, tapped, dowel H7/m6, bearing seat H7/k6, sliding H7/g6; bores; a weldment\'s joints), then items by group (views, sizes and locations, datums A|B|C, fits, position Ø0.1 Ⓜ with basic locating dimensions, flatness on A, perpendicularity of fitted bores, surface texture, weld symbols, general tolerance ISO 2768-mK / ISO 13920-BF, notes, cut list and balloons, title block and revision), each with an id, what it adds and why. options: { standard, generalTolerance, position, roughness }. Read-only: applyDetailPlan carries it out. See cocaide://reference detailing.',
    input: { view: z.string().optional(), options: obj.optional() },
    readOnly: true,
  },
  applyDetailPlan: {
    description: "Carry out the detailing plan as one revision: its items in order (views, then sizes, datums, fits, symbols, notes, tables, title block, then frames under their callouts), what it added moved clear of other text. skip: item ids to leave out; only: just these; options as detailPlan's. Returns what each item made and the critic's findings. Then fix the findings with setAnnotation / editAnnotation / deleteAnnotations and checkDrawing again.",
    input: { skip: z.array(z.string()).optional(), only: z.array(z.string()).optional(), view: z.string().optional(), options: obj.optional() },
  },
  checkDrawing: {
    description:
      "The detailing critic on the drawing as it is now: the drawing checks, every hole sized and located once, a size given twice (or a loop of dimensions over-defining one), dimensions to hidden lines, GD&T validity against the datums on the drawing, the plan's fits and frames present, tolerance stacks of dimension chains (worst case and RSS by toleranceOf, against twice the general tolerance of the span), text running into text, a table or the title block, the general tolerance and material. Each finding says what to do.",
    readOnly: true,
  },
  renderSheet: {
    description: "A picture of a drawing sheet (PNG, about 150 dpi, the first sheet unless named): look at it for crowding, overlaps and anything that does not read like a manufacturing drawing.",
    input: { sheet: z.string().optional() },
    readOnly: true,
  },
  deleteAnnotations: {
    description: "Delete several annotations at once, as one revision.",
    input: { ids: z.array(z.string()) },
  },
  undo: { description: "Step back to the previous revision." },
  redo: { description: "Step forward again after undo." },
  // The tools for building whole parts (inspection, batch, helpers), shared with the right-click agent.
  ...Object.fromEntries(SPECS.map((s) => [s.name, { description: s.description, input: s.input, readOnly: s.readOnly }])),
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

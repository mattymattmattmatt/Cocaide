// The ten assistant scenarios, shared by the scripted agent tests
// (tests/ollama-agent.test.ts: the stand-in plays the model) and the live
// suite (tests/ollama-live.test.ts: a real Ollama, and Claude for comparison).
// Each one runs a real ask on the real kernel and checks the result by
// rebuilding it: volumes, hole counts, sizes. `script` is what the stand-in
// answers; a live model gets the same prompt and is judged by the same check.

import { readFileSync } from "node:fs";
import { runAsk, type AskReach, type AskResult } from "../src/ask/agent";
import type { LocalKernel } from "../src/ask/kernel";
import type { AskModel } from "../src/ask/model";
import type { AskTarget } from "../src/ask/packet";
import { runPartAsk } from "../src/ask/part";
import type { RawDocument } from "../src/doc/commands";
import { emptyIntent, type Intent } from "../src/intent/schema";
import { lastResults, packetOf, type StandInStep } from "./ollama-standin";

export const bracket = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8")) as RawDocument;
export const BRACKET_VOLUME = 18994.728336;
export const EMPTY: RawDocument = { version: 1, units: "mm", name: "part", features: [] };
/** The bracket with its thickness as a parameter. */
export const paramBracket: RawDocument = {
  ...structuredClone(bracket),
  parameters: { plate_t: 6 },
  features: bracket.features.map((f) => (f.id === "ext_1" ? { ...f, distance: "=plate_t" } : structuredClone(f))),
};
const TOP = { type: "planar", normal: [0, 0, 1], pick: "largest" };
const hole = (d: number, depth: number) => Math.PI * (d / 2) ** 2 * depth;

export interface Outcome {
  ok: boolean;
  detail: string;
}

export interface ScenarioRun {
  result?: AskResult;
  /** Calls the model made (tool names, with ✗ for the ones that failed). */
  calls: string[];
  text: string;
}

export interface Scenario {
  name: string;
  prompt: string;
  /** The stand-in's replies for this scenario. */
  script: StandInStep[];
  run(model: AskModel, kernel: LocalKernel, at: Places): Promise<ScenarioRun>;
  check(run: ScenarioRun, kernel: LocalKernel): Promise<Outcome>;
}

/** Faces and edges of the bracket the scenarios point at (found on its topology). */
export interface Places {
  topFace: number;
  sideEdge: number;
}

export async function placesOf(kernel: LocalKernel): Promise<Places> {
  const t = (await kernel.topology(bracket))!;
  return {
    topFace: t.faces.findIndex((f) => f.type === "plane" && f.normal![2] > 0.99),
    sideEdge: t.edges.findIndex((e) => e.kind === "line" && Math.abs(e.end[2] - e.start[2]) > 5),
  };
}

async function ask(model: AskModel, kernel: LocalKernel, doc: RawDocument, target: AskTarget, text: string, reach: AskReach = "target"): Promise<ScenarioRun> {
  const result = target.kind === "part" ? await runPartAsk({ doc, text, model, kernel }) : await runAsk({ doc, target, text, model, kernel, reach });
  return { result, calls: result.calls.map((c) => `${c.tool}${c.ok ? "" : " ✗"}`), text: result.text };
}

/** The proposal's document, rebuilt: volume, holes, size. Null without a proposal. */
async function built(run: ScenarioRun, kernel: LocalKernel) {
  const doc = run.result?.proposal?.doc;
  if (!doc) return null;
  const c = await kernel.check(doc);
  return {
    ok: c.ok,
    errors: c.errors,
    volume: c.measurements?.volume ?? NaN,
    holes: c.measurements?.holeCount ?? 0,
    size: c.measurements?.boundingBox?.size ?? [],
    doc,
  };
}

const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * tol);
const fail = (detail: string): Outcome => ({ ok: false, detail });
const pass = (detail: string): Outcome => ({ ok: true, detail });

async function expectProposal(run: ScenarioRun, kernel: LocalKernel, want: { volume: number; holes?: number; size?: number[] }): Promise<Outcome> {
  if (run.result?.outcome !== "proposal") return fail(`outcome ${run.result?.outcome ?? "none"}: ${run.text.slice(0, 160)}`);
  const b = (await built(run, kernel))!;
  if (!b.ok) return fail(`the proposal does not rebuild: ${b.errors.join("; ")}`);
  if (!near(b.volume, want.volume)) return fail(`volume ${b.volume.toFixed(3)}, expected ${want.volume.toFixed(3)}`);
  if (want.holes !== undefined && b.holes !== want.holes) return fail(`${b.holes} holes, expected ${want.holes}`);
  if (want.size && !want.size.every((s, i) => near(b.size[i], s)))
    return fail(`size ${b.size.map((s) => s.toFixed(2)).join(" × ")}, expected ${want.size.join(" × ")}`);
  return pass(`volume ${b.volume.toFixed(3)}${want.holes !== undefined ? `, ${b.holes} holes` : ""}`);
}

const L_INTENT = (): Intent => ({
  ...emptyIntent(),
  kind: "other",
  name: "l_bracket",
  description: "An L bracket: a 60 x 40 base 5 thick and a 50 tall upright 5 thick along one 40 edge, the depth (40) as a parameter.",
  questions: [],
});
const L_VOLUME = (60 * 5 + 5 * 45) * 40;

export const SCENARIOS: Scenario[] = [
  {
    name: "connect",
    prompt: "Reply with the single word OK.",
    script: [{ content: "OK" }],
    // Run by the tests themselves (they hold the client); a model run here is a one-word reply.
    async run(model, kernel) {
      const result = await runAsk({
        doc: bracket,
        target: { kind: "feature", id: "ext_1" },
        text: "Reply with the single word OK.",
        mode: "explain",
        model,
        kernel,
      });
      return { result, calls: result.calls.map((c) => c.tool), text: result.text };
    },
    async check(run) {
      return run.result?.outcome === "answer" && /ok/i.test(run.text)
        ? pass(`answered "${run.text.slice(0, 20)}"`)
        : fail(`${run.result?.outcome}: ${run.text.slice(0, 120)}`);
    },
  },
  {
    name: "plain chat",
    prompt: "What does this feature do?",
    script: [{ content: "ext_1 extrudes sketch_1, the 80 × 40 rectangle, 6 mm up: it makes the plate the hole goes through." }],
    run: (model, kernel) => ask(model, kernel, bracket, { kind: "feature", id: "ext_1" }, "What does this feature do?"),
    async check(run) {
      if (run.result?.outcome !== "answer") return fail(`outcome ${run.result?.outcome}: ${run.text.slice(0, 120)}`);
      if (run.result.proposal) return fail("a question made a proposal");
      return /extru/i.test(run.text) ? pass("answered, nothing changed") : fail(`the answer does not mention the extrude: ${run.text.slice(0, 120)}`);
    },
  },
  {
    name: "create a parametric bracket",
    prompt: "An L bracket: base 60 x 40, upright 50 tall, both 5 mm thick, 40 deep, with the depth as a parameter.",
    script: [
      // The intent reading (structured output, "format").
      (req) => {
        if (!req.format) throw new Error("expected the intent reading first");
        return { content: JSON.stringify(L_INTENT()) };
      },
      {
        tool_calls: [
          {
            name: "plan",
            arguments: {
              features: ["depth: parameter 40", "sk_l: the L section on Front", "body: extrude sk_l by =depth"],
              checks: [
                { label: "volume", measure: "volume", expected: L_VOLUME },
                { label: "height", measure: "sizeZ", expected: 50 },
              ],
            },
          },
        ],
      },
      {
        tool_calls: [
          {
            name: "batch",
            arguments: {
              commands: [
                { tool: "setParameter", name: "depth", value: 40 },
                {
                  tool: "sketchProfile",
                  sketch: "sk_l",
                  plane: { type: "ref", ref: { datum: "Front" } },
                  shapes: [
                    {
                      polyline: [
                        [0, 0],
                        [60, 0],
                        [60, 5],
                        [5, 5],
                        [5, 50],
                        [0, 50],
                      ],
                      closed: true,
                    },
                  ],
                },
                { tool: "addFeature", feature: { id: "body", op: "extrude", sketch: "sk_l", distance: "=depth" } },
              ],
            },
          },
        ],
      },
      (req) => {
        const r = lastResults(req)[0];
        if (!r.result.ok) throw new Error(`the batch failed: ${JSON.stringify(r.result).slice(0, 300)}`);
        return { tool_calls: [{ name: "partSummary", arguments: {} }] };
      },
      { content: "Built the L bracket: a 60 × 40 base and a 50 tall upright, 5 mm thick, 40 deep (the depth parameter)." },
    ],
    run: (model, kernel) =>
      ask(model, kernel, EMPTY, { kind: "part" }, "An L bracket: base 60 x 40, upright 50 tall, both 5 mm thick, 40 deep, with the depth as a parameter."),
    async check(run, kernel) {
      const o = await expectProposal(run, kernel, { volume: L_VOLUME });
      if (!o.ok) return o;
      const b = (await built(run, kernel))!;
      const params = Object.keys((b.doc.parameters ?? {}) as object);
      return params.length ? pass(`${o.detail}, parameters ${params.join(", ")}`) : fail(`${o.detail}, but no parameter`);
    },
  },
  {
    name: "add holes to an existing part",
    prompt: "Add four 5.5 mm through holes, 8 mm in from each corner of this face.",
    script: [
      (req) => ({
        tool_calls: [
          {
            name: "holes",
            arguments: { face: packetOf(req).selection as Record<string, unknown>, at: { corners: { inset: 8 } }, diameter: 5.5, id: "corner_holes" },
          },
        ],
      }),
      { content: "Added four Ø5.5 through holes, 8 mm in from the corners." },
    ],
    run: (model, kernel, at) =>
      ask(model, kernel, bracket, { kind: "face", index: at.topFace }, "Add four 5.5 mm through holes, 8 mm in from each corner of this face.", "part"),
    check: (run, kernel) => expectProposal(run, kernel, { volume: BRACKET_VOLUME - 4 * hole(5.5, 6), holes: 5 }),
  },
  {
    name: "change a parameter",
    prompt: "Make the plate 10 mm thick.",
    script: [
      { tool_calls: [{ name: "setParameter", arguments: { name: "plate_t", value: 10 } }] },
      { content: "plate_t is now 10: the plate is 10 mm thick." },
    ],
    run: (model, kernel) => ask(model, kernel, paramBracket, { kind: "feature", id: "ext_1" }, "Make the plate 10 mm thick.", "part"),
    check: (run, kernel) => expectProposal(run, kernel, { volume: (80 * 40 - hole(6.6, 1)) * 10, size: [80, 40, 10] }),
  },
  {
    name: "fillet",
    prompt: "Round this edge with a 3 mm fillet.",
    script: [
      (req) => ({ tool_calls: [{ name: "addFeature", arguments: { feature: { id: "fillet_1", op: "fillet", edges: packetOf(req).selection, radius: 3 } } }] }),
      { content: "Filleted the edge, R3." },
    ],
    run: (model, kernel, at) => ask(model, kernel, bracket, { kind: "edge", index: at.sideEdge }, "Round this edge with a 3 mm fillet."),
    check: (run, kernel) => expectProposal(run, kernel, { volume: BRACKET_VOLUME - (1 - Math.PI / 4) * 9 * 6 }),
  },
  {
    name: "inspect a feature",
    prompt: "What size is this hole, and is it through?",
    script: [{ tool_calls: [{ name: "getFeature", arguments: { id: "hole_1" } }] }, { content: "hole_1 is Ø6.6 and goes through the 6 mm plate." }],
    run: (model, kernel) => ask(model, kernel, bracket, { kind: "feature", id: "hole_1" }, "What size is this hole, and is it through?"),
    async check(run) {
      if (run.result?.outcome !== "answer") return fail(`outcome ${run.result?.outcome}: ${run.text.slice(0, 120)}`);
      return /6\.6/.test(run.text)
        ? pass(`answered with ${run.calls.length} look${run.calls.length === 1 ? "" : "s"}`)
        : fail(`the answer lacks 6.6: ${run.text.slice(0, 120)}`);
    },
  },
  {
    name: "invalid tool call",
    prompt: "Make it 8 mm.",
    script: [
      // Wrong case, arguments as a string, the patch missing: refused with the reason, not thrown.
      { tool_calls: [{ name: "update_feature", arguments: '{"id": "hole_1"}' }] },
      (req) => {
        const r = lastResults(req)[0];
        if (r.result.ok !== false || !String(r.result.error).includes('"patch" is required'))
          throw new Error(`expected the schema error back, got ${JSON.stringify(r.result)}`);
        return { tool_calls: [{ name: "updateFeature", arguments: { id: "hole_1", patch: { diameter: 8 } } }] };
      },
      { content: "hole_1 is now Ø8." },
    ],
    run: (model, kernel) => ask(model, kernel, bracket, { kind: "feature", id: "hole_1" }, "Make it 8 mm."),
    async check(run, kernel) {
      const o = await expectProposal(run, kernel, { volume: BRACKET_VOLUME + hole(6.6, 6) - hole(8, 6), holes: 1 });
      return o;
    },
  },
  {
    name: "failed rebuild",
    prompt: "Fillet this edge 45 mm; if that is too big, use the largest that works up to 2 mm.",
    script: [
      (req) => ({ tool_calls: [{ name: "addFeature", arguments: { feature: { id: "fillet_1", op: "fillet", edges: packetOf(req).selection, radius: 45 } } }] }),
      (req) => {
        const r = lastResults(req)[0];
        if (r.result.ok !== false || !String(r.result.error).includes("rolled back"))
          throw new Error(`expected the rolled back rebuild, got ${JSON.stringify(r.result)}`);
        return { tool_calls: [{ name: "addFeature", arguments: { feature: { id: "fillet_1", op: "fillet", edges: packetOf(req).selection, radius: 2 } } }] };
      },
      { content: "R45 does not fit the 40 mm side; filleted it R2 instead." },
    ],
    run: (model, kernel, at) =>
      ask(model, kernel, bracket, { kind: "edge", index: at.sideEdge }, "Fillet this edge 45 mm; if that is too big, use the largest that works up to 2 mm."),
    async check(run, kernel) {
      const failed = run.calls.some((c) => c.endsWith("✗"));
      const o = await expectProposal(run, kernel, { volume: BRACKET_VOLUME - (1 - Math.PI / 4) * 4 * 6, holes: 1 });
      return o.ok ? pass(`${o.detail}${failed ? " after a rolled back try" : ""}`) : o;
    },
  },
  {
    name: "multi-step with several tool calls",
    prompt: "Add a Ø16 boss 10 mm tall at x = -20 on the top face, with a Ø5 hole through it, and check the result.",
    script: [
      // Two looks in one turn, then one batch, then a check.
      {
        tool_calls: [
          { name: "listFaces", arguments: { normal: [0, 0, 1] } },
          { name: "facePlane", arguments: { face: TOP } },
        ],
      },
      {
        tool_calls: [
          {
            name: "batch",
            arguments: {
              commands: [
                {
                  tool: "sketchProfile",
                  sketch: "sk_boss",
                  plane: { type: "ref", ref: { face: TOP } },
                  shapes: [{ circle: { center: [-20, 0], diameter: 16 } }],
                },
                { tool: "addFeature", feature: { id: "boss", op: "extrude", sketch: "sk_boss", distance: 10 } },
                {
                  tool: "addFeature",
                  feature: {
                    id: "boss_hole",
                    op: "hole",
                    face: { type: "planar", normal: [0, 0, 1], rank: 1, pick: "largest" },
                    center: [-20, 0],
                    diameter: 5,
                    depth: "through",
                  },
                },
              ],
            },
          },
        ],
      },
      { tool_calls: [{ name: "partSummary", arguments: {} }] },
      { content: "Added the Ø16 × 10 boss at x = -20 with a Ø5 hole through it; the part rebuilds as one solid." },
    ],
    run: (model, kernel) =>
      ask(
        model,
        kernel,
        bracket,
        { kind: "feature", id: "ext_1" },
        "Add a Ø16 boss 10 mm tall at x = -20 on the top face, with a Ø5 hole through it, and check the result.",
        "part",
      ),
    check: (run, kernel) => expectProposal(run, kernel, { volume: BRACKET_VOLUME + Math.PI * 64 * 10 - hole(5, 16), holes: 2 }),
  },
];

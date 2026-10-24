// Tool calls as document commands, and batch: several of them as one
// transaction. Both hosts share this: each step is turned into commands and
// applied in order (schema and write scope checked as it goes); the host then
// rebuilds the result once and keeps it only if nothing newly fails, as one
// revision and one undo step. A dry run stops before keeping anything.

import { apply, nextId, type Command, type RawDocument } from "../../doc/commands";
import type { WriteScope } from "../../doc/scope";
import { isObject } from "../../doc/validate";
import type { KernelPort } from "../kernel";
import { fullyDefineCommand, holesCommands } from "./helpers";
import { sketchProfile } from "./sketchProfile";

type Raw = Record<string, unknown>;

/** The write tools that are plain commands (both hosts; a host may offer fewer). */
export const COMMAND_TOOLS = [
  "addFeature",
  "updateFeature",
  "deleteFeature",
  "reorderFeature",
  "suppressFeature",
  "setParameter",
  "deleteParameter",
  "renameParameter",
  "renameBody",
  "setNode",
  "renameNode",
  "setWeld",
  "setBodyMaterial",
  "setProperties",
  "setSheet",
  "setView",
  "setAnnotation",
  "setDimension",
  "renameDimension",
  "setDriven",
  "addEntity",
  "updateEntity",
  "deleteEntity",
  "addConstraint",
  "deleteConstraint",
] as const;

/** The helpers that write: each becomes ordinary commands. */
export const HELPER_TOOLS = ["sketchProfile", "fullyDefine", "holes"] as const;

/** Every tool a batch step may name. */
export const BATCH_TOOLS: readonly string[] = [...COMMAND_TOOLS, ...HELPER_TOOLS];

/** One write tool call as a command, or why it can't be one. */
export function toolCommand(name: string, a: Raw): Command | string {
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  const obj = (k: string) => (isObject(a[k]) ? { ...(a[k] as Raw) } : null);
  const which = { ...(typeof a.index === "number" ? { index: a.index } : {}), ...(typeof a.name === "string" ? { name: a.name } : {}) };
  switch (name) {
    case "updateFeature":
      return obj("patch") ? { type: "updateFeature", id: str("id"), patch: obj("patch")! } : "updateFeature: patch must be an object";
    case "addFeature":
      return obj("feature") ? { type: "addFeature", feature: obj("feature")!, ...(typeof a.index === "number" ? { index: a.index } : {}) } : "addFeature: feature must be an object";
    case "suppressFeature":
      return { type: "suppressFeature", id: str("id"), suppressed: a.suppressed !== false };
    case "deleteFeature":
      return { type: "deleteFeature", id: str("id") };
    case "reorderFeature":
      return { type: "reorderFeature", id: str("id"), index: a.index as number };
    case "setParameter":
      return { type: "setParameter", name: str("name"), value: a.value as number | string };
    case "deleteParameter":
      return { type: "deleteParameter", name: str("name") };
    case "renameParameter":
      return { type: "renameParameter", from: str("from"), to: str("to") };
    case "renameBody":
      return { type: "renameBody", from: str("from"), to: str("to") };
    case "setNode":
      return { type: "setNode", name: str("name"), at: Array.isArray(a.at) ? (a.at as (number | string)[]) : null };
    case "renameNode":
      return { type: "renameNode", from: str("from"), to: str("to") };
    case "setWeld":
      return { type: "setWeld", id: str("id"), weld: obj("weld") };
    case "setBodyMaterial":
      return { type: "setBodyMaterial", body: str("body"), material: obj("material") };
    case "setAnnotation":
      return { type: "setAnnotation", id: str("id"), annotation: obj("annotation") };
    case "setView":
      return { type: "setView", id: str("id"), view: obj("view") };
    case "setSheet":
      return obj("patch") ? { type: "setSheet", patch: obj("patch")! } : "setSheet: patch must be an object";
    case "setProperties":
      return obj("patch") ? { type: "setProperties", patch: obj("patch")! } : "setProperties: patch must be an object of part properties";
    case "setDimension":
      return { type: "setDimension", sketch: str("sketch"), ...which, value: a.value as number | string };
    case "renameDimension":
      return { type: "renameDimension", sketch: str("sketch"), ...which, to: str("to") };
    case "setDriven":
      return { type: "setDriven", sketch: str("sketch"), ...which, driven: a.driven !== false };
    case "addEntity":
      return obj("entity") ? { type: "addEntity", sketch: str("sketch"), entity: obj("entity")! } : "addEntity: entity must be an object";
    case "updateEntity":
      return obj("patch") ? { type: "updateEntity", sketch: str("sketch"), id: str("id"), patch: obj("patch")! } : "updateEntity: patch must be an object";
    case "deleteEntity":
      return { type: "deleteEntity", sketch: str("sketch"), id: str("id") };
    case "addConstraint":
      return obj("constraint") ? { type: "addConstraint", sketch: str("sketch"), constraint: obj("constraint")! } : "addConstraint: constraint must be an object";
    case "deleteConstraint":
      return { type: "deleteConstraint", sketch: str("sketch"), index: a.index as number };
    default:
      return `unknown tool "${name}"`;
  }
}

/**
 * What a kept command made, for the model to use next without guessing: the
 * id of a feature it added, the id and solved geometry of an entity, the
 * index of a constraint.
 */
export function commandMade(before: RawDocument, after: RawDocument, cmd: Command): Raw {
  const sketchOf = (d: RawDocument, id: string) => d.features.find((f) => f.id === id);
  switch (cmd.type) {
    case "addFeature":
      return { id: (cmd.feature as Raw).id };
    case "addEntity": {
      const was = new Set(((sketchOf(before, cmd.sketch)?.entities ?? []) as Raw[]).map((e) => e.id));
      const e = ((sketchOf(after, cmd.sketch)?.entities ?? []) as Raw[]).find((x) => !was.has(x.id));
      return e ? { entity: e.id, solved: e } : {};
    }
    case "addConstraint": {
      const list = (sketchOf(after, cmd.sketch)?.constraints ?? []) as Raw[];
      return { index: list.length - 1 };
    }
    default:
      return {};
  }
}

export interface Expanded {
  commands: Command[];
  /** What the step made, for its result. */
  info: Raw;
}

/** One tool call (a write tool or a helper) as the commands it stands for, on the document as it is. */
export async function expandTool(doc: RawDocument, kernel: KernelPort, name: string, a: Raw): Promise<Expanded | string> {
  if (name === "sketchProfile") {
    const r = sketchProfile(doc, a);
    if (typeof r === "string") return r;
    return { commands: [r.command], info: { sketch: r.sketch, created: r.created, shapes: r.shapes, added: r.added.length, dof: r.dof, fullyDefined: r.dof === 0, profile: r.profile } };
  }
  if (name === "fullyDefine") return fullyDefineCommand(doc, a);
  if (name === "holes") return holesCommands(doc, kernel, a);
  const cmd = toolCommand(name, a);
  if (typeof cmd === "string") return cmd;
  if (cmd.type === "addFeature") {
    const f = cmd.feature as Raw;
    if (f.id === undefined && typeof f.op === "string") f.id = nextId(doc, f.op);
  }
  return { commands: [cmd], info: {} };
}

export interface StepResult {
  step: number;
  tool: string;
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

export type Planned =
  | { ok: true; doc: RawDocument; commands: Command[]; results: StepResult[]; added: string[] }
  | { ok: false; error: string; failedStep: number; results: StepResult[] };

export interface PlanOptions {
  /** The scope the commands must stay in; ids the batch adds join it as it goes. Absent: anything. */
  scope?: WriteScope;
  /** A host rule on a feature before it is added (the right-click face and edge rule). */
  check?(cmd: Command, doc: RawDocument): Promise<string | null>;
  /** The tools this host offers in a batch. */
  allowed?: readonly string[];
}

/**
 * The steps applied one after another on a copy of the document: each one's
 * commands schema- and scope-checked as it goes. The first that fails stops
 * the batch; nothing is kept. Not rebuilt here: the host rebuilds the result
 * once and keeps it only if nothing newly fails.
 */
export async function planBatch(base: RawDocument, kernel: KernelPort, steps: unknown, opts: PlanOptions = {}): Promise<Planned> {
  if (!Array.isArray(steps) || steps.length === 0) return { ok: false, error: 'batch: "commands" must list at least one step, e.g. { "tool": "addFeature", "feature": {...} }', failedStep: 0, results: [] };
  const allowed = opts.allowed ?? BATCH_TOOLS;
  let doc = base;
  const commands: Command[] = [];
  const results: StepResult[] = [];
  const added: string[] = [];
  const scope = opts.scope ? [...opts.scope] : undefined;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const stop = (tool: string, error: string): Planned => {
      results.push({ step: i + 1, tool, ok: false, error });
      return { ok: false, error: `batch step ${i + 1} (${tool}): ${error}. Nothing in the batch was kept.`, failedStep: i + 1, results };
    };
    if (!isObject(s) || typeof s.tool !== "string") return stop("?", 'each step must be { "tool": "<tool name>", ...that tool\'s arguments }');
    const tool = s.tool;
    if (!allowed.includes(tool)) return stop(tool, `a batch step may be one of ${allowed.join(", ")}`);
    const args = isObject(s.args) ? s.args : Object.fromEntries(Object.entries(s).filter(([k]) => k !== "tool"));
    const x = await expandTool(doc, kernel, tool, args);
    if (typeof x === "string") return stop(tool, x);
    for (const cmd of x.commands) {
      if (opts.check) {
        const problem = await opts.check(cmd, doc);
        if (problem) return stop(tool, problem);
      }
      const r = apply(doc, cmd, { writeScope: scope });
      if (!r.ok) return stop(tool, r.error);
      Object.assign(x.info, commandMade(doc, r.doc, cmd));
      if (cmd.type === "addFeature") {
        const id = String((cmd.feature as Raw).id);
        added.push(id);
        // A feature the batch added is its to change in later steps.
        scope?.push(id, `${id}/*`);
      }
      doc = r.doc;
      commands.push(cmd);
    }
    results.push({ step: i + 1, tool, ok: true, ...x.info });
  }
  return { ok: true, doc, commands, results, added };
}

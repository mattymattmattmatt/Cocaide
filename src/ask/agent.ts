// The right-click ask (spec 6): build the packet, let the model answer or
// edit inside the target's write scope, and return a proposal the user
// accepts or discards. Edits run in a sandbox copy of the document, each one
// a checked transaction; the user's document is untouched until accept.

import type Anthropic from "@anthropic-ai/sdk";
import { apply, type Command, type RawDocument } from "../doc/commands";
import { formatDocument } from "../doc/format";
import { documentParameters, resolveExpressions } from "../doc/parameters";
import type { Vec3 } from "../doc/types";
import { isObject } from "../doc/validate";
import { dot3, normalize3 } from "../geom/vec";
import { edgeSummary, faceSummary, measurementSummary, newFailures, round6 } from "../kernel/inspect";
import type { CheckResult, KernelPort, PartTopology } from "./kernel";
import type { AskModel } from "./model";
import { buildPacket, type AskTarget, type Packet } from "./packet";
import { classify, isVisual, SYSTEM, toolsFor, userTurn, WRITE_TOOL_NAMES, type AskMode } from "./prompt";

/** Model turns per ask. */
const MAX_TURNS = 8;
/** Edit turns allowed after the first kept edit: one correction pass (spec 6.2). */
const CORRECTIONS = 1;

export interface AskRequest {
  doc: RawDocument;
  target: AskTarget;
  text: string;
  model: AskModel;
  kernel: KernelPort;
  signal?: AbortSignal;
  onEvent?(e: AskEvent): void;
}

export type AskEvent =
  | { type: "packet"; packet: Packet; mode: AskMode; visual: boolean }
  | { type: "thinking"; turn: number }
  | { type: "tool"; name: string; ok: boolean; error?: string };

export interface AskCall {
  tool: string;
  input: unknown;
  ok: boolean;
  error?: string;
  /** Sandbox revision after the call (counts kept edits) and its document hash. */
  revision: number;
  hash: string;
}

export interface Change {
  id: string;
  kind: "added" | "removed" | "changed";
  /** Leaf changes for a changed feature: "diameter: 6.6 → 8". */
  fields?: { path: string; before: unknown; after: unknown }[];
}

export interface Proposal {
  /** The commands, in order. Accepting replays them on the document as it is then. */
  commands: Command[];
  /** Scope the commands ran under (with the ids the ask added). */
  scope: string[];
  /** The document the ask started from, and the proposed result. */
  base: RawDocument;
  doc: RawDocument;
  changes: Change[];
  /** Feature ids the proposal adds, removes or changes; a user edit to one of them drops it (spec 6.4). */
  touched: string[];
  volumeBefore: number | null;
  volumeAfter: number | null;
}

export interface AskResult {
  outcome: "answer" | "proposal" | "refused" | "failed";
  text: string;
  mode: AskMode;
  visual: boolean;
  packet: Packet | null;
  proposal: Proposal | null;
  calls: AskCall[];
  model: string;
  turns: number;
}

export async function runAsk(req: AskRequest): Promise<AskResult> {
  const mode = classify(req.text);
  const visual = isVisual(req.text, req.target);
  const result: AskResult = { outcome: "failed", text: "", mode, visual, packet: null, proposal: null, calls: [], model: req.model.name, turns: 0 };
  let packet: Packet;
  try {
    packet = await buildPacket(req.doc, req.target, req.kernel);
  } catch (e) {
    result.text = `Could not read the target: ${(e as Error).message}`;
    return result;
  }
  result.packet = packet;
  req.onEvent?.({ type: "packet", packet, mode, visual });

  const image = visual ? await framedShot(req.doc, req.target, packet, req.kernel) : undefined;
  const sandbox = await Sandbox.open(req.doc, req.target, packet, mode, req.kernel);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userTurn(packet, req.text, mode, image) }];
  const tools = toolsFor(mode);
  const texts: string[] = [];
  let corrections = 0;

  try {
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      req.onEvent?.({ type: "thinking", turn });
      const msg = await req.model.next({ system: SYSTEM, messages, tools }, req.signal);
      result.turns = turn;
      messages.push({ role: "assistant", content: msg.content });
      const said = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text.trim()).filter(Boolean);
      if (said.length) texts.splice(0, texts.length, ...said); // keep the latest words
      if (msg.stop_reason === "refusal") {
        result.text = "The model declined this request.";
        return result;
      }
      const uses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (uses.length === 0) break;
      if (msg.stop_reason === "max_tokens") {
        result.text = "The model ran out of room mid-call; nothing from that turn was applied.";
        return result;
      }
      // Attempts that were rejected do not count; once an edit is kept, one more edit turn is the correction pass.
      const editsThisTurn = uses.some((u) => WRITE_TOOL_NAMES.has(u.name));
      if (editsThisTurn && sandbox.commands.length > 0) corrections++;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const u of uses) {
        const out =
          WRITE_TOOL_NAMES.has(u.name) && corrections > CORRECTIONS
            ? { ok: false, error: "no more edits in this ask: one correction pass only. Stop and tell the user where it stands." }
            : await sandbox.run(u.name, u.input);
        result.calls.push({ tool: u.name, input: u.input, ok: out.ok, ...(out.error ? { error: out.error } : {}), revision: sandbox.revision, hash: sandbox.hash });
        req.onEvent?.({ type: "tool", name: u.name, ok: out.ok, ...(out.error ? { error: out.error } : {}) });
        results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out), ...(out.ok ? {} : { is_error: true }) });
      }
      messages.push({ role: "user", content: results });
      if (sandbox.escalated) break;
      if (turn === MAX_TURNS) texts.push(`(Stopped after ${MAX_TURNS} steps.)`);
    }
  } catch (e) {
    if (req.signal?.aborted) {
      result.text = "Cancelled.";
      return result;
    }
    result.text = `The ask failed: ${(e as Error).message}`;
    return result;
  }

  if (sandbox.escalated) {
    // Escalating ends the ask with nothing changed, even if edits were tried first.
    result.outcome = "refused";
    result.text = [sandbox.escalated, ...texts.filter((t) => t !== sandbox.escalated)].join("\n\n");
    return result;
  }
  result.text = texts.join("\n\n");
  if (sandbox.commands.length) {
    result.outcome = "proposal";
    result.proposal = await sandbox.proposal();
  } else if (result.calls.some((c) => !c.ok && c.error?.startsWith("writeScope:"))) {
    result.outcome = "refused";
    if (!result.text) result.text = result.calls.find((c) => c.error?.startsWith("writeScope:"))!.error!;
  } else {
    result.outcome = "answer";
  }
  return result;
}

/**
 * Accepting a proposal: replay its commands on the document as it is now,
 * under the same scope, as one change. Fails if the user's own edits since
 * then make any command invalid.
 */
export function applyProposal(doc: RawDocument, p: Proposal): { ok: true; doc: RawDocument } | { ok: false; error: string } {
  let current = doc;
  for (const cmd of p.commands) {
    const r = apply(current, cmd, { writeScope: p.scope });
    if (!r.ok) return { ok: false, error: r.error };
    current = r.doc;
  }
  return { ok: true, doc: current };
}

/** Features a user edit changed, compared with the document a proposal was made from. */
export function conflictsWith(p: Proposal, doc: RawDocument): string[] {
  const now = new Map(doc.features.map((f) => [String(f.id), JSON.stringify(f)]));
  const then = new Map(p.base.features.map((f) => [String(f.id), JSON.stringify(f)]));
  return p.touched.filter((id) => now.get(id) !== then.get(id));
}

// ---------------------------------------------------------------- sandbox

type Outcome = { ok: boolean; error?: string } & Record<string, unknown>;

class Sandbox {
  doc: RawDocument;
  check: CheckResult;
  revision = 0;
  hash = "";
  readonly commands: Command[] = [];
  readonly owned = new Set<string>();
  escalated: string | null = null;
  private addedSketch: string | null = null;
  private addedFeature: string | null = null;
  private baseTopology: PartTopology | null | undefined;

  private constructor(
    readonly base: RawDocument,
    private readonly baseCheck: CheckResult,
    private readonly target: AskTarget,
    private readonly packet: Packet,
    private readonly mode: AskMode,
    private readonly kernel: KernelPort,
  ) {
    this.doc = base;
    this.check = baseCheck;
  }

  static async open(doc: RawDocument, target: AskTarget, packet: Packet, mode: AskMode, kernel: KernelPort): Promise<Sandbox> {
    const s = new Sandbox(doc, await kernel.check(doc), target, packet, mode, kernel);
    s.hash = await hashDoc(doc);
    return s;
  }

  get scope(): string[] {
    return [...this.packet.writeScope, ...this.owned];
  }

  /** Ids the packet names: the agent may read these and nothing else. */
  private context(): Set<string> {
    const ids = new Set<string>();
    const add = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(add);
      else if (isObject(v) && typeof v.id === "string") ids.add(v.id);
    };
    const t = this.packet.target as Record<string, unknown>;
    for (const k of ["id", "sketch"]) if (typeof t[k] === "string") ids.add(t[k] as string);
    add(this.packet.parent);
    add(this.packet.children);
    for (const id of this.owned) ids.add(id);
    return ids;
  }

  async run(name: string, input: unknown): Promise<Outcome> {
    const a = isObject(input) ? input : {};
    switch (name) {
      case "escalate":
        this.escalated = typeof a.reason === "string" && a.reason.trim() ? a.reason.trim() : "This cannot be done from here.";
        return { ok: true, stopped: true };
      case "getFeature": {
        const id = String(a.id);
        if (!this.context().has(id)) return { ok: false, error: `${id} is outside this ask's context (the packet's target, parent and children)` };
        const f = this.doc.features.find((x) => x.id === id);
        return f ? { ok: true, feature: f } : { ok: false, error: `no feature "${id}"` };
      }
      case "measure":
        return this.measure(a.selector);
    }
    if (!WRITE_TOOL_NAMES.has(name)) return { ok: false, error: `unknown tool "${name}"` };
    if (this.mode === "explain") return { ok: false, error: "this ask is a question; it cannot change the part" };
    const cmd = toCommand(name, a);
    if (typeof cmd === "string") return { ok: false, error: cmd };
    return this.edit(cmd);
  }

  private async measure(selector: unknown): Promise<Outcome> {
    if (selector === undefined || selector === null) {
      const m = this.check.measurements;
      return m ? { ok: true, ...measurementSummary(m) } : { ok: false, error: "there is no solid yet" };
    }
    const r = await this.kernel.select(this.doc, selector);
    if (!r.ok) return { ok: false, error: r.error };
    return r.kind === "faces"
      ? { ok: true, matched: r.faces.length, faces: r.faces.slice(0, 20).map(faceSummary) }
      : { ok: true, matched: r.edges.length, edges: r.edges.slice(0, 20).map(edgeSummary) };
  }

  private async edit(cmd: Command): Promise<Outcome> {
    if (cmd.type === "addFeature") {
      const f = cmd.feature as Record<string, unknown>;
      if (f.id === undefined) f.id = nextFree(this.doc, String(f.op));
      const problem = await this.addRule(cmd.feature as Record<string, unknown>);
      if (problem) return { ok: false, error: problem };
    }
    const applied = apply(this.doc, cmd, { writeScope: this.scope });
    if (!applied.ok) return { ok: false, error: applied.error };
    const next = await this.kernel.check(applied.doc);
    const broke = newFailures(this.check, next);
    if (broke.length) return { ok: false, error: `${cmd.type} rolled back: ${broke.join("; ")}` };
    this.doc = applied.doc;
    this.check = next;
    this.commands.push(cmd);
    if (cmd.type === "addFeature") {
      const f = cmd.feature as Record<string, unknown>;
      this.owned.add(String(f.id));
      if (f.op === "sketch") this.addedSketch = String(f.id);
      else this.addedFeature = String(f.id);
    }
    this.revision++;
    this.hash = await hashDoc(this.doc);
    const touched = touchedIds(this.base, this.doc);
    const topo = await this.kernel.topology(this.doc);
    const out: Outcome = { ok: true, volume: next.measurements ? round6(next.measurements.volume) : null };
    if (next.errors.length) out.errors = next.errors;
    out.features = touched.map((id) => ({ id, ...localMeasurements(this.doc, id, topo) }));
    return out;
  }

  /**
   * From a face or edge the ask adds one feature, and it must use that face
   * or edge (spec 6.2). A sketch on the face, plus the one cut or extrude of
   * it, counts as that feature.
   */
  private async addRule(f: Record<string, unknown>): Promise<string | null> {
    const t = this.target;
    if (t.kind !== "face" && t.kind !== "edge") return null;
    if (!isObject(f)) return "feature must be an object";
    const rf = resolveExpressions(f, documentParameters(this.doc), []) as Record<string, unknown>;
    const where = t.kind === "face" ? "the face you right-clicked" : "the edge you right-clicked";
    if (f.op === "sketch") {
      if (t.kind !== "face") return "from an edge, the ask adds a fillet or chamfer of that edge";
      if (this.addedSketch) return "from a face, the ask adds one feature (one sketch and the cut or extrude of it)";
      const face = (await this.topology())?.faces[t.index];
      const plane = rf.plane as { normal?: Vec3; origin?: Vec3 } | undefined;
      if (!face?.normal || !plane?.normal || !plane.origin) return `the sketch must lie on ${where}`;
      const n = normalize3(plane.normal);
      if (Math.abs(Math.abs(dot3(n, face.normal)) - 1) > 1e-6 || Math.abs(dot3(plane.origin, face.normal) - (face.offset ?? 0)) > 1e-6) {
        return `the sketch must lie on ${where} (plane normal ${JSON.stringify(face.normal)}, offset ${round6(face.offset ?? 0)})`;
      }
      return null;
    }
    if (this.addedFeature) return `from a ${t.kind}, the ask adds one feature; ${this.addedFeature} is it`;
    if (f.op === "extrude" || f.op === "cut") {
      return this.addedSketch && f.sketch === this.addedSketch ? null : `a ${String(f.op)} from here must use the sketch added on ${where}`;
    }
    if (f.op === "hole") {
      if (t.kind !== "face") return "from an edge, the ask adds a fillet or chamfer of that edge";
      const r = await this.kernel.select(this.base, rf.face);
      if (!r.ok || r.kind !== "faces" || r.indices.length !== 1 || r.indices[0] !== t.index) {
        return `the hole's face selector must pick ${where}; use the packet's selection`;
      }
      return null;
    }
    if (f.op === "fillet" || f.op === "chamfer") {
      const selectors = Array.isArray(rf.edges) ? rf.edges : [rf.edges];
      const topo = await this.topology();
      const picked = new Set<number>();
      for (const sel of selectors) {
        const r = await this.kernel.select(this.base, sel);
        if (!r.ok || r.kind !== "edges") return `the ${String(f.op)}'s edges must be ${t.kind === "edge" ? where : `edges of ${where}`}`;
        r.indices.forEach((i) => picked.add(i));
      }
      const ok = t.kind === "edge" ? picked.has(t.index) : [...picked].every((i) => topo?.edges[i]?.faces.includes(t.index));
      return ok && picked.size > 0 ? null : `the ${String(f.op)}'s edges must be ${t.kind === "edge" ? `${where} (and may include others along it)` : `edges of ${where}`}`;
    }
    return `from a ${t.kind}, the ask adds a hole, fillet, chamfer, or a sketch on the face with its cut or extrude`;
  }

  private async topology(): Promise<PartTopology | null> {
    if (this.baseTopology === undefined) this.baseTopology = await this.kernel.topology(this.base);
    return this.baseTopology;
  }

  async proposal(): Promise<Proposal> {
    return {
      commands: this.commands,
      scope: this.scope,
      base: this.base,
      doc: this.doc,
      changes: diffDocs(this.base, this.doc),
      touched: touchedIds(this.base, this.doc),
      volumeBefore: this.baseCheck.measurements ? round6(this.baseCheck.measurements.volume) : null,
      volumeAfter: this.check.measurements ? round6(this.check.measurements.volume) : null,
    };
  }
}

function toCommand(name: string, a: Record<string, unknown>): Command | string {
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  const obj = (k: string) => (isObject(a[k]) ? { ...(a[k] as Record<string, unknown>) } : null);
  switch (name) {
    case "updateFeature":
      return obj("patch") ? { type: "updateFeature", id: str("id"), patch: obj("patch")! } : "updateFeature: patch must be an object";
    case "addFeature":
      return obj("feature") ? { type: "addFeature", feature: obj("feature")!, ...(typeof a.index === "number" ? { index: a.index } : {}) } : "addFeature: feature must be an object";
    case "suppressFeature":
      return { type: "suppressFeature", id: str("id"), suppressed: a.suppressed !== false };
    case "deleteFeature":
      return { type: "deleteFeature", id: str("id") };
    case "setParameter":
      return { type: "setParameter", name: str("name"), value: a.value as number };
    case "setDimension":
      return { type: "setDimension", sketch: str("sketch"), index: a.index as number, value: a.value as number | string };
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

/** After an edit: what the agent needs to check it did what was asked, for one touched feature. */
function localMeasurements(doc: RawDocument, id: string, topo: PartTopology | null): Record<string, unknown> {
  const f = doc.features.find((x) => x.id === id);
  if (!f) return { removed: true };
  const rf = resolveExpressions(f, documentParameters(doc), []) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["distance", "diameter", "depth", "radius", "count", "spacing", "center"]) if (rf[k] !== undefined) out[k] = rf[k];
  if (topo) {
    const walls = topo.faces.filter((x, i) => topo.faceOrigins[i] === id && x.cylinder?.concave);
    if (walls.length) out.measuredDiameters = [...new Set(walls.map((x) => round6(2 * x.cylinder!.radius)))].sort((a, b) => a - b);
  }
  return out;
}

function nextFree(doc: RawDocument, op: string): string {
  const used = new Set(doc.features.map((f) => f.id));
  for (let n = 1; ; n++) if (!used.has(`${op}_${n}`)) return `${op}_${n}`;
}

function touchedIds(base: RawDocument, doc: RawDocument): string[] {
  const before = new Map(base.features.map((f) => [String(f.id), JSON.stringify(f)]));
  const after = new Map(doc.features.map((f) => [String(f.id), JSON.stringify(f)]));
  const ids = new Set([...before.keys(), ...after.keys()]);
  return [...ids].filter((id) => before.get(id) !== after.get(id));
}

/** What a proposal changes, feature by feature, down to the field. */
export function diffDocs(base: RawDocument, doc: RawDocument): Change[] {
  const out: Change[] = [];
  const before = new Map(base.features.map((f) => [String(f.id), f]));
  const after = new Map(doc.features.map((f) => [String(f.id), f]));
  for (const [id, f] of after) {
    const old = before.get(id);
    if (!old) out.push({ id, kind: "added" });
    else if (JSON.stringify(old) !== JSON.stringify(f)) out.push({ id, kind: "changed", fields: leafDiff(old, f, "") });
  }
  for (const id of before.keys()) if (!after.has(id)) out.push({ id, kind: "removed" });
  const pb = JSON.stringify(base.parameters ?? {});
  const pa = JSON.stringify(doc.parameters ?? {});
  if (pb !== pa) out.push({ id: "parameters", kind: "changed", fields: leafDiff(base.parameters ?? {}, doc.parameters ?? {}, "") });
  return out;
}

function leafDiff(a: unknown, b: unknown, path: string, out: { path: string; before: unknown; after: unknown }[] = []) {
  if (out.length >= 24) return out;
  const isVec = (v: unknown) => Array.isArray(v) && v.every((x) => !isObject(x));
  if (isObject(a) && isObject(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) leafDiff(a[k], b[k], path ? `${path}.${k}` : k, out);
    }
  } else if (Array.isArray(a) && Array.isArray(b) && !isVec(a) && !isVec(b)) {
    // Arrays of objects: match by id where there is one (sketch entities), else by position.
    const key = (v: unknown, i: number) => (isObject(v) && typeof v.id === "string" ? v.id : String(i));
    const am = new Map(a.map((v, i) => [key(v, i), v]));
    const bm = new Map(b.map((v, i) => [key(v, i), v]));
    for (const k of new Set([...am.keys(), ...bm.keys()])) {
      if (JSON.stringify(am.get(k)) !== JSON.stringify(bm.get(k))) leafDiff(am.get(k), bm.get(k), `${path}[${k}]`, out);
    }
  } else {
    out.push({ path, before: a, after: b });
  }
  return out;
}

/** Hash of the document as it would be saved. */
export async function hashDoc(doc: RawDocument): Promise<string> {
  const bytes = new TextEncoder().encode(formatDocument(doc));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

/** One image, framed on the target and outlining it (spec 6.1), for visual prompts. */
async function framedShot(doc: RawDocument, target: AskTarget, packet: Packet, kernel: KernelPort): Promise<Uint8Array | undefined> {
  try {
    const camera = { direction: [1, -1, 0.8] as Vec3 };
    if (target.kind === "face") return (await kernel.screenshot(doc, { camera, highlightFaces: [target.index], frame: true, width: 640, height: 480 })).png;
    if (target.kind === "edge") return (await kernel.screenshot(doc, { camera, highlightEdges: [target.index], frame: true, width: 640, height: 480 })).png;
    if (target.kind === "feature" || target.kind === "failed") {
      const topo = await kernel.topology(doc);
      const faces = topo ? topo.faceOrigins.map((o, i) => (o === packet.target.id ? i : -1)).filter((i) => i >= 0) : [];
      return (await kernel.screenshot(doc, { camera, highlightFaces: faces, frame: faces.length > 0, width: 640, height: 480 })).png;
    }
    return (await kernel.screenshot(doc, { camera, width: 640, height: 480 })).png;
  } catch {
    return undefined; // no solid to show: the packet has to do
  }
}

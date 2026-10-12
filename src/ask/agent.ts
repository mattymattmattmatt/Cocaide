// The right-click ask (spec 6): build the packet, let the model answer or
// edit inside the target's write scope, and return a proposal the user
// accepts or discards. Edits run in a sandbox copy of the document, each one
// a checked transaction; the user's document is untouched until accept.

import type Anthropic from "@anthropic-ai/sdk";
import { apply, type Command, type RawDocument } from "../doc/commands";
import { formatDocument } from "../doc/format";
import { documentParameters, resolveExpressions } from "../doc/parameters";
import { rawDrawing } from "../doc/drawing";
import type { Vec3 } from "../doc/types";
import { drawingChecks } from "../drafting/checks";
import { isObject } from "../doc/validate";
import { defOf } from "../features/defs";
import { dot3, normalize3 } from "../geom/vec";
import { edgeSummary, faceSummary, measurementSummary, newFailures, round6 } from "../kernel/inspect";
import type { CheckResult, KernelPort, PartTopology } from "./kernel";
import type { AskModel } from "./model";
import { composeFor } from "./drawingPacket";
import { buildPacket, extrudeMeasurements, isDrawingTarget, partOutline, type AskTarget, type Packet } from "./packet";
import { base64, BATCH_STEP_TOOLS, classify, isVisual, SYSTEM, toolsFor, userTurn, WRITE_TOOL_NAMES, type AskMode } from "./prompt";
import type { Effort } from "./models";
import { commandMade, expandTool, planBatch, toolCommand, type StepResult } from "./tools/batch";
import { featureInfo, facePlane, getSketch, listDatums, listEdges, listFaces, measureBetween, partSummary, shotRequest } from "./tools/inspect";
import { planReply, readPlan, runChecks, type Plan } from "./tools/plan";
import { referenceSection, sectionIndex } from "../mcp/sections";

const DRAWING_COMMANDS = new Set<string>(["setDrawing", "setSheet", "setView", "setAnnotation"]);

/** Tools that only look: calling one after the last edit counts as checking it. */
const LOOK_TOOLS = new Set(["measure", "partSummary", "measureBetween", "screenshot", "listFaces", "listEdges", "getSketch"]);

/**
 * How much room an ask gets. Surgical (one thing, its own scope): a few turns
 * and one correction pass (spec 6.2). Wide (the whole part may change from
 * where the user pointed): more turns and edits. Build (a whole part, from
 * empty space or a description): many turns, edits not counted, longer
 * turns, at least medium effort, and a plan with a self-check at the end.
 */
export interface Budget {
  kind: "surgical" | "wide" | "build";
  /** Model turns per ask. */
  maxTurns: number;
  /** Edit turns allowed after the first kept edit. */
  corrections: number;
  maxTokens: number;
  minEffort?: Effort;
}

export function budgetFor(opts: { target: AskTarget; reach?: AskReach; mode: AskMode; build?: boolean }): Budget {
  if (opts.mode === "edit" && (opts.build ?? opts.target.kind === "part")) return { kind: "build", maxTurns: 40, corrections: 40, maxTokens: 16000, minEffort: "medium" };
  if (opts.reach === "part") return { kind: "wide", maxTurns: 20, corrections: 8, maxTokens: 12000 };
  return { kind: "surgical", maxTurns: 8, corrections: 1, maxTokens: 8000 };
}

export interface AskRequest {
  doc: RawDocument;
  target: AskTarget;
  text: string;
  /** Overrides the question/request reading of the text. */
  mode?: AskMode;
  /**
   * What the ask may change. "target" (the default): the right-clicked thing's
   * write scope (spec 6.2). "part": anything in the part; the target is where
   * the user pointed, and the packet carries the part's outline beside it.
   */
  reach?: AskReach;
  /**
   * A whole-part build (a new part from a description): the build budget, a plan and a self-check. The default
   * is a build for an edit from empty space; false keeps such an ask to one correction pass (the planner's fix-up).
   */
  build?: boolean;
  model: AskModel;
  kernel: KernelPort;
  signal?: AbortSignal;
  onEvent?(e: AskEvent): void;
}

export type AskReach = "target" | "part";

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
  /** What it is, when it isn't a feature: "dimension", "view", "sheet". */
  what?: string;
  /** Leaf changes for a changed feature: "diameter: 6.6 → 8". */
  fields?: { path: string; before: unknown; after: unknown }[];
}

export interface Proposal {
  /** A whole new part (from a description): accepting replaces the document. Only from empty space. */
  replace?: boolean;
  /** The critic's checks of the result against the request. */
  checks?: { label: string; ok: boolean; expected: string; actual: string }[];
  /** Things the user should know: an inch conversion, holes breaking an edge. */
  notes?: string[];
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
  /** questions: a part-level request is missing numbers; nothing is built until the user gives them. */
  outcome: "answer" | "proposal" | "refused" | "failed" | "questions";
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
  const mode = req.mode ?? classify(req.text);
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
  const wide = req.reach === "part" && req.target.kind !== "part";
  const sandbox = await Sandbox.open(req.doc, req.target, packet, mode, req.kernel, wide);
  if (wide) {
    // The whole part may change: the scope says so, and the packet carries the rest of the part.
    packet.writeScope = ["*"];
    packet.part = partOutline(req.doc, sandbox.baseCheck);
  }
  const budget = budgetFor({ target: req.target, reach: req.reach, mode, build: req.build });
  const build = budget.kind === "build";
  const MAX_TURNS = budget.maxTurns;
  const CORRECTIONS = budget.corrections;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userTurn(packet, req.text, mode, image, wide, build) }];
  const whole = wide || req.target.kind === "part";
  const tools = toolsFor(mode, packet.target.kind, whole ? { part: true, drawing: wide && isObject(req.doc.drawing), build } : undefined);
  const texts: string[] = [];
  let corrections = 0;
  let judged = false;
  let reviewed = false;
  /** Whether the agent has looked at the part since its last kept edit. */
  let looked = true;

  try {
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      req.onEvent?.({ type: "thinking", turn });
      const msg = await req.model.next({ system: SYSTEM, messages, tools, maxTokens: budget.maxTokens, ...(budget.minEffort ? { minEffort: budget.minEffort } : {}) }, req.signal);
      result.turns = turn;
      messages.push({ role: "assistant", content: msg.content });
      const said = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text.trim()).filter(Boolean);
      if (said.length) texts.splice(0, texts.length, ...said); // keep the latest words
      if (msg.stop_reason === "refusal") {
        result.text = "The model declined this request.";
        return result;
      }
      const uses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (uses.length === 0) {
        // A drawing ask is judged by the drawing checks: one that passed before and fails now gets the correction pass.
        const findings = judged ? [] : await sandbox.drawingFindings();
        judged = true;
        if (findings.length && turn < MAX_TURNS && corrections < CORRECTIONS) {
          messages.push({
            role: "user",
            content: [{ type: "text", text: `The drawing checks after your change:\n${findings.join("\n")}\nYou get one correction pass: fix it, or stop and say why.` }],
          });
          continue;
        }
        // A whole-part build checks itself once before it ends: the plan's checks on the result, and a look at it.
        if (build && !reviewed && sandbox.commands.length && turn < MAX_TURNS) {
          reviewed = true;
          const review = sandbox.selfCheck(looked);
          if (review) {
            messages.push({ role: "user", content: [{ type: "text", text: review }] });
            continue;
          }
        }
        break;
      }
      if (msg.stop_reason === "max_tokens") {
        result.text = "The model ran out of room mid-call; nothing from that turn was applied.";
        return result;
      }
      // Attempts that were rejected do not count; once an edit is kept, one more edit turn is the correction pass.
      const editsThisTurn = uses.some((u) => WRITE_TOOL_NAMES.has(u.name));
      if (editsThisTurn && sandbox.commands.length > 0) corrections++;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const u of uses) {
        const before = sandbox.revision;
        const out =
          WRITE_TOOL_NAMES.has(u.name) && corrections > CORRECTIONS
            ? { ok: false, error: CORRECTIONS === 1 ? "no more edits in this ask: one correction pass only. Stop and tell the user where it stands." : `no more edits in this ask (${CORRECTIONS} correction turns used). Stop and tell the user where it stands.` }
            : await sandbox.run(u.name, u.input);
        if (sandbox.revision !== before) looked = false;
        else if (out.ok && LOOK_TOOLS.has(u.name)) looked = true;
        const png = out.png instanceof Uint8Array ? out.png : null;
        if (png) delete out.png;
        result.calls.push({ tool: u.name, input: u.input, ok: out.ok, ...(out.error ? { error: out.error } : {}), revision: sandbox.revision, hash: sandbox.hash });
        req.onEvent?.({ type: "tool", name: u.name, ok: out.ok, ...(out.error ? { error: out.error } : {}) });
        // A screenshot comes back as the picture itself, beside what it shows.
        const content: Anthropic.ToolResultBlockParam["content"] = png
          ? [
              { type: "text", text: JSON.stringify(out) },
              { type: "image", source: { type: "base64", media_type: "image/png", data: base64(png) } },
            ]
          : JSON.stringify(out);
        results.push({ type: "tool_result", tool_use_id: u.id, content, ...(out.ok ? {} : { is_error: true }) });
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
  if (p.replace) return { ok: true, doc: structuredClone(p.doc) };
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
  // A new part replaces everything, so any edit since it was made conflicts.
  if (p.replace) return formatDocument(doc) === formatDocument(p.base) ? [] : ["the part"];
  const now = items(doc);
  const then = items(p.base);
  return p.touched.filter((id) => now.get(id) !== then.get(id)).map((id) => id.replace(/^drawing:/, ""));
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
  /** A whole-part build's plan: its checks are run on the result before the ask ends. */
  private plan: Plan | null = null;

  private constructor(
    readonly base: RawDocument,
    readonly baseCheck: CheckResult,
    private readonly target: AskTarget,
    private readonly packet: Packet,
    private readonly mode: AskMode,
    private readonly kernel: KernelPort,
    /** The whole part may change: every feature is in context, and the one-feature rule is off. */
    private readonly wide = false,
  ) {
    this.doc = base;
    this.check = baseCheck;
  }

  static async open(doc: RawDocument, target: AskTarget, packet: Packet, mode: AskMode, kernel: KernelPort, wide = false): Promise<Sandbox> {
    const s = new Sandbox(doc, await kernel.check(doc), target, packet, mode, kernel, wide);
    s.hash = await hashDoc(doc);
    return s;
  }

  get scope(): string[] {
    return [...this.packet.writeScope, ...this.owned];
  }

  /** Ids the packet names: the agent may read these and nothing else. */
  private context(): Set<string> {
    const ids = new Set<string>();
    // The whole part is the target from empty space, or may change from here: all of it is in context.
    if (this.target.kind === "part" || this.wide) for (const f of this.doc.features) ids.add(String(f.id));
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
        const info = featureInfo(this.doc, this.check, id);
        if (!info.ok) return { ok: false, error: `no feature "${id}"` };
        const topo = await this.kernel.topology(this.doc);
        const measured = localMeasurements(this.doc, id, topo);
        return { ...info, ...(Object.keys(measured).length ? { measurements: measured } : {}) };
      }
      case "measure":
        return this.measure(a.selector);
      case "partSummary": {
        // With a plan, its checks on the part as it is now.
        const out = await partSummary(this.doc, this.kernel);
        if (this.plan?.checks.length) out.planChecks = runChecks(this.plan.checks, this.check.measurements);
        return out;
      }
      case "listFaces":
        return listFaces(this.doc, this.kernel, a);
      case "listEdges":
        return listEdges(this.doc, this.kernel, a);
      case "measureBetween":
        return measureBetween(this.doc, this.kernel, a);
      case "getSketch":
        return getSketch(this.doc, this.kernel, a);
      case "facePlane":
        return facePlane(this.doc, this.kernel, a);
      case "listDatums":
        return listDatums(this.doc, this.kernel);
      case "screenshot":
        return this.screenshot(a);
      case "reference": {
        const section = typeof a.section === "string" ? a.section : "";
        const text = section ? referenceSection(section) : null;
        return text ? { ok: true, section, text } : { ok: !section, ...(section ? { error: `no section "${section}"` } : {}), sections: sectionIndex() };
      }
      case "plan": {
        const p = readPlan(a);
        if (typeof p === "string") return { ok: false, error: p };
        this.plan = p;
        return planReply(p, this.check.measurements);
      }
    }
    if (!WRITE_TOOL_NAMES.has(name)) return { ok: false, error: `unknown tool "${name}"` };
    if (this.mode === "explain") return { ok: false, error: "this ask is a question; it cannot change the part" };
    if (name === "batch") return this.batch(a.commands, a.dryRun === true);
    if (name === "sketchProfile" || name === "fullyDefine" || name === "holes") {
      const x = await expandTool(this.doc, this.kernel, name, a);
      if (typeof x === "string") return { ok: false, error: x };
      if (!x.commands.length) return { ok: true, ...x.info, changed: false };
      const out = await this.editMany(x.commands);
      return out.ok ? { ...x.info, ...out } : out;
    }
    const cmd = toolCommand(name, a);
    if (typeof cmd === "string") return { ok: false, error: cmd };
    return this.editMany([cmd]);
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

  private async screenshot(a: Record<string, unknown>): Promise<Outcome> {
    const q = await shotRequest(this.doc, this.kernel, a);
    if (typeof q === "string") return { ok: false, error: q };
    try {
      const shot = await this.kernel.screenshot(this.doc, { camera: q.camera, width: q.width, height: q.height, highlightFaces: q.highlightFaces, highlightEdges: q.highlightEdges, hiddenEdges: q.hiddenEdges, frame: q.frame });
      return { ok: true, view: q.view, width: shot.width, height: shot.height, ...(q.highlightFaces || q.highlightEdges ? { highlighted: (q.highlightFaces ?? q.highlightEdges)!.length } : {}), png: shot.png };
    } catch (e) {
      return { ok: false, error: `screenshot: ${(e as Error).message}` };
    }
  }

  /** The plan's checks on the part now, and whether it has been looked at: what a whole-part build is asked before it ends. */
  selfCheck(looked: boolean): string | null {
    const failing = this.plan ? runChecks(this.plan.checks, this.check.measurements).filter((c) => !c.ok) : [];
    const lines: string[] = [];
    if (failing.length) lines.push(`These checks from your plan fail on the part as it is now:\n${failing.map((c) => `- ${c.label}: expected ${c.expected}, measured ${c.actual ?? "nothing (no solid)"}`).join("\n")}\nFix the features so they pass (or, if the check itself was wrong, say why).`);
    if (this.check.errors.length) lines.push(`The part does not rebuild cleanly: ${this.check.errors.join("; ")}.`);
    // A new part is looked at before it is handed over; an edit's own result already measures what it changed.
    if (!looked && this.base.features.length === 0) lines.push("You have not looked at the result since your last edit: check it with partSummary (and measureBetween for the sizes that matter) and a screenshot, compare it with the request, and fix what disagrees.");
    return lines.length ? `Before you finish, a self-check of the build:\n\n${lines.join("\n\n")}` : null;
  }

  /** Several steps as one transaction: planned on a copy (scope and schema per command), rebuilt once, all kept or none. */
  private async batch(steps: unknown, dryRun: boolean): Promise<Outcome> {
    // The one-feature rule from a face or an edge applies to each feature the batch adds, as it would one by one.
    const saved = { sketch: this.addedSketch, feature: this.addedFeature };
    const planned = await planBatch(this.doc, this.kernel, steps, {
      scope: this.scope,
      allowed: BATCH_STEP_TOOLS,
      check: async (cmd) => {
        if (cmd.type !== "addFeature") return null;
        const problem = await this.addRule(cmd.feature as Record<string, unknown>);
        if (problem) return problem;
        const f = cmd.feature as Record<string, unknown>;
        if (f.op === "sketch") this.addedSketch = String(f.id);
        else this.addedFeature = String(f.id);
        return null;
      },
    });
    const restore = () => {
      this.addedSketch = saved.sketch;
      this.addedFeature = saved.feature;
    };
    if (!planned.ok) {
      restore();
      return { ok: false, error: planned.error, results: planned.results };
    }
    const out = await this.editMany(planned.commands, { dryRun, results: planned.results });
    if (!out.ok || dryRun) restore();
    return out;
  }

  /**
   * The transaction: apply the commands in order (write scope and schema
   * checked), rebuild once, keep them all only if nothing newly fails. With
   * dryRun the result is reported and nothing is kept.
   */
  private async editMany(cmds: Command[], opts: { dryRun?: boolean; results?: StepResult[] } = {}): Promise<Outcome> {
    let doc = this.doc;
    const made: Record<string, unknown>[] = [];
    const addedHere: string[] = [];
    for (const cmd of cmds) {
      if (cmd.type === "addFeature") {
        const f = cmd.feature as Record<string, unknown>;
        if (f.id === undefined) f.id = nextFree(doc, String(f.op));
        // A batch already checked its features against the rule.
        if (!opts.results) {
          const problem = await this.addRule(f);
          if (problem) return { ok: false, error: problem };
        }
      }
      // A feature an earlier command of this edit added is this ask's to change.
      const applied = apply(doc, cmd, { writeScope: [...this.scope, ...addedHere] });
      if (!applied.ok) return { ok: false, error: applied.error };
      made.push(commandMade(doc, applied.doc, cmd));
      if (cmd.type === "addFeature") addedHere.push(String((cmd.feature as Record<string, unknown>).id));
      doc = applied.doc;
    }
    const what = cmds.length === 1 ? cmds[0].type : "batch";
    const next = await this.kernel.check(doc);
    const broke = newFailures(this.check, next);
    if (broke.length) return { ok: false, error: `${what} rolled back: ${broke.join("; ")}`, ...(opts.results ? { results: opts.results } : {}) };
    // On the sheet: an annotation that can't be drawn (a member seen end-on, a hole not seen as a circle) is not kept.
    let drawn: Awaited<ReturnType<Sandbox["drawingNow"]>> = null;
    if (cmds.some((c) => DRAWING_COMMANDS.has(c.type))) {
      const before = await this.drawingNow(this.doc, this.check);
      drawn = await this.drawingNow(doc, next);
      const had = new Set((before?.state.sheet.annotations ?? []).filter((a) => a.problem).map((a) => `${a.id}: ${a.problem}`));
      const fresh = (drawn?.state.sheet.annotations ?? []).filter((a) => a.problem && !had.has(`${a.id}: ${a.problem}`));
      if (fresh.length) return { ok: false, error: `${what} rolled back: ${fresh.map((a) => `${a.id}: ${a.problem}`).join("; ")}` };
    }
    if (opts.dryRun) {
      return {
        ok: true,
        dryRun: true,
        kept: false,
        volume: next.measurements ? round6(next.measurements.volume) : null,
        ...(next.measurements?.boundingBox ? { size: next.measurements.boundingBox.size.map(round6) } : {}),
        ...(next.errors.length ? { errors: next.errors } : {}),
        ...(opts.results ? { results: opts.results } : {}),
        note: "a dry run: it rebuilds as reported, and nothing was kept; run the batch without dryRun to keep it",
      };
    }
    const before = this.doc;
    this.doc = doc;
    this.check = next;
    this.commands.push(...cmds);
    for (const cmd of cmds) {
      if (cmd.type !== "addFeature") continue;
      const f = cmd.feature as Record<string, unknown>;
      this.owned.add(String(f.id));
      if (!opts.results) {
        if (f.op === "sketch") this.addedSketch = String(f.id);
        else this.addedFeature = String(f.id);
      }
    }
    this.revision++;
    this.hash = await hashDoc(this.doc);
    if (drawn) {
      // What the drawing now reads, and what it still lacks.
      const last = cmds[cmds.length - 1];
      const id = "id" in last ? last.id : null;
      const a = id ? drawn.state.sheet.annotations.find((x) => x.id === id) : undefined;
      return { ok: true, ...(a ? { annotation: { id: a.id, type: a.type, reads: a.text } } : {}), checks: drawn.checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.actual}`) };
    }
    const topo = await this.kernel.topology(this.doc);
    const out: Outcome = { ok: true, volume: next.measurements ? round6(next.measurements.volume) : null };
    if (next.errors.length) out.errors = next.errors;
    if (opts.results) out.results = opts.results;
    else if (cmds.length === 1) Object.assign(out, made[0]);
    // What changed in this edit, measured: the features it touched.
    const changed = touchedIds(before, this.doc).filter((t) => !t.startsWith("drawing:"));
    out.features = changed.map((id) => ({ id, ...localMeasurements(this.doc, id, topo) }));
    return out;
  }

  /**
   * From a face or edge the ask adds one feature, and it must use that face
   * or edge (spec 6.2). A sketch on the face, plus the one cut or extrude of
   * it, counts as that feature.
   */
  private async addRule(f: Record<string, unknown>): Promise<string | null> {
    const t = this.target;
    if ((t.kind !== "face" && t.kind !== "edge") || this.wide) return null;
    if (!isObject(f)) return "feature must be an object";
    const rf = resolveExpressions(f, documentParameters(this.doc), []) as Record<string, unknown>;
    const where = t.kind === "face" ? "the face you right-clicked" : "the edge you right-clicked";
    if (f.op === "sketch") {
      if (t.kind !== "face") return "from an edge, the ask adds a fillet or chamfer of that edge";
      if (this.addedSketch) return "from a face, the ask adds one feature (one sketch and the cut or extrude of it)";
      // On the face by reference: { "type": "ref", "ref": { "face": <selector> } }, its selector picking that face.
      if (isObject(rf.plane) && rf.plane.type === "ref") {
        const ref = isObject(rf.plane.ref) ? rf.plane.ref : {};
        const r = ref.face !== undefined ? await this.kernel.select(this.base, ref.face) : null;
        const onIt = !!r && r.ok && r.kind === "faces" && r.indices.length === 1 && r.indices[0] === t.index;
        return onIt && !rf.plane.offset ? null : `the sketch must lie on ${where}: plane { "type": "ref", "ref": { "face": <the packet's face selector> } }, no offset`;
      }
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
      if (!rf.face) return `the hole must name its face (${where}) in "face": use the packet's selection`;
      const r = await this.kernel.select(this.base, rf.face);
      if (!r.ok || r.kind !== "faces" || r.indices.length !== 1 || r.indices[0] !== t.index) {
        return `the hole's face selector must pick ${where}; use the packet's selection`;
      }
      return null;
    }
    if (f.op === "fillet" || f.op === "chamfer") {
      // Its edges (and its radius sets'), and every edge of the faces it names; "the edges a feature made" is too broad here.
      const choices = [rf, ...(Array.isArray(rf.sets) ? (rf.sets as Record<string, unknown>[]) : [])];
      if (choices.some((ch) => ch.features !== undefined)) return `from a ${t.kind}, name the ${String(f.op)}'s edges with "edges"${t.kind === "face" ? ' or "faces"' : ""}, not "features"`;
      const selectors = choices.flatMap((ch) => (ch.edges === undefined ? [] : Array.isArray(ch.edges) ? ch.edges : [ch.edges]));
      const faceSelectors = choices.flatMap((ch) => (Array.isArray(ch.faces) ? ch.faces : []));
      const topo = await this.topology();
      const picked = new Set<number>();
      for (const sel of selectors) {
        const r = await this.kernel.select(this.base, sel);
        if (!r.ok || r.kind !== "edges") return `the ${String(f.op)}'s edges must be ${t.kind === "edge" ? where : `edges of ${where}`}`;
        r.indices.forEach((i) => picked.add(i));
      }
      for (const sel of faceSelectors) {
        const r = await this.kernel.select(this.base, sel);
        if (!r.ok || r.kind !== "faces" || r.indices.some((i) => t.kind !== "face" || i !== t.index)) return t.kind === "face" ? `the ${String(f.op)}'s faces must be ${where} itself; use "edges" for single edges` : `from an edge, name the ${String(f.op)}'s edges with "edges", not "faces"`;
        topo?.edges.forEach((e, i) => r.indices.some((fi) => e.faces.includes(fi)) && picked.add(i));
      }
      const ok = t.kind === "edge" ? picked.has(t.index) : [...picked].every((i) => topo?.edges[i]?.faces.includes(t.index));
      return ok && picked.size > 0 ? null : `the ${String(f.op)}'s edges must be ${t.kind === "edge" ? `${where} (and may include others along it)` : `edges of ${where}`}`;
    }
    // A registry op that can start from a face or an edge says how it must use it.
    const d = defOf(f.op);
    if (d?.askFrom) return d.askFrom(rf, t, { select: (sel) => this.kernel.select(this.base, sel), topology: () => this.topology() });
    return `from a ${t.kind}, the ask adds a hole, fillet, chamfer, or a sketch on the face with its cut or extrude`;
  }

  private async topology(): Promise<PartTopology | null> {
    if (this.baseTopology === undefined) this.baseTopology = await this.kernel.topology(this.base);
    return this.baseTopology;
  }

  /** The drawing as it now stands, for an ask from the sheet. */
  private async drawingNow(doc: RawDocument, check: CheckResult) {
    const state = await composeFor(doc, this.kernel, check);
    return state ? { state, checks: drawingChecks(state.sheet, doc, check.measurements, state.geometry) } : null;
  }

  /** Drawing checks that passed before this ask and fail now, as sentences. None for an ask that isn't on the sheet. */
  async drawingFindings(): Promise<string[]> {
    if (!isDrawingTarget(this.target) || this.commands.length === 0) return [];
    const before = await this.drawingNow(this.base, this.baseCheck);
    const after = await this.drawingNow(this.doc, this.check);
    if (!after) return [];
    const passed = new Set((before?.checks ?? []).filter((c) => c.ok).map((c) => c.label));
    return after.checks.filter((c) => !c.ok && passed.has(c.label)).map((c) => `- ${c.label}: ${c.actual}`);
  }

  async proposal(): Promise<Proposal> {
    const drawn = isDrawingTarget(this.target) ? await this.drawingNow(this.doc, this.check) : null;
    return {
      ...(drawn ? { checks: drawn.checks } : {}),
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


/** After an edit: what the agent needs to check it did what was asked, for one touched feature. */
function localMeasurements(doc: RawDocument, id: string, topo: PartTopology | null): Record<string, unknown> {
  const f = doc.features.find((x) => x.id === id);
  if (!f) return { removed: true };
  const rf = resolveExpressions(f, documentParameters(doc), []) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of new Set(["distance", "diameter", "depth", "radius", "count", "spacing", "center", "angle", "radius2", "distance2", "offset", "startOffset", ...(defOf(f.op)?.measurementKeys ?? [])])) if (rf[k] !== undefined) out[k] = rf[k];
  Object.assign(out, extrudeMeasurements(rf));
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

/** Features, and the drawing's sheet, views and annotations ("drawing:d4"), by what they are now. */
function items(doc: RawDocument): Map<string, string> {
  const out = new Map(doc.features.map((f) => [String(f.id), JSON.stringify(f)]));
  const d = rawDrawing(doc);
  if (d) {
    out.set("drawing:sheet", JSON.stringify(d.sheet));
    for (const x of [...d.views, ...d.annotations]) out.set(`drawing:${String(x.id)}`, JSON.stringify(x));
  }
  return out;
}

function touchedIds(base: RawDocument, doc: RawDocument): string[] {
  const before = items(base);
  const after = items(doc);
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
  // The drawing: its sheet, and each view and annotation.
  const db = rawDrawing(base);
  const da = rawDrawing(doc);
  if (db || da) {
    if (JSON.stringify(db?.sheet) !== JSON.stringify(da?.sheet)) out.push({ id: "sheet", what: "drawing", kind: !db ? "added" : !da ? "removed" : "changed", fields: leafDiff(db?.sheet ?? {}, da?.sheet ?? {}, "") });
    const all = (d: typeof db) => new Map([...(d?.views ?? []).map((v) => [String(v.id), { what: "view", x: v }] as const), ...(d?.annotations ?? []).map((a) => [String(a.id), { what: String(a.type), x: a }] as const)]);
    const vb = all(db);
    const va = all(da);
    for (const [id, { what, x }] of va) {
      const old = vb.get(id);
      if (!old) out.push({ id, what, kind: "added" });
      else if (JSON.stringify(old.x) !== JSON.stringify(x)) out.push({ id, what, kind: "changed", fields: leafDiff(old.x, x, "") });
    }
    for (const [id, { what }] of vb) if (!va.has(id)) out.push({ id, what, kind: "removed" });
  }
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

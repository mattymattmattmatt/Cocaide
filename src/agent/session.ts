// An agent's editing session on one document. Every tool call goes through
// call(): edits run as transactions (apply, rebuild, keep only if nothing new
// broke), each call is logged next to the revision it produced, and the
// document is saved after every committed change.
//
// Node only (files, hashing). The MCP server is a thin layer over this.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { apply, nextId, type Command, type RawDocument } from "../doc/commands";
import { formatDocument } from "../doc/format";
import { createHistory, record, redo, undo, canRedo, canUndo, type History } from "../doc/history";
import { documentParameters, resolveExpressions } from "../doc/parameters";
import { exportRefusal, photoNote } from "../doc/photo";
import type { Constraint, SketchEntity, Vec3 } from "../doc/types";
import { allErrors, isObject, validateDocument } from "../doc/validate";
import { sketchDof } from "../geom/solver";
import { exportSTEP, heapBytes, loadOC, rebuild, RECYCLE_HEAP_BYTES, recycleOC, tessellate, type OC, type RebuildResult } from "../kernel";
import { edgeSummary, faceSummary, measurementSummary, newFailures, round6, selectOn, shotOf, type Picked } from "../kernel/inspect";
import { encodePNG } from "../render/png";
import { VIEWS, type Camera } from "../render/raster";
import { encodeSTL } from "../render/stl";
import { selectorHealth } from "./health";

export interface SessionOptions {
  /** The starting document (parsed JSON). */
  doc: unknown;
  /** Saved here after every committed change. Without it the session is in memory only. */
  docPath?: string;
  /** Command log, JSON Lines, appended to. */
  logPath?: string;
  /** Exports and screenshots go here. Defaults to the document's folder, else the working directory. */
  outDir?: string;
  /** What the agent may change (see doc/scope.ts). Absent: anything. */
  writeScope?: string[];
  /** Named cameras for screenshot, in addition to the built-in views. */
  cameras?: Record<string, Camera>;
  /** Start a fresh kernel when its heap passes this size. */
  recycleBytes?: number;
}

export interface CallResult {
  /** Short JSON for the agent. Always has ok; has error when ok is false. */
  result: { ok: boolean; error?: string } & Record<string, unknown>;
  /** PNG bytes (screenshot only). */
  image?: Uint8Array;
}

/** Tools that can change the document. Replay re-runs these. */
export const EDIT_TOOLS = [
  "addFeature",
  "updateFeature",
  "deleteFeature",
  "reorderFeature",
  "suppressFeature",
  "setParameter",
  "deleteParameter",
  "renameBody",
  "setNode",
  "renameNode",
  "setWeld",
  "setDimension",
  "addEntity",
  "updateEntity",
  "deleteEntity",
  "addConstraint",
  "deleteConstraint",
  "undo",
  "redo",
] as const;
export const READ_TOOLS = ["listFeatures", "getFeature", "validate", "rebuild", "measure", "exportSTEP", "exportSTL", "screenshot"] as const;
export type ToolName = (typeof EDIT_TOOLS)[number] | (typeof READ_TOOLS)[number];

export interface LogSession {
  type: "session";
  at: string;
  writeScope: string[] | null;
  docPath: string | null;
  revision: number;
  hash: string;
  /** The full starting document, so the run can be replayed. */
  document: string;
}

export interface LogCall {
  type: "call";
  seq: number;
  at: string;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  /** Revision and hash after the call. */
  revision: number;
  hash: string;
  changed: boolean;
  ms: number;
  /** Written file, for exports and screenshots. */
  file?: string;
}

export type LogEntry = LogSession | LogCall;

const MAX_IMAGE = 1600;

export class AgentSession {
  doc: RawDocument;
  revision = 0;
  hash: string;
  readonly writeScope: string[] | undefined;
  /** Features this session added. The agent may keep editing what it made. */
  readonly owned = new Set<string>();
  private oc: OC;
  private built: RebuildResult;
  private history: History;
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private readonly outDir: string;
  private readonly cameras: Record<string, Camera>;

  private constructor(
    private readonly opts: SessionOptions,
    oc: OC,
    doc: RawDocument,
  ) {
    this.oc = oc;
    this.doc = doc;
    this.writeScope = opts.writeScope;
    const text = formatDocument(doc);
    this.hash = sha256(text);
    this.history = createHistory(text);
    this.built = rebuild(doc, oc);
    this.outDir = resolve(opts.outDir ?? (opts.docPath ? dirname(opts.docPath) : process.cwd()));
    this.cameras = { ...VIEWS, ...opts.cameras };
    this.log({
      type: "session",
      at: new Date().toISOString(),
      writeScope: opts.writeScope ?? null,
      docPath: opts.docPath ? resolve(opts.docPath) : null,
      revision: 0,
      hash: this.hash,
      document: text,
    });
  }

  static async open(opts: SessionOptions): Promise<AgentSession> {
    if (!isObject(opts.doc) || !Array.isArray(opts.doc.features)) {
      throw new Error("document: not a document (needs a features array)");
    }
    const oc = await loadOC();
    return new AgentSession(opts, oc, structuredClone(opts.doc) as RawDocument);
  }

  /** A new, empty document named after the file. */
  static emptyDocument(path: string): RawDocument {
    const name = basename(path).replace(/\.cocaide\.json$|\.json$/, "") || "untitled";
    return { version: 1, units: "mm", name, features: [] };
  }

  /** Runs one tool. Calls are serialized; each is logged. */
  call(tool: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    const run = this.queue.then(() => this.dispatch(tool, args ?? {}));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Frees the kernel objects this session holds. */
  close(): void {
    this.built.dispose();
  }

  get text(): string {
    return this.history.present;
  }

  private async dispatch(tool: string, args: Record<string, unknown>): Promise<CallResult> {
    const t0 = performance.now();
    const before = this.revision;
    let out: CallResult;
    try {
      out = await this.run(tool, args);
    } catch (e) {
      out = { result: { ok: false, error: `${tool}: ${e instanceof Error ? e.message : String(e)}` } };
    }
    const entry: LogCall = {
      type: "call",
      seq: ++this.seq,
      at: new Date().toISOString(),
      tool,
      args,
      ok: out.result.ok,
      revision: this.revision,
      hash: this.hash,
      changed: this.revision !== before,
      ms: Math.round(performance.now() - t0),
    };
    if (out.result.error) entry.error = out.result.error;
    if (typeof out.result.file === "string") entry.file = out.result.file;
    this.log(entry);
    await this.maybeRecycle();
    return out;
  }

  private async run(tool: string, a: Record<string, unknown>): Promise<CallResult> {
    switch (tool as ToolName) {
      case "addFeature": {
        const feature = isObject(a.feature) ? { ...a.feature } : a.feature;
        if (!isObject(feature)) return this.fail("addFeature: feature must be an object");
        if (feature.id === undefined && typeof feature.op === "string") feature.id = nextId(this.doc, feature.op);
        const done = this.edit({ type: "addFeature", feature, index: a.index as number | undefined });
        if (done.result.ok) {
          this.owned.add(String(feature.id));
          done.result.id = feature.id;
        }
        return done;
      }
      case "updateFeature":
        return this.edit({ type: "updateFeature", id: String(a.id), patch: isObject(a.patch) ? a.patch : {} });
      case "deleteFeature":
        return this.edit({ type: "deleteFeature", id: String(a.id) });
      case "reorderFeature":
        return this.edit({ type: "reorderFeature", id: String(a.id), index: a.index as number });
      case "suppressFeature":
        return this.edit({ type: "suppressFeature", id: String(a.id), suppressed: a.suppressed !== false });
      case "setParameter":
        return this.edit({ type: "setParameter", name: String(a.name), value: a.value as number });
      case "deleteParameter":
        return this.edit({ type: "deleteParameter", name: String(a.name) });
      case "renameBody":
        return this.edit({ type: "renameBody", from: String(a.from), to: String(a.to) });
      case "setNode":
        return this.edit({ type: "setNode", name: String(a.name), at: Array.isArray(a.at) ? (a.at as (number | string)[]) : null });
      case "renameNode":
        return this.edit({ type: "renameNode", from: String(a.from), to: String(a.to) });
      case "setWeld":
        return this.edit({ type: "setWeld", id: String(a.id), weld: isObject(a.weld) ? a.weld : null });
      case "setDimension":
        return this.edit({ type: "setDimension", sketch: String(a.sketch), index: a.index as number, value: a.value as number | string });
      case "addEntity":
        return this.edit({ type: "addEntity", sketch: String(a.sketch), entity: isObject(a.entity) ? a.entity : {} });
      case "updateEntity":
        return this.edit({ type: "updateEntity", sketch: String(a.sketch), id: String(a.id), patch: isObject(a.patch) ? a.patch : {} });
      case "deleteEntity":
        return this.edit({ type: "deleteEntity", sketch: String(a.sketch), id: String(a.id) });
      case "addConstraint":
        return this.edit({ type: "addConstraint", sketch: String(a.sketch), constraint: isObject(a.constraint) ? a.constraint : {} });
      case "deleteConstraint":
        return this.edit({ type: "deleteConstraint", sketch: String(a.sketch), index: a.index as number });
      case "undo":
      case "redo":
        return this.step(tool as "undo" | "redo");
      case "listFeatures":
        return { result: this.listFeatures() };
      case "getFeature":
        return this.getFeature(String(a.id));
      case "validate":
        return this.validate();
      case "rebuild":
        return this.rebuildNow();
      case "measure":
        return this.measure(a.selector);
      case "exportSTEP":
      case "exportSTL":
        return this.exportFile(tool as "exportSTEP" | "exportSTL", a.file);
      case "screenshot":
        return this.screenshot(a);
      default:
        return this.fail(`unknown tool "${tool}" (tools: ${[...EDIT_TOOLS, ...READ_TOOLS].join(", ")})`);
    }
  }

  // ------------------------------------------------------------ editing

  /** The transaction: apply (scope and schema checked), rebuild, commit only if no feature newly fails. */
  private edit(cmd: Command): CallResult {
    const scope = this.writeScope ? [...this.writeScope, ...this.owned] : undefined;
    const applied = apply(this.doc, cmd, { writeScope: scope });
    if (!applied.ok) return this.fail(applied.error);
    const next = rebuild(applied.doc, this.oc);
    const broke = newFailures(this.built, next);
    if (broke.length) {
      next.dispose();
      return this.fail(`${cmd.type} rolled back: ${broke.join("; ")}`);
    }
    const text = formatDocument(applied.doc);
    if (text === this.history.present) {
      next.dispose();
      return { result: { ok: true, changed: false, ...this.status() } };
    }
    this.history = record(this.history, text);
    this.commit(applied.doc, text, next);
    return { result: { ok: true, changed: true, ...this.status() } };
  }

  private step(which: "undo" | "redo"): CallResult {
    if (which === "undo" ? !canUndo(this.history) : !canRedo(this.history)) return this.fail(`${which}: nothing to ${which}`);
    this.history = which === "undo" ? undo(this.history) : redo(this.history);
    const doc = JSON.parse(this.history.present) as RawDocument;
    this.commit(doc, this.history.present, rebuild(doc, this.oc));
    return { result: { ok: true, changed: true, ...this.status() } };
  }

  private commit(doc: RawDocument, text: string, built: RebuildResult) {
    this.built.dispose();
    this.built = built;
    this.doc = doc;
    this.revision++;
    this.hash = sha256(text);
    if (this.opts.docPath) {
      const tmp = `${this.opts.docPath}.tmp-${process.pid}`;
      writeFileSync(tmp, text);
      renameSync(tmp, this.opts.docPath);
    }
  }

  /** Revision and part state, appended to every edit result. */
  private status() {
    const m = this.built.measurements;
    const out: Record<string, unknown> = { revision: this.revision, hash: this.hash.slice(0, 12) };
    if (m) out.volume = round6(m.volume);
    else out.solid = false;
    if (this.built.errors.length) out.errors = this.built.errors;
    return out;
  }

  private fail(error: string): CallResult {
    return { result: { ok: false, error, revision: this.revision, hash: this.hash.slice(0, 12) } };
  }

  // ------------------------------------------------------------ reading

  private listFeatures() {
    const status = new Map(this.built.features.map((f) => [f.id, f]));
    const params = documentParameters(this.doc);
    const features = this.doc.features.map((f) => {
      const id = String(f.id);
      const s = status.get(id);
      const row: Record<string, unknown> = { id, op: f.op, ok: s?.ok ?? false };
      if (s?.suppressed) row.suppressed = true;
      if (s?.error) row.error = s.error;
      if (f.op === "sketch") {
        const entities = Array.isArray(f.entities) ? (f.entities as Record<string, unknown>[]) : [];
        const constraints = Array.isArray(f.constraints) ? f.constraints : [];
        row.plane = f.plane;
        row.entities = entities.map((e) => `${String(e.id)} ${String(e.type)}`).join(", ");
        row.constraints = constraints.length;
        const resolved = resolveExpressions(f, params, []) as { entities?: SketchEntity[]; constraints?: Constraint[] };
        try {
          row.dof = sketchDof(resolved.entities ?? [], resolved.constraints ?? []);
        } catch {
          // a malformed sketch has no DOF; its error says why
        }
      } else {
        const { id: _id, op: _op, suppressed: _s, ...fields } = f;
        row.fields = fields;
      }
      return row;
    });
    const out: Record<string, unknown> = {
      ok: true,
      name: this.doc.name,
      revision: this.revision,
      hash: this.hash.slice(0, 12),
      writeScope: this.writeScope ? [...this.writeScope, ...this.owned] : ["*"],
    };
    if (Object.keys(params).length) out.parameters = params;
    out.features = features;
    const m = this.built.measurements;
    if (m) out.part = { volume: round6(m.volume), size: m.boundingBox?.size.map(round6), holes: m.holeCount };
    if (this.built.errors.length) out.errors = this.built.errors;
    return out as CallResult["result"];
  }

  private getFeature(id: string): CallResult {
    const f = this.doc.features.find((x) => x.id === id);
    if (!f) return this.fail(`getFeature: no feature "${id}" (features: ${this.doc.features.map((x) => String(x.id)).join(", ")})`);
    const s = this.built.features.find((x) => x.id === id);
    const result: CallResult["result"] = { ok: true, feature: f, status: s ? { ok: s.ok, ...(s.error ? { error: s.error } : {}), ...(s.suppressed ? { suppressed: true } : {}) } : null };
    const resolved = resolveExpressions(f, documentParameters(this.doc), []);
    if (JSON.stringify(resolved) !== JSON.stringify(f)) result.resolved = resolved;
    return { result };
  }

  private validate(): CallResult {
    const schema = allErrors(validateDocument(this.doc));
    const health = selectorHealth(this.doc, this.oc);
    const rebuildErrors = this.built.errors.filter((e) => !schema.includes(e));
    const selectors = health.filter((h) => !h.ok || h.note);
    const ok = schema.length === 0 && rebuildErrors.length === 0 && health.every((h) => h.ok);
    return {
      result: {
        ok: true,
        valid: ok,
        revision: this.revision,
        schema,
        rebuild: rebuildErrors,
        selectors: { checked: health.length, healthy: health.filter((h) => h.ok && !h.note).length, issues: selectors },
      },
    };
  }

  private rebuildNow(): CallResult {
    const t0 = performance.now();
    this.built.dispose();
    this.built = rebuild(this.doc, this.oc);
    const failing = this.built.features.filter((f) => !f.ok).map((f) => f.id);
    return {
      result: { ok: true, valid: this.built.ok, ms: Math.round(performance.now() - t0), ...this.status(), ...(failing.length ? { failing } : {}) },
    };
  }

  private measure(selector: unknown): CallResult {
    const solid = this.built.solid;
    if (!solid) return this.fail(`measure: there is no solid yet${this.built.errors.length ? ` (${this.built.errors.join("; ")})` : ""}`);
    if (selector === undefined || selector === null) {
      return { result: { ok: true, revision: this.revision, ...measurementSummary(this.built.measurements!) } };
    }
    const picked = this.select(selector, "measure");
    if (typeof picked === "string") return this.fail(picked);
    const LIMIT = 20;
    if (picked.faces) {
      return {
        result: { ok: true, revision: this.revision, matched: picked.faces.length, faces: picked.faces.slice(0, LIMIT).map(faceSummary) },
      };
    }
    return {
      result: { ok: true, revision: this.revision, matched: picked.edges!.length, edges: picked.edges!.slice(0, LIMIT).map(edgeSummary) },
    };
  }

  /** Runs a face or edge selector on the current solid. */
  private select(selector: unknown, tool: string): Picked | string {
    const solid = this.built.solid;
    if (!solid) return `${tool}: there is no solid yet`;
    return selectOn(this.oc, solid, selector, tool, this.built.bodies);
  }

  private exportFile(tool: "exportSTEP" | "exportSTL", file: unknown): CallResult {
    const refused = exportRefusal(this.doc);
    if (refused) return this.fail(`${tool}: ${refused}`);
    const solid = this.built.solid;
    if (!solid || !this.built.ok) {
      const why = this.built.errors.length ? this.built.errors.join("; ") : "there is no solid yet";
      return this.fail(`${tool}: the part does not rebuild cleanly: ${why}`);
    }
    const ext = tool === "exportSTEP" ? ".step" : ".stl";
    const name = typeof file === "string" && file.trim() ? basename(file.trim()) : `${safeName(this.built.name)}${ext}`;
    const path = join(this.outDir, name.endsWith(ext) ? name : `${name}${ext}`);
    const bytes = tool === "exportSTEP" ? new TextEncoder().encode(exportSTEP(this.oc, solid, this.built.name, photoNote(this.doc), this.built.bodies)) : encodeSTL(tessellate(this.oc, solid), this.built.name);
    mkdirSync(this.outDir, { recursive: true });
    writeFileSync(path, bytes);
    return { result: { ok: true, file: path, bytes: bytes.length, sha256: sha256(bytes).slice(0, 12), revision: this.revision } };
  }

  private async screenshot(a: Record<string, unknown>): Promise<CallResult> {
    const solid = this.built.solid;
    if (!solid) return this.fail(`screenshot: there is no solid yet${this.built.errors.length ? ` (${this.built.errors.join("; ")})` : ""}`);
    let camera: Camera;
    let view: string;
    if (Array.isArray(a.direction)) {
      if (a.direction.length !== 3 || !a.direction.every((x) => typeof x === "number" && Number.isFinite(x)) || a.direction.every((x) => x === 0)) {
        return this.fail("screenshot: direction must be a non-zero [x, y, z]");
      }
      camera = { direction: a.direction as Vec3, up: Array.isArray(a.up) ? (a.up as Vec3) : undefined };
      view = `direction [${a.direction.join(", ")}]`;
    } else {
      view = typeof a.view === "string" ? a.view : "iso";
      if (!(view in this.cameras)) return this.fail(`screenshot: unknown view "${view}" (views: ${Object.keys(this.cameras).join(", ")}; or pass direction)`);
      camera = this.cameras[view];
    }
    const size = (v: unknown, d: number) => (typeof v === "number" && v >= 64 ? Math.min(MAX_IMAGE, Math.round(v)) : d);
    let highlightFaces: number[] | undefined;
    let highlightEdges: number[] | undefined;
    let highlighted: number | undefined;
    if (a.highlight !== undefined) {
      const picked = this.select(a.highlight, "screenshot");
      if (typeof picked === "string") return this.fail(picked);
      highlightFaces = picked.faces?.map((f) => f.index);
      highlightEdges = picked.edges?.map((e) => e.index);
      highlighted = (picked.faces ?? picked.edges)!.length;
    }
    const img = shotOf(this.oc, solid, {
      camera,
      width: size(a.width, 800),
      height: size(a.height, 600),
      highlightFaces,
      highlightEdges,
      hiddenEdges: a.hiddenEdges === true,
    });
    const png = await encodePNG(img);
    const dir = join(this.outDir, "screenshots");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${safeName(this.built.name)}-r${this.revision}-${safeName(view)}.png`);
    writeFileSync(file, png);
    const result: CallResult["result"] = { ok: true, view, revision: this.revision, width: img.width, height: img.height, file };
    if (highlighted !== undefined) result.highlighted = highlighted;
    return { result, image: png };
  }

  // ------------------------------------------------------------ plumbing

  private log(entry: LogEntry) {
    if (!this.opts.logPath) return;
    mkdirSync(dirname(resolve(this.opts.logPath)), { recursive: true });
    appendFileSync(this.opts.logPath, `${JSON.stringify(entry)}\n`);
  }

  /** The WASM heap never shrinks; start a fresh kernel when it gets large. */
  private async maybeRecycle() {
    if (heapBytes(this.oc) < (this.opts.recycleBytes ?? RECYCLE_HEAP_BYTES)) return;
    this.built.dispose();
    this.oc = await recycleOC();
    this.built = rebuild(this.doc, this.oc);
  }
}


export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}


function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "part";
}



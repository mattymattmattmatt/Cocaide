// A feature's property editor, declared: a list of fields, each naming the key
// it edits, how it is shown and when. FeatureForm renders the list; this
// module holds the rules, pure, so Vitest checks them in node: what a field
// shows, the patch a commit sends, which fields show for a feature, the test
// ids, and the defaults a new feature starts with.
//
// Patches are shallow (updateFeature merges top-level keys; null removes one),
// so a field on a nested key ("thin.thickness") sends the whole object it is in.

import type { ReactNode } from "react";
import type { RawDocument } from "../../doc/commands";
import type { DatumPlane, EdgeSelector, FaceSelector, Vec3 } from "../../doc/types";
import type { RebuildView } from "../../worker/protocol";
import type { NumberValue } from "../fields";
import type { Selection } from "../model/selection";
import type { RefForm } from "../../features/datum";
import type { DatumKind, DatumRef } from "./datumRef";

export type Raw = Record<string, unknown>;

/** What a field can read: the feature, the features before it, the bodies, the rebuild and the selection. */
export interface FormContext {
  /** The feature as the document holds it ("=expr" strings): fields show and edit these. */
  f: Raw;
  /** The same feature with expressions evaluated: compute with these. */
  resolved: Raw;
  /** The features before it, expressions evaluated: what it may refer to. */
  before: Raw[];
  /** The bodies there are before it. */
  bodies: string[];
  doc: RawDocument;
  view: RebuildView | null;
  selection: Selection;
}

/** A custom field's props: the form context plus the edit actions. */
export interface FieldProps extends FormContext {
  /** One updateFeature with this (shallow) patch; returns the rejection, if any. */
  update(patch: Raw): string | null | void;
  /** Renames a body everywhere (renameBody). */
  rename(from: string, to: string): unknown;
  /** Shows an error under the form (a "Use selected" that found nothing to use). */
  setError(e: string | null): void;
}

interface Base {
  /** The key it edits: "distance", or a nested one, "thin.thickness". */
  key: string;
  label: string;
  /** data-testid; default prop-<key with dots as dashes>. */
  testId?: string;
  /** A line of help under it. */
  hint?: string;
  /** Shown only when this holds. */
  when?(f: Raw, c: FormContext): boolean;
  /** Read the value another way (default: the value at `key`, else `default`). */
  get?(f: Raw, c: FormContext): unknown;
  /** Build the patch another way (default: the value at `key`; see `omitDefault`). */
  set?(value: unknown, f: Raw, c: FormContext): Raw;
}

export type FieldSpec =
  /** A number or "=expression"; below `min` reverts. */
  | (Base & { kind: "number"; unit?: "mm" | "°"; min?: number; default?: NumberValue; omitDefault?: boolean })
  /** One of a list: [value, label]. */
  | (Base & { kind: "select"; options: [string, string][] | ((f: Raw, c: FormContext) => [string, string][]); default?: string; omitDefault?: boolean })
  /** A checkbox; unticked removes the key (false is every bool's default). */
  | (Base & { kind: "bool"; default?: boolean })
  /** Three numbers (each may be an expression). */
  | (Base & { kind: "vec3"; unit?: "mm"; default?: NumberValue[] })
  /** ±X/±Y/±Z or custom components. */
  | (Base & { kind: "direction"; default?: Vec3 })
  /**
   * A datum plane, inline: a point it passes through and its normal. With
   * `refs`, also a reference to a plane, { type: "ref", ref, offset?, flip? }
   * (DESIGN §2.3): a default plane, a plane feature, or a flat face picked.
   */
  | (Base & { kind: "plane"; default?: DatumPlane; refs?: boolean })
  /** A plane, axis or point: a default one, a reference feature, or picked geometry (DESIGN §2.1). What it takes may depend on the feature (a mode). */
  | (Base & { kind: "datumRef"; accepts: DatumKind[] | ((f: Raw, c: FormContext) => DatumKind[]); optional?: boolean; forms?: RefForm[] })
  /** Several faces, picked in the view ("Use selected faces"). */
  | (Base & { kind: "faces"; optional?: boolean })
  /** One or more edges, picked in the view ("Use selected edges"). */
  | (Base & { kind: "edges" })
  /** One face, picked in the view ("Use selected face"). */
  | (Base & { kind: "face" })
  /** One earlier feature, of these ops if given. */
  | (Base & { kind: "feature"; ops?: string[]; optional?: boolean })
  /** Earlier features, ticked, of these ops if given. */
  | (Base & { kind: "features"; ops?: string[] })
  /** An earlier sketch. */
  | (Base & { kind: "sketch" })
  /** A line of a sketch (the one at `sketchKey`, default "sketch"): an axis to revolve about, say. */
  | (Base & { kind: "sketchLine"; sketchKey?: string })
  /** Bodies before this feature, ticked. `allowEmpty`: none ticked removes the key (`emptyHint` says what that means). */
  | (Base & { kind: "bodies"; allowEmpty?: boolean; emptyHint?: string })
  /** Anything else: a render prop. */
  | (Base & { kind: "custom"; render(p: FieldProps): ReactNode });

export type FieldKind = FieldSpec["kind"];

/** The value at a dotted path, or undefined. */
export function valueAt(f: Raw, key: string): unknown {
  let v: unknown = f;
  for (const k of key.split(".")) {
    if (typeof v !== "object" || v === null) return undefined;
    v = (v as Raw)[k];
  }
  return v;
}

/**
 * The shallow patch that sets `key` to `value` (null or undefined: removes
 * it). A nested key rebuilds the whole top-level object it is in, keeping its
 * other fields; an object left empty is removed.
 */
export function patchAt(f: Raw, key: string, value: unknown): Raw {
  const path = key.split(".");
  const top = path[0];
  if (path.length === 1) return { [top]: value === undefined ? null : value };
  const put = (obj: unknown, rest: string[]): Raw | null => {
    const copy: Raw = typeof obj === "object" && obj !== null && !Array.isArray(obj) ? { ...(obj as Raw) } : {};
    const [k, ...more] = rest;
    const v = more.length ? put(copy[k], more) : value;
    if (v === null || v === undefined) delete copy[k];
    else copy[k] = v;
    return Object.keys(copy).length ? copy : null;
  };
  return { [top]: put(f[top], path.slice(1)) };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What a field shows: its own reading, else the value at its key, else its default. */
export function fieldValue(spec: FieldSpec, f: Raw, c: FormContext): unknown {
  if (spec.get) return spec.get(f, c);
  const v = valueAt(f, spec.key);
  return v === undefined && "default" in spec ? spec.default : v;
}

/**
 * The patch a field sends when it commits `value`. A bool's false, and a
 * value equal to the default of a field that omits its default, remove the key.
 */
export function commitPatch(spec: FieldSpec, value: unknown, f: Raw, c: FormContext): Raw {
  if (spec.set) return spec.set(value, f, c);
  if (spec.kind === "bool" && value === false) return patchAt(f, spec.key, null);
  if ((spec.kind === "number" || spec.kind === "select") && spec.omitDefault && same(value, spec.default)) return patchAt(f, spec.key, null);
  return patchAt(f, spec.key, value);
}

/** The fields shown for this feature now. */
export function visibleFields(specs: FieldSpec[], f: Raw, c: FormContext): FieldSpec[] {
  return specs.filter((s) => !s.when || s.when(f, c));
}

/** A field's data-testid: its own, else prop-<key> with dots as dashes. */
export function fieldTestId(spec: FieldSpec): string {
  return spec.testId ?? `prop-${spec.key.replace(/\./g, "-")}`;
}

/** The kinds a datumRef field takes for this feature. */
export function acceptsOf(spec: Extract<FieldSpec, { kind: "datumRef" }>, f: Raw, c: FormContext): DatumKind[] {
  return typeof spec.accepts === "function" ? spec.accepts(f, c) : spec.accepts;
}

/** A select's choices for this feature. */
export function selectOptions(spec: Extract<FieldSpec, { kind: "select" }>, f: Raw, c: FormContext): [string, string][] {
  return typeof spec.options === "function" ? spec.options(f, c) : spec.options;
}

/**
 * The fields a new feature starts with: every default, except those a field
 * leaves out of the document when they hold (`omitDefault`, a bool's false).
 * A tool spreads this into the feature it creates.
 */
export function defaultsOf(specs: FieldSpec[]): Raw {
  let out: Raw = {};
  for (const s of specs) {
    if (!("default" in s) || s.default === undefined) continue;
    if (s.kind === "bool" && !s.default) continue;
    if ((s.kind === "number" || s.kind === "select") && s.omitDefault) continue;
    out = { ...out, ...patchAt(out, s.key, s.default) };
  }
  return out;
}

/** Earlier features a feature field may choose: [id, label], of these ops if given. */
export function featureChoices(before: Raw[], ops?: string[]): [string, string][] {
  return before.filter((g) => !ops || ops.includes(String(g.op))).map((g) => [String(g.id), String(g.id)]);
}

/** The lines of a sketch (construction ones marked), for an axis to turn about or a direction. */
export function sketchLineChoices(before: Raw[], sketchId: unknown): [string, string][] {
  const sk = before.find((g) => g.id === sketchId && g.op === "sketch");
  const entities = (Array.isArray(sk?.entities) ? sk.entities : []) as { id: string; type: string; construction?: boolean }[];
  return entities.filter((e) => e.type === "line").map((e) => [e.id, e.construction ? `${e.id} (construction)` : e.id]);
}

/**
 * A list after ticking or unticking `item`, in `order`'s order. With
 * `allowEmpty` false, unticking the last one is refused (null: no change).
 */
export function toggled(list: string[], item: string, on: boolean, order: string[], allowEmpty: boolean): string[] | null {
  const next = on ? [...new Set([...list, item])] : list.filter((x) => x !== item);
  if (!next.length && !allowEmpty) return null;
  return order.filter((x) => next.includes(x)).concat(next.filter((x) => !order.includes(x)));
}

/** A face or edge list as the document holds it: one selector, or several. */
export function asList<T extends FaceSelector | EdgeSelector>(v: unknown): T[] {
  return v === undefined || v === null ? [] : Array.isArray(v) ? (v as T[]) : [v as T];
}

export type { DatumRef };

// The property editors of the plane, axis and point features: a mode, then
// the references that mode takes, each a datumRef field whose choices depend
// on the mode (a plane here, an axis there). Switching the mode keeps each
// reference that still fits and fills the rest with a default that builds
// (Top, the X axis, the origin), so the feature never sits broken while the
// user is still choosing. Pure: Vitest covers it in node.

import type { DatumRef } from "../../doc/types";
import { DATUM_OPS, DEFAULT_DATUMS, refForm, type Datum, type DatumKind, type ModeSpec, type RefSlot } from "../../features/datum";
import { formatDirection } from "../../geom/vec";
import { fmt } from "../model/selection";
import type { FieldSpec } from "./spec";

type Raw = Record<string, unknown>;

/** The feature's refs, as a list. */
export function refsOf(f: Raw): DatumRef[] {
  return Array.isArray(f.refs) ? (f.refs as DatumRef[]) : [];
}

/** What a reference may be, as far as the features before it say. */
export function kindsOfRef(ref: DatumRef, before: Raw[]): DatumKind[] {
  if ("datum" in ref) {
    const d = Object.hasOwn(DEFAULT_DATUMS, ref.datum) ? DEFAULT_DATUMS[ref.datum] : undefined;
    if (d) return [d.kind];
    const op = String(before.find((g) => g.id === ref.datum)?.op);
    return Object.hasOwn(DATUM_OPS, op) ? [DATUM_OPS[op]] : [];
  }
  if ("face" in ref) return ["plane", "axis"];
  if ("edge" in ref) return ref.at ? ["point"] : ["axis", "point"];
  return ["point"];
}

/** Does the reference fit the slot (its form, and a kind it takes)? */
export function fits(ref: DatumRef, slot: RefSlot, before: Raw[]): boolean {
  if (slot.forms && !slot.forms.includes(refForm(ref))) return false;
  if (slot.wholeEdge && "edge" in ref && ref.at) return false;
  return !slot.kinds || kindsOfRef(ref, before).some((k) => slot.kinds!.includes(k));
}

/** A reference that builds for a slot when nothing chosen fits: Top for a plane, X for an axis, the origin for a point. */
function defaultFor(slot: RefSlot): DatumRef | null {
  if (slot.forms && !slot.forms.includes("datum")) return null;
  const kind = slot.kinds?.[0] ?? "point";
  return { datum: kind === "plane" ? "Top" : kind === "axis" ? "X" : "Origin" };
}

/**
 * The patch that switches a reference feature to `mode`: its references
 * re-dealt to the new mode's slots (each one that fits, in order; a default
 * for the rest, or the slot is left for the user to pick when no default can
 * stand in, as a cylinder's face), the fields only other modes use removed
 * and the new mode's `defaults` added where missing.
 */
export function switchMode(f: Raw, mode: string, modes: Readonly<Record<string, ModeSpec>>, before: Raw[], defaults: Raw = {}): Raw {
  const spec = modes[mode];
  const pool = [...refsOf(f)];
  const min = spec.refs.length - (spec.optional ?? 0);
  const refs: DatumRef[] = [];
  spec.refs.forEach((slot, i) => {
    const k = pool.findIndex((r) => fits(r, slot, before));
    if (k >= 0) refs.push(pool.splice(k, 1)[0]);
    else if (i < min) {
      const d = defaultFor(slot);
      if (d) refs.push(d);
    }
  });
  const patch: Raw = { mode, refs: spec.refs.length ? refs : null };
  for (const field of new Set(Object.values(modes).flatMap((m) => m.fields))) {
    if (!spec.fields.includes(field)) patch[field] = null;
    else if (f[field] === undefined && defaults[field] !== undefined) patch[field] = defaults[field];
  }
  return patch;
}

/** The refs with the one at `i` replaced (null: removed, with any after it). */
export function withRef(f: Raw, i: number, ref: DatumRef | null): DatumRef[] {
  const refs = [...refsOf(f)];
  if (ref === null) return refs.slice(0, i);
  refs[i] = ref;
  return refs;
}

/**
 * One datumRef field per slot of each mode, shown while the feature is in
 * that mode, labelled for it ("Plane", "Axis", "Point 2"), taking what the
 * slot takes. `labels[mode][i]` names slot i.
 */
export function refFields(modes: Readonly<Record<string, ModeSpec>>, labels: Readonly<Record<string, string[]>>, modeOf: (f: Raw) => string): FieldSpec[] {
  return Object.entries(modes).flatMap(([mode, spec]) =>
    spec.refs.map((slot, i): FieldSpec => ({
      kind: "datumRef",
      key: `refs.${i}`,
      label: labels[mode]?.[i] ?? `Reference ${i + 1}`,
      testId: `prop-refs-${i}`,
      accepts: slot.kinds ?? ["plane", "axis", "point"],
      ...(slot.forms ? { forms: slot.forms } : {}),
      optional: i >= spec.refs.length - (spec.optional ?? 0),
      hint: slot.what[0].toUpperCase() + slot.what.slice(1),
      when: (f) => modeOf(f) === mode,
      get: (f) => refsOf(f)[i],
      set: (v, f) => ({ refs: withRef(f, i, (v as DatumRef | null) ?? null) }),
    })),
  );
}

/** Where a built reference is, in a line: "origin 0, 0, 10 · normal +Z". */
export function datumText(d: Datum | undefined): string {
  if (!d) return "not built: see the error above";
  const at = (v: readonly number[]) => v.map(fmt).join(", ");
  if (d.kind === "plane") return `through ${at(d.origin)} · normal ${formatDirection(d.normal)}`;
  if (d.kind === "axis") return `through ${at(d.origin)} · along ${formatDirection(d.direction)}`;
  return `at ${at(d.at)}`;
}

// What's wrong (Phase P): every error and warning of the rebuild in one list,
// each with what it refers to and the fixes that can be made in one click.
// Pure: the document and the rebuild's view in, the list out.
//
// - An error: the feature failed. When it failed on a face or edge it picks
//   (a selector that matches nothing now), that selector is named, its
//   last-known place (its hint, or its "near" point) is where the view shows a
//   ghost, and Re-pick opens the feature with that field active.
// - A warning: a reference that moved and was found again (Accept writes the
//   selector for where it is now; Re-pick picks another).
// - Fragile: a reference by position only (an offset, a nearest point, a
//   length) with no hint: it breaks when things move. Make robust writes it
//   again from the face it means now, with its maker and a hint.
// Every feature problem can also be Suppressed, Rolled back to, Edited or Deleted.

import type { RawDocument } from "../../doc/commands";
import { fragileSelectors, selectorsIn, type SelectorAt } from "../../doc/heal";
import type { Vec3 } from "../../doc/types";
import type { HealNote } from "../../kernel/rebuild";
import type { RebuildView } from "../../worker/protocol";

export type Severity = "error" | "warning" | "fragile";

export type FixKind = "repick" | "accept" | "robust" | "edit" | "suppress" | "rollback" | "delete";

export interface Problem {
  /** Stable across rebuilds while it is the same problem: what the list keys on. */
  key: string;
  /** The feature it is about (none: a problem of the document as a whole). */
  feature?: string;
  op?: string;
  severity: Severity;
  /** What is wrong, without the feature's id in front. */
  message: string;
  /** The reference it is about, in the feature ("edges", "upTo.face"), when known. */
  ref?: SelectorAt;
  /** Where that reference was last seen: the view shows a ghost there. */
  ghost?: Vec3;
  /** The re-found reference, for Accept. */
  heal?: HealNote;
  fixes: FixKind[];
}

const FEATURE_FIXES: FixKind[] = ["edit", "suppress", "rollback", "delete"];

/** Where a selector was last seen: its hint, else its nearest point. */
export function lastSeen(sel: Record<string, unknown>): Vec3 | undefined {
  const hint = sel.hint as { centroid?: Vec3 } | undefined;
  if (hint?.centroid) return hint.centroid;
  if (Array.isArray(sel.near)) return sel.near as Vec3;
  const nested = (sel.onFace ?? (Array.isArray(sel.between) ? sel.between[0] : undefined)) as Record<string, unknown> | undefined;
  return nested ? lastSeen(nested) : undefined;
}

/**
 * Which of a failed feature's selectors its error is about: the one whose
 * path starts the message ("edges[1]: selector matched 0 edges"), else the
 * one whose field the message names, else the only one it has.
 */
export function brokenSelector(f: Record<string, unknown>, message: string): SelectorAt | undefined {
  const list = selectorsIn(f);
  if (!list.length) return undefined;
  const byPath = [...list].sort((a, b) => b.path.length - a.path.length).find((s) => message.startsWith(`${s.path}:`) || message.startsWith(`${s.path}.`) || message.includes(` ${s.path}:`));
  if (byPath) return byPath;
  const byKey = list.find((s) => message.startsWith(`${s.key}`));
  if (byKey) return byKey;
  const aboutPicks = /selector matched|picked on|re-pick it|matched 0|no face|no edge/.test(message);
  return aboutPicks && list.length === 1 ? list[0] : aboutPicks ? list.find((s) => s.selector.hint) : undefined;
}

/** Every problem of the part: errors first, then warnings, then fragile references, each in history order. */
export function diagnose(doc: RawDocument | null, view: RebuildView | null): Problem[] {
  if (!doc || !view) return [];
  const raw = new Map(doc.features.map((f) => [String(f.id), f]));
  const errors: Problem[] = [];
  const warnings: Problem[] = [];
  const fragile: Problem[] = [];
  for (const s of view.features) {
    const f = raw.get(s.id);
    if (!f || s.suppressed) continue;
    if (!s.ok) {
      const lines = (s.error ?? `${s.id}: failed`).split("\n").map((l) => l.replace(`${s.id}: `, ""));
      lines.forEach((message, i) => {
        const ref = brokenSelector(f, message);
        errors.push({
          key: `error:${s.id}:${i}`,
          feature: s.id,
          op: s.op,
          severity: "error",
          message,
          ...(ref ? { ref, ghost: lastSeen(ref.selector) } : {}),
          fixes: [...(ref ? (["repick"] as FixKind[]) : []), ...FEATURE_FIXES],
        });
      });
      continue;
    }
    for (const [i, h] of (s.heals ?? []).entries()) {
      const ref = selectorsIn(f).find((r) => r.selector.hint && JSON.stringify(r.selector.hint) === JSON.stringify(h.selector.hint)) ?? brokenSelector(f, "picked on");
      warnings.push({
        key: `heal:${s.id}:${i}`,
        feature: s.id,
        op: s.op,
        severity: "warning",
        message: h.message.replace(`${s.id}: `, ""),
        ...(ref ? { ref } : {}),
        ghost: h.was,
        heal: h,
        fixes: [...(h.healed ? (["accept"] as FixKind[]) : []), ...(ref ? (["repick"] as FixKind[]) : []), "edit"],
      });
    }
    // Any other warnings the rebuild gives (not a re-found reference).
    for (const [i, w] of (s.warnings ?? []).entries()) {
      if (s.heals?.some((h) => h.message === w)) continue;
      warnings.push({ key: `warn:${s.id}:${i}`, feature: s.id, op: s.op, severity: "warning", message: w.replace(`${s.id}: `, ""), fixes: FEATURE_FIXES });
    }
    for (const ref of fragileSelectors(f)) {
      fragile.push({
        key: `fragile:${s.id}:${ref.path}`,
        feature: s.id,
        op: s.op,
        severity: "fragile",
        message: `${ref.path} ${ref.reason}`,
        ref,
        ghost: lastSeen(ref.selector),
        fixes: ["robust", "edit"],
      });
    }
  }
  const header = view.errors.filter((e) => e.startsWith("document:") && !e.startsWith("document: no solid"));
  const doc_ = header.map((message, i): Problem => ({ key: `document:${i}`, severity: "error", message: message.replace(/^document: /, ""), fixes: [] }));
  return [...doc_, ...errors, ...warnings, ...fragile];
}

/** The counts for the top bar's badge. */
export function problemCounts(list: readonly Problem[]): { errors: number; warnings: number; fragile: number } {
  return {
    errors: list.filter((p) => p.severity === "error").length,
    warnings: list.filter((p) => p.severity === "warning").length,
    fragile: list.filter((p) => p.severity === "fragile").length,
  };
}

/** Each fix's button label and what it does, for the panel and its tooltips. */
export const FIX_TEXT: Record<FixKind, { label: string; title: string }> = {
  repick: { label: "Re-pick", title: "Open the feature with this reference's field active: click the face or edge it should be (the red ring shows where it was)" },
  accept: { label: "Accept", title: "Keep the face or edge it found: the reference is written for where it is now" },
  robust: { label: "Make robust", title: "Write this reference again from the face or edge it means now, by the feature that made it and where it is, so it survives edits upstream" },
  edit: { label: "Edit", title: "Open the feature with OK and Cancel" },
  suppress: { label: "Suppress", title: "Leave the feature out of the rebuild for now (it stays in the history)" },
  rollback: { label: "Roll back to here", title: "Move the rollback bar just above this feature: the part as it was before it" },
  delete: { label: "Delete", title: "Delete the feature (Ctrl+Z brings it back)" },
};

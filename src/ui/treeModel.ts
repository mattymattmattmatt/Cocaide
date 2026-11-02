// The feature tree's rules (Phase P), pure so they are tested on their own:
// the rows it shows (folders, their features, collapsed or filtered), the
// filter ("hole", "error", "type:fillet", "suppressed"), a feature's key
// values for its tooltip, and where a dragged feature would land.

import type { FeatureStatus } from "../kernel/rebuild";
import { folderOf, type Folder } from "../doc/tree";

type Raw = Record<string, unknown>;

export type FeatureState = "ok" | "error" | "warning" | "suppressed" | "rolled";

/** A feature's state in the tree: rolled back, suppressed, failed, built with a warning, or fine. */
export function featureState(f: Raw, status: FeatureStatus | undefined, rolled: boolean): FeatureState {
  if (rolled) return "rolled";
  if (f.suppressed === true) return "suppressed";
  if (status && !status.ok) return "error";
  if (status?.warnings?.length) return "warning";
  return "ok";
}

/** The words a status filter takes. */
export const STATE_WORDS: Record<string, FeatureState> = {
  error: "error",
  errors: "error",
  failed: "error",
  warning: "warning",
  warnings: "warning",
  suppressed: "suppressed",
  rolled: "rolled",
  "rolled back": "rolled",
};

/**
 * Does the feature match the filter text? Words are all needed: each matches
 * the id, the kind ("Fillet", "fillet"), the note, or a state ("error",
 * "warning", "suppressed", "rolled"); "type:hole" matches the kind only.
 */
export function matchesFilter(f: Raw, label: string, state: FeatureState, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [String(f.id), String(f.op), label, typeof f.note === "string" ? f.note : ""].map((s) => s.toLowerCase());
  const known = Object.keys(STATE_WORDS);
  return q.split(/\s+/).every((w) => {
    if (w.startsWith("type:")) {
      const t = w.slice(5);
      return String(f.op).toLowerCase().startsWith(t) || label.toLowerCase().startsWith(t);
    }
    if (known.includes(w)) return STATE_WORDS[w] === state;
    return hay.some((h) => h.includes(w));
  });
}

/** A row of the tree: a folder's head, or a feature (with the folder it is in, when it is). */
export type TreeRow = { kind: "folder"; folder: Folder; count: number; collapsed: boolean } | { kind: "feature"; index: number; folder?: Folder };

/**
 * The rows to show: each folder's head just above its first feature, its
 * features under it unless it is collapsed; with a filter, only matching
 * features (in a matching folder's place, whatever its collapse).
 */
export function treeRows(features: Raw[], folders: readonly Folder[], collapsed: ReadonlySet<string>, matches?: (i: number) => boolean): TreeRow[] {
  const rows: TreeRow[] = [];
  const headed = new Set<string>();
  features.forEach((f, i) => {
    const folder = folderOf(folders, String(f.id));
    if (folder && !headed.has(folder.id)) {
      headed.add(folder.id);
      const shown = matches ? folder.features.filter((x) => matches(features.findIndex((g) => g.id === x))).length : folder.features.length;
      if (!matches || shown > 0) rows.push({ kind: "folder", folder, count: folder.features.length, collapsed: !matches && collapsed.has(folder.id) });
    }
    if (matches && !matches(i)) return;
    if (folder && !matches && collapsed.has(folder.id)) return;
    rows.push({ kind: "feature", index: i, ...(folder ? { folder } : {}) });
  });
  return rows;
}

/** The fields worth showing about a feature, by op: the numbers a user tunes. */
const KEY_FIELDS: [string, string, string?][] = [
  ["distance", "Depth", "mm"],
  ["distance2", "Distance 2", "mm"],
  ["extent", "End"],
  ["diameter", "Diameter", "mm"],
  ["size", "Size"],
  ["depth", "Depth", "mm"],
  ["radius", "Radius", "mm"],
  ["radius2", "Radius 2", "mm"],
  ["thickness", "Thickness", "mm"],
  ["angle", "Angle", "°"],
  ["count", "Count"],
  ["spacing", "Spacing", "mm"],
  ["count2", "Count 2"],
  ["spacing2", "Spacing 2", "mm"],
  ["factor", "Factor"],
  ["offset", "Offset", "mm"],
  ["twist", "Twist", "°"],
  ["pitch", "Pitch", "mm"],
];

/**
 * A feature's key values for its tooltip: "Depth 6 mm", "Radius =r (2 mm)".
 * `resolved` is the feature with its expressions worked out (when known).
 */
export function keyValues(f: Raw, resolved?: Raw): string[] {
  const out: string[] = [];
  for (const [k, label, unit] of KEY_FIELDS) {
    const v = f[k];
    if (v === undefined || typeof v === "object") continue;
    const now = resolved?.[k];
    const shown = typeof v === "string" && v.startsWith("=") ? `${v}${typeof now === "number" ? ` (${round(now)}${unit ? ` ${unit}` : ""})` : ""}` : `${typeof v === "number" ? round(v) : v}${unit && typeof v === "number" ? ` ${unit}` : ""}`;
    out.push(`${label} ${shown}`);
  }
  if (f.op === "sketch" && Array.isArray(f.entities)) {
    const dims = Array.isArray(f.constraints) ? f.constraints.filter((c) => typeof (c as Raw).value === "number" || typeof (c as Raw).value === "string").length : 0;
    out.push(`${f.entities.length} entit${f.entities.length === 1 ? "y" : "ies"}, ${dims} dimension${dims === 1 ? "" : "s"}`);
  }
  if ((f.op === "extrude" || f.op === "cut") && typeof f.sketch === "string") out.push(`Sketch ${f.sketch}`);
  return out;
}

function round(x: number): string {
  return String(Math.round(x * 1e4) / 1e4);
}

/**
 * Where a feature dragged from index `from` lands when dropped on the row of
 * the feature at `at` (`after`: on its lower half): its new index, as
 * reorderFeature takes it.
 */
export function dropIndex(from: number, at: number, after: boolean): number {
  const slot = after ? at + 1 : at;
  return from < slot ? slot - 1 : slot;
}

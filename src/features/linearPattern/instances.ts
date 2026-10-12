// The editor rules a pattern's instances and seeds share (linear, circular
// and sketch-driven patterns, and mirror's seeds), pure: the instance list
// with their numbers and labels, the patch that skips or keeps one, and the
// patch for the features a pattern repeats. Patches are shallow
// (updateFeature merges top-level keys; null removes one).

type Raw = Record<string, unknown>;

/** One instance a pattern can make: its number (1 is the original) and how the editor names it. */
export interface InstanceRow {
  n: number;
  label: string;
  /** Left out by `skip`. */
  skipped: boolean;
  /** A grid's row (along the second direction, from 0): the editor sets each row on a line of its own. */
  row?: number;
}

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/**
 * The instances of a linear or circular pattern, the original first. A
 * linear grid numbers them row by row (1 + i + j * count) and labels them
 * with their place, "[2, 3]" (along direction 1, along direction 2); a
 * circular one with its angle.
 */
export function patternRows(f: Raw): InstanceRow[] {
  const skip = Array.isArray(f.skip) ? (f.skip as unknown[]) : [];
  const count = Math.max(1, Math.floor(num(f.count, 1)));
  const rows: InstanceRow[] = [];
  if (f.op === "circularPattern") {
    const total = num(f.angle, 360);
    const step = total >= 360 ? total / count : count > 1 ? total / (count - 1) : 0;
    for (let k = 0; k < count; k++) rows.push({ n: k + 1, label: `${k + 1} (${round(k * step)}°)`, skipped: skip.includes(k + 1) });
    return rows;
  }
  const two = f.count2 !== undefined && (f.direction2 !== undefined || f.along2 !== undefined);
  const count2 = two ? Math.max(1, Math.floor(num(f.count2, 1))) : 1;
  for (let j = 0; j < count2; j++) {
    for (let i = 0; i < count; i++) {
      const n = 1 + i + j * count;
      rows.push({ n, label: two ? `${n} [${i + 1}, ${j + 1}]` : String(n), skipped: skip.includes(n), ...(two ? { row: j } : {}) });
    }
  }
  return rows;
}

/** A sketch-driven pattern's instances: 1 the seed, then 2, 3 ... the other places (labelled with where they are). */
export function placeRows(places: [number, number][], skip: unknown): InstanceRow[] {
  const list = Array.isArray(skip) ? skip : [];
  return [{ n: 1, label: "1 (the seed)", skipped: false }, ...places.map((p, i) => ({ n: i + 2, label: `${i + 2} at [${round(p[0])}, ${round(p[1])}]`, skipped: list.includes(i + 2) }))];
}

/**
 * The patch that makes instance `n` (on) or leaves it out (off). The
 * original can't be left out, nor every copy: those return a message to show.
 */
export function skipPatch(f: Raw, rows: InstanceRow[], n: number, on: boolean): Raw | string {
  if (n === 1) return "Instance 1 is the original feature: it is always there.";
  const skip = new Set(Array.isArray(f.skip) ? (f.skip as number[]) : []);
  if (on) skip.delete(n);
  else skip.add(n);
  const copies = rows.filter((r) => r.n !== 1).length;
  if (!on && skip.size >= copies) return "A pattern must make at least one copy: keep another instance first.";
  const list = [...skip].filter((k) => rows.some((r) => r.n === k)).sort((a, b) => a - b);
  return { skip: list.length ? list : null };
}

/**
 * A count's patch: the new count, with the skipped instances that no longer
 * exist (or that now leave no copy) dropped, so the pattern stays valid.
 */
export function countPatch(f: Raw, key: "count" | "count2", value: unknown): Raw {
  const patch: Raw = { [key]: value };
  if (typeof value !== "number" || !Array.isArray(f.skip)) return patch;
  const next = { ...f, [key]: value };
  const total = patternRows(next).length;
  const skip = (f.skip as number[]).filter((n) => n <= total);
  patch.skip = skip.length && skip.length < total - 1 ? skip : null;
  return patch;
}

/** The features a pattern or mirror repeats, as the document holds them: `features`, or its one `feature`. */
export function seedsOf(f: Raw): string[] {
  if (Array.isArray(f.features)) return f.features.filter((x): x is string => typeof x === "string");
  return typeof f.feature === "string" ? [f.feature] : [];
}

/** The patch for the features to repeat: one is `feature`, several are `features`; none is refused (a message). */
export function seedsPatch(list: unknown): Raw | string {
  const ids = Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) return "Tick at least one feature to repeat.";
  return ids.length === 1 ? { feature: ids[0], features: null } : { features: ids, feature: null };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

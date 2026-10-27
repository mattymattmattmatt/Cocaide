// Selectors are queries, re-run after every rebuild. A selector that does not
// resolve to what the operation needs is an error, never a guess, with one
// exception (Phase P, self-healing references): a selector made from a pick
// carries a hint, where its face or edge was then. When such a selector stops
// matching exactly one face or edge after an upstream edit, the candidates
// (made by the same feature, when it says which) are ranked by how near they
// are to the hint in place, direction and size; if exactly one is a clear
// match it is used and the rebuild warns ("an edge moved - re-found it");
// otherwise it fails and lists the candidates.

import type { EdgeSelector, FaceSelector, SelectorHint } from "../doc/types";

import type { Vec3 } from "../doc/types";
import { dist3, dot3, formatDirection, normalize3 } from "../geom/vec";
import type { EdgeInfo, FaceInfo } from "./topology";

const ANGLE_TOL = 1e-9;
const LENGTH_TOL = 1e-6;
const AREA_REL_TOL = 1e-9;

export interface Selection {
  matches: FaceInfo[];
  /** Set when `pick` (or `near`) could not choose because several faces tie. */
  tie?: "largest" | "smallest" | "nearest";
  /** The selector stopped matching and was re-found from its hint: matches holds the one found. */
  healed?: Healing;
  /** The selector stopped matching and its hint could not settle on one: the likeliest candidates. */
  unhealed?: Candidate[];
}

/** A face or edge a broken selector might mean, with how far it is from the hint (0: just where it was). */
export interface Candidate {
  index: number;
  score: number;
  centroid: Vec3;
  createdBy?: string;
}

/** How a selector was re-found. */
export interface Healing {
  kind: "face" | "edge";
  /** What the selector matched by itself: 0, or several. */
  matched: number;
  found: Candidate;
  /** The runner-up, when there was one. */
  next?: Candidate;
}

/** What a listener hears about a selector re-found from its hint. */
export type HealEvent =
  | { kind: "face"; selector: FaceSelector; index: number; faces: FaceInfo[]; healing: Healing }
  | { kind: "edge"; selector: EdgeSelector; index: number; faces: FaceInfo[]; edges: EdgeInfo[]; healing: Healing };
let healListener: ((h: HealEvent) => void) | null = null;

/** Told the makers of what each selector matched (the rebuild lists, per feature, whose faces and edges it picked). */
let matchListener: ((makers: (string | undefined)[]) => void) | null = null;

/** Listens to what selectors match while `run` runs. */
export function listenForMatches<T>(listener: (makers: (string | undefined)[]) => void, run: () => T): T {
  const was = matchListener;
  matchListener = listener;
  try {
    return run();
  } finally {
    matchListener = was;
  }
}

/** Listens to re-found selectors while `run` runs (the rebuild does: it warns, and offers the selector written for where the face is now). */
export function listenForHealing<T>(listener: (h: HealEvent) => void, run: () => T): T {
  const was = healListener;
  healListener = listener;
  try {
    return run();
  } finally {
    healListener = was;
  }
}

/** A clear match scores at most this against the hint... */
const HEAL_GOOD = 1.5;
/** ...and the runner-up scores at least this many times more. */
const HEAL_CLEAR = 2;

/**
 * Ranks items against a hint: the distance from where it was (in units that
 * grow with the thing's size, so a big face may move further), plus how far
 * its direction turned, plus how much its size changed. 0 is just as it was.
 */
export function rankByHint<T extends { index: number; centroid: Vec3; createdBy?: string }>(
  items: T[],
  hint: SelectorHint,
  dirOf: (t: T) => Vec3 | undefined,
  sizeOf: (t: T) => number,
  signFree: boolean,
  areaLike: boolean,
): Candidate[] {
  // A face of area A is "about 2√A across", an edge "its length" (between 2 and 25 mm): moving that far scores 1.
  const across = Math.min(25, Math.max(2, hint.size ? (areaLike ? 2 * Math.sqrt(hint.size) : hint.size) : 10));
  return items
    .map((t) => {
      let score = dist3(t.centroid, hint.centroid) / across;
      const d = dirOf(t);
      if (hint.normal && d) {
        const c = dot3(normalize3(d), normalize3(hint.normal));
        score += 2 * (1 - (signFree ? Math.abs(c) : c));
      }
      const size = sizeOf(t);
      if (hint.size && size > 0) score += Math.abs(Math.log(size / hint.size)) / 4;
      return { index: t.index, score, centroid: t.centroid, ...(t.createdBy ? { createdBy: t.createdBy } : {}) };
    })
    .sort((a, b) => a.score - b.score);
}

/** The one clear candidate, or null. */
function clearWinner(ranked: Candidate[]): Candidate | null {
  const [a, b] = ranked;
  if (!a || a.score > HEAL_GOOD) return null;
  if (b && b.score < a.score * HEAL_CLEAR + 0.05) return null;
  return a;
}

/** Of `items`, those the createdBy filter allows (all of them when the selector names no maker). */
function madeBy<T extends { createdBy?: string }>(items: T[], createdBy: string | undefined): T[] {
  if (createdBy === undefined) return items;
  return items.filter((t) => t.createdBy === undefined || t.createdBy === createdBy);
}

/** Of `items`, the ones closest to `p` (more than one means a tie). */
function nearest<T extends { centroid: Vec3 }>(items: T[], p: Vec3): T[] {
  if (items.length <= 1) return items;
  const d = items.map((it) => dist3(it.centroid, p));
  const best = Math.min(...d);
  return items.filter((_, i) => d[i] - best <= LENGTH_TOL);
}

export function selectFaces(infos: FaceInfo[], selector: FaceSelector): Selection {
  const r = selectFacesHealing(infos, selector);
  matchListener?.(r.matches.map((f) => f.createdBy));
  return r;
}

function selectFacesHealing(infos: FaceInfo[], selector: FaceSelector): Selection {
  const strict = selectFacesStrictly(infos, selector);
  if (!selector.hint || (strict.matches.length === 1 && !strict.tie)) return strict;
  // Picked once, now gone or no longer alone: find it again near where it was. First among the faces the selector
  // still matches with its sizes and positions let go (the same way, made by the same feature), else among all like it.
  const want = selector.type === "planar" ? "plane" : "cylinder";
  const loose = selectFacesStrictly(infos, relaxedFace(selector)).matches;
  const pool = infos.filter((f) => f.type === want && (selector.body === undefined || f.body === selector.body));
  const own = madeBy(pool, selector.createdBy);
  const ranked = rankByHint(loose.length ? loose : own.length ? own : pool, selector.hint, (f) => f.normal ?? f.cylinder?.axis, (f) => f.area, selector.type === "cylindrical", true);
  const found = clearWinner(ranked);
  if (!found) return { ...strict, unhealed: ranked.slice(0, 4) };
  const healing: Healing = { kind: "face", matched: strict.matches.length, found, ...(ranked[1] ? { next: ranked[1] } : {}) };
  healListener?.({ kind: "face", selector, index: found.index, faces: infos, healing });
  return { matches: [infos.find((f) => f.index === found.index)!], healed: healing };
}

/** A face selector without what an upstream edit changes (offset, level, radius, nearest point): what it still is. */
function relaxedFace(sel: FaceSelector): FaceSelector {
  const { hint: _h, near: _n, ...rest } = sel;
  if (rest.type === "planar") {
    const { offset: _o, rank: _r, ...planar } = rest;
    return { ...planar, pick: "all" };
  }
  const { radius: _r, ...cyl } = rest;
  return { ...cyl, pick: "all" };
}

/** An edge selector without what an upstream edit changes (radius, length, nearest point). */
function relaxedEdge(sel: EdgeSelector): EdgeSelector {
  const { hint: _h, near: _n, radius: _r, length: _l, ...rest } = sel;
  return { ...rest, pick: "all" };
}

/** The selector run exactly as written (no re-finding from its hint). */
export function selectFacesStrictly(infos: FaceInfo[], selector: FaceSelector): Selection {
  let matches = infos.filter((f) => matchesFace(f, selector));
  if (selector.type === "planar" && selector.rank !== undefined) matches = atRank(matches, selector.rank);
  if (selector.near) {
    matches = nearest(matches, selector.near);
    if (matches.length > 1) return { matches, tie: "nearest" };
  }
  if (selector.pick === "all" || matches.length <= 1) return { matches };
  const sign = selector.pick === "largest" ? 1 : -1;
  const best = Math.max(...matches.map((f) => sign * f.area));
  const tol = AREA_REL_TOL * Math.max(1, Math.abs(best));
  const top = matches.filter((f) => Math.abs(sign * f.area - best) <= tol);
  return top.length > 1 ? { matches: top, tie: selector.pick } : { matches: top };
}

/**
 * The planes the faces lie in, as levels along their (shared) normal, furthest
 * out first: the faces on level `rank` (1 the furthest out, -1 the furthest in).
 */
function atRank(faces: FaceInfo[], rank: number): FaceInfo[] {
  const levels = rankLevels(faces);
  const level = levels[rank > 0 ? rank - 1 : levels.length + rank];
  if (level === undefined) return [];
  return faces.filter((f) => Math.abs((f.offset ?? NaN) - level) <= LENGTH_TOL);
}

/** The different plane offsets of the faces, furthest out along the normal first (within LENGTH_TOL counts as one level). */
export function rankLevels(faces: FaceInfo[]): number[] {
  const offsets = faces.map((f) => f.offset ?? 0).sort((a, b) => b - a);
  const levels: number[] = [];
  for (const o of offsets) if (!levels.length || levels[levels.length - 1] - o > LENGTH_TOL) levels.push(o);
  return levels;
}

/** "outermost", "2nd from outermost", "innermost", "3rd from innermost". */
export function rankWords(rank: number): string {
  const n = Math.abs(rank);
  const end = rank > 0 ? "outermost" : "innermost";
  if (n === 1) return end;
  const suffix = n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th";
  return `${n}${suffix} from ${end}`;
}

function matchesFace(f: FaceInfo, sel: FaceSelector): boolean {
  if (sel.body !== undefined && f.body !== sel.body) return false;
  // Made by that feature: a face whose maker is unknown (no provenance recorded) is not ruled out.
  if (sel.createdBy !== undefined && f.createdBy !== undefined && f.createdBy !== sel.createdBy) return false;
  if (sel.type === "planar") {
    if (f.type !== "plane" || !f.normal) return false;
    if (dot3(f.normal, normalize3(sel.normal)) < 1 - ANGLE_TOL) return false;
    if (sel.offset !== undefined && Math.abs((f.offset ?? NaN) - sel.offset) > LENGTH_TOL) return false;
    return true;
  }
  if (f.type !== "cylinder" || !f.cylinder) return false;
  if (sel.radius !== undefined && Math.abs(f.cylinder.radius - sel.radius) > LENGTH_TOL) return false;
  if (sel.axis !== undefined && Math.abs(dot3(f.cylinder.axis, normalize3(sel.axis))) < 1 - ANGLE_TOL) return false;
  return true;
}

/** "1 planar face normal +Z", "1 cylindrical face radius 3.3", ... */
export function describeWanted(sel: FaceSelector, count: number): string {
  const noun = count === 1 ? "face" : "faces";
  const near = sel.near ? ` nearest ${fmtPoint(sel.near)}` : "";
  const of = (sel.body ? ` of body "${sel.body}"` : "") + (sel.createdBy ? ` made by ${sel.createdBy}` : "");
  if (sel.type === "planar") {
    const at = sel.offset !== undefined ? ` at offset ${sel.offset}` : sel.rank !== undefined ? `, ${rankWords(sel.rank)} along it` : "";
    return `${count} planar ${noun} normal ${formatDirection(sel.normal)}${at}${near}${of}`;
  }
  const parts = [`${count} cylindrical ${noun}`];
  if (sel.radius !== undefined) parts.push(`radius ${sel.radius}`);
  if (sel.axis !== undefined) parts.push(`axis ${formatDirection(sel.axis)}`);
  return parts.join(" ") + near + of;
}

/** Error text for a selection that is not exactly `wanted` faces, or null when it is. */
export function selectionError(sel: FaceSelector, result: Selection, wanted: number): string | null {
  if (result.matches.length === wanted) return null;
  if (result.unhealed) return `${moved("face", result.matches.length)}; ${candidateText("face", result.unhealed)} (wanted ${describeWanted(sel, wanted)})`;
  const n = result.matches.length;
  const tied = result.tie === "nearest" ? " tied for nearest" : result.tie ? ` tied for ${result.tie} area` : "";
  return `selector matched ${n} ${n === 1 ? "face" : "faces"}${tied} (wanted ${describeWanted(sel, wanted)})`;
}

// ----------------------------------------------------------------- edges

export interface EdgeSelection {
  matches: EdgeInfo[];
  tie?: "longest" | "shortest" | "nearest";
  /** A nested face selector could not resolve (empty or tied); the message says which. */
  error?: string;
  /** The selector stopped matching and was re-found from its hint: matches holds the one found. */
  healed?: Healing;
}

export function selectEdges(edges: EdgeInfo[], faces: FaceInfo[], sel: EdgeSelector, path = "edges"): EdgeSelection {
  const r = selectEdgesHealing(edges, faces, sel, path);
  if (!r.error) matchListener?.(r.matches.map((e) => e.createdBy));
  return r;
}

function selectEdgesHealing(edges: EdgeInfo[], faces: FaceInfo[], sel: EdgeSelector, path: string): EdgeSelection {
  const strict = selectEdgesStrictly(edges, faces, sel, path);
  if (!sel.hint || (strict.matches.length === 1 && !strict.tie && !strict.error)) return strict;
  const relaxed = selectEdgesStrictly(edges, faces, relaxedEdge(sel), path);
  const loose = relaxed.error ? [] : relaxed.matches;
  const pool = edges.filter((e) => !e.seam && (sel.kind === undefined || e.kind === sel.kind) && (sel.body === undefined || e.body === sel.body));
  const own = madeBy(pool, sel.createdBy);
  const ranked = rankByHint(loose.length ? loose : own.length ? own : pool, sel.hint, (e) => e.direction ?? e.axis, (e) => e.length, true, false);
  const found = clearWinner(ranked);
  const matched = strict.error ? 0 : strict.matches.length;
  if (!found) return { matches: [], error: `${path}: ${moved("edge", matched)}; ${candidateText("edge", ranked.slice(0, 4))} (wanted ${describeEdgeSelector(sel)})` };
  const healing: Healing = { kind: "edge", matched, found, ...(ranked[1] ? { next: ranked[1] } : {}) };
  healListener?.({ kind: "edge", selector: sel, index: found.index, faces, edges, healing });
  return { matches: [edges.find((e) => e.index === found.index)!], healed: healing };
}

/** "the edge it was picked on is gone or moved", "it matches 2 faces now, ...", for messages. */
function moved(kind: "face" | "edge", n: number): string {
  return n === 0 ? `the ${kind} it was picked on is gone or moved` : `it matches ${n} ${kind}s now, not the one it was picked on`;
}

/** The likeliest candidates, in words, ending with what to do. */
function candidateText(kind: "face" | "edge", list: Candidate[]): string {
  if (list.length === 0) return `no ${kind} like it is left: re-pick it`;
  const where = list.map((c) => `${fmtPoint(c.centroid)}${c.createdBy ? ` made by ${c.createdBy}` : ""}`);
  return `could not tell which ${kind} it is now (the nearest: ${where.join("; ")}): re-pick it`;
}

/** The selector run exactly as written (no re-finding from its hint). */
export function selectEdgesStrictly(edges: EdgeInfo[], faces: FaceInfo[], sel: EdgeSelector, path = "edges"): EdgeSelection {
  const faceSet = (fs: FaceSelector, where: string): Set<number> | string => {
    const r = selectFaces(faces, fs);
    if (r.matches.length === 0) return `${where}: selector matched 0 faces (wanted ${describeWanted(fs, 1)} or more)`;
    if (r.tie) return `${where}: selector matched ${r.matches.length} faces tied for ${r.tie}${r.tie === "nearest" ? "" : " area"}`;
    return new Set(r.matches.map((f) => f.index));
  };
  let on: Set<number> | undefined;
  let between: [Set<number>, Set<number>] | undefined;
  if (sel.onFace) {
    const r = faceSet(sel.onFace, `${path}.onFace`);
    if (typeof r === "string") return { matches: [], error: r };
    on = r;
  }
  if (sel.between) {
    const a = faceSet(sel.between[0], `${path}.between[0]`);
    if (typeof a === "string") return { matches: [], error: a };
    const b = faceSet(sel.between[1], `${path}.between[1]`);
    if (typeof b === "string") return { matches: [], error: b };
    between = [a, b];
  }
  let matches = edges.filter((e) => {
    if (e.seam) return false;
    if (sel.body !== undefined && e.body !== sel.body) return false;
    if (sel.createdBy !== undefined && e.createdBy !== undefined && e.createdBy !== sel.createdBy) return false;
    if (sel.kind && e.kind !== sel.kind) return false;
    if (sel.direction && (e.kind !== "line" || Math.abs(dot3(e.direction!, normalize3(sel.direction))) < 1 - ANGLE_TOL)) return false;
    if (sel.radius !== undefined && (e.kind !== "circle" || Math.abs(e.radius! - sel.radius) > LENGTH_TOL)) return false;
    if (sel.length !== undefined && Math.abs(e.length - sel.length) > LENGTH_TOL) return false;
    if (on && !e.faces.some((f) => on!.has(f))) return false;
    if (between) {
      const [a, b] = between;
      const ok = e.faces.some((fa) => a.has(fa) && e.faces.some((fb) => fb !== fa && b.has(fb)));
      if (!ok) return false;
    }
    return true;
  });
  if (sel.near) {
    matches = nearest(matches, sel.near);
    if (matches.length > 1) return { matches, tie: "nearest" };
  }
  if (sel.pick === "all" || matches.length <= 1) return { matches };
  const sign = sel.pick === "longest" ? 1 : -1;
  const best = Math.max(...matches.map((e) => sign * e.length));
  const top = matches.filter((e) => Math.abs(sign * e.length - best) <= LENGTH_TOL);
  return top.length > 1 ? { matches: top, tie: sel.pick } : { matches: top };
}

/** "line edges parallel to +Z on the planar face normal +Z", for error messages. */
export function describeEdgeSelector(sel: EdgeSelector): string {
  const parts = [sel.kind ? `${sel.kind} edges` : "edges"];
  if (sel.direction) parts.push(`parallel to ${formatDirection(sel.direction)}`);
  if (sel.radius !== undefined) parts.push(`radius ${sel.radius}`);
  if (sel.length !== undefined) parts.push(`length ${sel.length}`);
  if (sel.onFace) parts.push(`on ${describeWanted(sel.onFace, 1).replace(/^1 /, "the ")}`);
  if (sel.between) {
    parts.push(
      `between ${describeWanted(sel.between[0], 1).replace(/^1 /, "the ")} and ${describeWanted(sel.between[1], 1).replace(/^1 /, "the ")}`,
    );
  }
  if (sel.near) parts.push(`nearest ${fmtPoint(sel.near)}`);
  if (sel.body) parts.push(`of body "${sel.body}"`);
  if (sel.createdBy) parts.push(`made by ${sel.createdBy}`);
  if (sel.pick !== "all") parts.push(`(${sel.pick})`);
  return parts.join(" ");
}

/** Error text when an edge selection is empty, ambiguous or broken; null when usable. */
export function edgeSelectionError(sel: EdgeSelector, result: EdgeSelection, path = "edges"): string | null {
  if (result.error) return result.error;
  if (result.tie) {
    return `${path}: selector matched ${result.matches.length} edges tied for ${result.tie} (wanted 1 of ${describeEdgeSelector(sel)})`;
  }
  if (result.matches.length === 0) return `${path}: selector matched 0 edges (wanted ${describeEdgeSelector(sel)})`;
  return null;
}

function fmtPoint(p: Vec3): string {
  return `[${p.map((x) => Math.round(x * 1e4) / 1e4).join(", ")}]`;
}

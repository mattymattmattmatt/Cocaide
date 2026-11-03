// Fillet and chamfer: which edges (selectors, every edge of some faces, every
// edge of the faces a feature made), with which size (a fillet's sets of radii,
// a radius that varies along each edge; a chamfer of equal distances, two
// distances or a distance and an angle), body by body. When OCCT refuses the
// edges together, they are built in passes (the most that build together,
// then the rest on that result); when that fails too, each edge is tried alone
// to say which one fails, why, and the largest size that works ("edge 3
// (straight, +Z, length 6, at [..]): radius 4 is too large for the 3 mm face
// beside it: the most that fits here is radius ≈ 2.9 mm").

import type { TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from "replicad-opencascadejs";
import type { ChamferFeature, EdgeChoice, FilletFeature, Vec3 } from "../doc/types";
import { dist3, dot3, formatDirection, len3, normalize3, roundTo, scale3, sub3 } from "../geom/vec";
import type { DescribedPart } from "./bodies";
import { roomAt } from "./edgeRoom";
import { isValidShape, volumeOf } from "./measure";
import type { OC, Scope } from "./oc";
import { OpError, VOLUME_EPS } from "./ops";
import { describeWanted, edgeSelectionError, selectEdges, selectFaces } from "./selectors";
import { faceSignature, type EdgeInfo, type FaceInfo } from "./topology";

/** One edge to treat and how. */
export interface Treatment {
  /** Index in the described part. */
  edge: number;
  /** Fillet: radius (and radius2 at its end); chamfer: distance (and distance2, or angle in degrees). */
  size: number;
  size2?: number;
  angle?: number;
  /** Where it came from, for messages ("sets[1]"; "" for the feature's own). */
  set: string;
  /** Only a face or a feature brought it in (every edge of them), not an edge selector: a smooth one is left out. */
  fromFaces?: boolean;
}

/**
 * The edges a choice (the feature's own, or one of a fillet's sets) picks,
 * by index: its selectors' matches, every edge of its faces, every edge of
 * the faces its features made (`made(id)`: the face signatures that feature
 * made, or an OpError when it failed). `picked` (when given) collects the
 * ones an edge selector matched.
 */
export function chosenEdges(part: DescribedPart, ch: EdgeChoice, path: string, made: (id: string, path: string) => ReadonlySet<string>, picked?: Set<number>): number[] {
  const at = (k: string) => (path ? `${path}.${k}` : k);
  const chosen = new Set<number>();
  const selectors = ch.edges === undefined ? [] : Array.isArray(ch.edges) ? ch.edges : [ch.edges];
  selectors.forEach((sel, i) => {
    const where = Array.isArray(ch.edges) ? `${at("edges")}[${i}]` : at("edges");
    const result = selectEdges(part.edgeInfos, part.faceInfos, sel, where);
    const problem = edgeSelectionError(sel, result, where);
    if (problem) throw new OpError(problem);
    for (const e of result.matches) {
      chosen.add(e.index);
      picked?.add(e.index);
    }
  });
  const onFaces = (faces: Set<number>) => {
    for (const e of part.edgeInfos) if (!e.seam && e.faces.some((f) => faces.has(f))) chosen.add(e.index);
  };
  ch.faces?.forEach((sel, i) => {
    const where = `${at("faces")}[${i}]`;
    const found = selectFaces(part.faceInfos, sel);
    if (found.matches.length === 0) throw new OpError(`${where}: selector matched 0 faces (wanted ${describeWanted(sel, 1)} or more)`);
    if (found.tie) throw new OpError(`${where}: selector matched ${found.matches.length} faces tied for ${found.tie}${found.tie === "nearest" ? "" : " area"} (wanted ${describeWanted(sel, 1)})`);
    onFaces(new Set(found.matches.map((f) => f.index)));
  });
  ch.features?.forEach((id, i) => {
    const where = `${at("features")}[${i}]`;
    const sigs = made(id, where);
    const faces = new Set(part.faceInfos.filter((f) => sigs.has(faceSignature(f))).map((f) => f.index));
    if (faces.size === 0) throw new OpError(`${where}: none of the faces "${id}" made are left in the part (later features removed them)`);
    onFaces(faces);
  });
  return [...chosen];
}

/** Every edge the feature treats, with its size; an edge in two sets is an error. */
export function treatments(f: FilletFeature | ChamferFeature, part: DescribedPart, made: (id: string, path: string) => ReadonlySet<string>): Treatment[] {
  const out: Treatment[] = [];
  const seen = new Map<number, string>();
  const take = (ch: EdgeChoice, path: string, t: Omit<Treatment, "edge" | "set">) => {
    const picked = new Set<number>();
    for (const edge of chosenEdges(part, ch, path, made, picked)) {
      if (seen.has(edge)) {
        if (seen.get(edge) === path) continue;
        const name = (p: string) => (p ? p : "the feature's own edges");
        throw new OpError(`${describeEdge(part.edgeInfos[edge])} is in ${name(seen.get(edge)!)} and in ${name(path)}: give each edge one radius`);
      }
      seen.set(edge, path);
      out.push({ edge, set: path, ...t, ...(picked.has(edge) ? {} : { fromFaces: true }) });
    }
  };
  if (f.op === "chamfer") {
    take(f, "", { size: f.distance, ...(f.distance2 !== undefined ? { size2: f.distance2 } : {}), ...(f.angle !== undefined ? { angle: f.angle } : {}) });
  } else {
    if (f.radius !== undefined) take(f, "", { size: f.radius, ...(f.radius2 !== undefined ? { size2: f.radius2 } : {}) });
    f.sets?.forEach((set, i) => take(set, `sets[${i}]`, { size: set.radius, ...(set.radius2 !== undefined ? { size2: set.radius2 } : {}) }));
  }
  return out;
}

/** An edge of the body being treated, as OCCT has it now (one edge, or the pieces an earlier pass left of it), with the face that takes a chamfer's first distance. */
interface Item {
  t: Treatment;
  edges: TopoDS_Edge[];
  face?: TopoDS_Face;
}

/** The OCCT builder's history: what became of a face or edge. */
interface History {
  Modified(x: TopoDS_Shape): unknown;
  IsDeleted(x: TopoDS_Shape): boolean;
}

/** What one try gave: the treated body (and the builder, for its history), or why not. */
type Attempt = { shape: TopoDS_Shape; maker: History } | { why: "refused" | "invalid" | "unchanged" };

/** How many halvings find the largest size that works (to about a hundredth of the size asked for: the message gives two digits). */
const BISECT_STEPS = 7;

/**
 * One body with its edges filleted or chamfered. `name` is set in a part of
 * several bodies, for messages. In scope `s`.
 *
 * All the edges are built together first. An edge a face or feature brought
 * in that is smooth (where a face runs on tangentially, as beside an earlier
 * fillet) is left out: there is no corner there. When OCCT refuses the lot
 * (it often does where an inside and an outside corner meet at a vertex),
 * they are built in passes: the most that build together, then the rest on
 * that result. When that fails too, the message names each edge that fails,
 * why, and the largest size that works.
 */
export function treatBody(oc: OC, s: Scope, f: FilletFeature | ChamferFeature, part: DescribedPart, body: TopoDS_Shape, list: Treatment[], name: string | null): TopoDS_Shape {
  const where = name ? ` of body "${name}"` : "";
  const smooth = new Set(list.filter((t) => smoothEdge(oc, part, t.edge)).map((t) => t.edge));
  const kept = list.filter((t) => !(smooth.has(t.edge) && t.fromFaces));
  if (kept.length === 0) throw new OpError(`every edge of those faces${where} runs on smoothly into the next face (rounded already): there is no corner left to ${verb(f)}`);
  const picked = kept.filter((t) => smooth.has(t.edge));
  if (picked.length) throw new OpError(smoothText(f, part, kept, picked, where));
  const items = kept.map((t) => itemOf(f, part, t));
  const before = volumeOf(oc, s, body);
  const all = attempt(oc, s, f, body, items, 1, before);
  if ("shape" in all) return all.shape;
  if (items.length > 1) {
    const passes = inPasses(oc, s, f, body, items, before);
    if (passes) return passes;
  }
  throw new OpError(diagnose(oc, s, f, part, body, items, before, where, all.why));
}

function itemOf(f: FilletFeature | ChamferFeature, part: DescribedPart, t: Treatment): Item {
  const asymmetric = f.op === "chamfer" && (t.size2 !== undefined || t.angle !== undefined);
  return { t, edges: [part.edges[t.edge]], ...(asymmetric ? { face: firstFace(part, t.edge, (f as ChamferFeature).flip === true) } : {}) };
}

/** Do the edge's two faces meet smoothly along it (tangent, as a fillet meets the faces it rounds)? */
function smoothEdge(oc: OC, part: DescribedPart, edge: number): boolean {
  const faces = [...new Set(part.edgeInfos[edge].faces)];
  if (faces.length !== 2) return false;
  try {
    const [a, b] = faces.map((i) => part.faces[i]);
    // Marks the edge with how its faces meet (within 0.01°), as OCCT's fillets do; then reads it.
    oc.BRepLib.EncodeRegularity(part.edges[edge], a, b, 1.75e-4);
    return oc.BRep_Tool.Continuity(part.edges[edge], a, b) !== oc.GeomAbs_Shape.GeomAbs_C0;
  } catch {
    return false;
  }
}

/** The body with the items treated at `scale` times their sizes, checked: valid, and changed. */
function attempt(oc: OC, s: Scope, f: FilletFeature | ChamferFeature, body: TopoDS_Shape, items: Item[], scale: number, before: number): Attempt {
  const maker = build(oc, s, f, body, items, scale);
  if (!maker) return { why: "refused" };
  const shape = s.track(maker.Shape());
  if (!isValidShape(oc, s, shape)) return { why: "invalid" };
  if (Math.abs(volumeOf(oc, s, shape) - before) <= VOLUME_EPS * Math.max(1, before)) return { why: "unchanged" };
  return { shape, maker };
}

/** The OCCT builder, done; null when OCCT refuses. */
function build(oc: OC, s: Scope, f: FilletFeature | ChamferFeature, body: TopoDS_Shape, items: Item[], scale: number) {
  try {
    if (f.op === "fillet") {
      const b = s.track(new oc.BRepFilletAPI_MakeFillet(body, oc.ChFi3d_FilletShape.ChFi3d_Rational));
      for (const { t, edges } of items) {
        for (const e of edges) {
          if (t.size2 !== undefined && Math.abs(t.size2 - t.size) > 1e-12) b.Add(t.size * scale, t.size2 * scale, e);
          else b.Add(t.size * scale, e);
        }
      }
      b.Build(s.track(new oc.Message_ProgressRange()));
      return b.IsDone() ? b : null;
    }
    const b = s.track(new oc.BRepFilletAPI_MakeChamfer(body));
    for (const { t, edges, face } of items) {
      for (const e of edges) {
        if (!face) b.Add(t.size * scale, e);
        else if (t.angle !== undefined) b.AddDA(t.size * scale, (t.angle * Math.PI) / 180, e, face);
        else b.Add(t.size * scale, t.size2! * scale, e, face);
      }
    }
    b.Build(s.track(new oc.Message_ProgressRange()));
    return b.IsDone() ? b : null;
  } catch {
    // OCCT throws on some impossible sizes rather than reporting them: the same as a refusal.
    return null;
  }
}

/** What became of a face or edge in a build: itself when untouched, its pieces when changed, nothing when gone. */
function after<T extends TopoDS_Shape>(oc: OC, s: Scope, maker: History, x: T, cast: (y: TopoDS_Shape) => T): T[] {
  if (maker.IsDeleted(x)) return [];
  const list = s.track(new oc.NCollection_List_TopoDS_Shape(maker.Modified(x) as never));
  if (list.IsEmpty()) return [x];
  const out: T[] = [];
  while (!list.IsEmpty()) {
    out.push(s.track(cast(s.track(list.First()))));
    list.RemoveFirst();
  }
  return out;
}

/**
 * The items in passes: as many as build together (in order, each kept when
 * it still builds with those before it), then the rest, carried onto that
 * result (an edge an earlier pass cut short goes on as what is left of it),
 * the same way. Null when a pass can take none of what is left, or an edge
 * is gone.
 */
function inPasses(oc: OC, s: Scope, f: FilletFeature | ChamferFeature, body: TopoDS_Shape, items: Item[], before: number): TopoDS_Shape | null {
  if (items.length > 24) return null;
  const first = passesInOrder(oc, s, f, body, items, before);
  if ("shape" in first) return first.shape;
  // The edges the first pass could not take (an inside corner, often) may go first instead, the others on them.
  if (!first.odd.length) return null;
  const again = passesInOrder(oc, s, f, body, [...first.odd, ...items.filter((it) => !first.odd.includes(it))], before);
  return "shape" in again ? again.shape : null;
}

function passesInOrder(oc: OC, s: Scope, f: FilletFeature | ChamferFeature, body: TopoDS_Shape, items: Item[], before: number): { shape: TopoDS_Shape } | { odd: Item[] } {
  let odd: Item[] = [];
  let shape = body;
  let volume = before;
  let left = items;
  for (let pass = 0; pass < 4 && left.length; pass++) {
    const take: Item[] = [];
    let last: { shape: TopoDS_Shape; maker: History } | null = null;
    for (const it of left) {
      const a = attempt(oc, s, f, shape, [...take, it], 1, volume);
      if ("shape" in a) {
        take.push(it);
        last = a;
      }
    }
    if (!last) return { odd };
    const maker = last.maker;
    const rest = left.filter((it) => !take.includes(it));
    if (pass === 0) odd = rest;
    const carried = rest.map((it) => ({
      ...it,
      edges: it.edges.flatMap((e) => after(oc, s, maker, e, (y) => oc.TopoDS.Edge(y))),
      ...(it.face ? { face: after(oc, s, maker, it.face, (y) => oc.TopoDS.Face(y))[0] } : {}),
    }));
    if (carried.some((it) => it.edges.length === 0 || ("face" in it && !it.face))) return { odd };
    left = carried;
    shape = last.shape;
    volume = volumeOf(oc, s, shape);
  }
  return left.length ? { odd } : { shape };
}

/** The largest fraction of the sizes that builds (found by halving); 0 when even a hundredth does not. */
function largestScale(oc: OC, s: Scope, f: FilletFeature | ChamferFeature, body: TopoDS_Shape, items: Item[], before: number): number {
  const works = (k: number) => "shape" in attempt(oc, s, f, body, items, k, before);
  if (!works(0.01)) return 0;
  let lo = 0.01;
  let hi = 1;
  for (let i = 0; i < BISECT_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (works(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** A size that works, rounded down so it still does, to two significant digits ("2.4"). */
export function sizeThatWorks(x: number): number {
  if (!(x > 0)) return 0;
  const step = 10 ** (Math.floor(Math.log10(x)) - 1);
  return roundTo(Math.floor(x / step + 1e-9) * step, 6);
}

/** Why the treatment failed: each edge that fails alone, named, why, and the size that works; or, when they fail only together, what does work. */
function diagnose(oc: OC, s: Scope, f: FilletFeature | ChamferFeature, part: DescribedPart, body: TopoDS_Shape, items: Item[], before: number, where: string, why: Exclude<Attempt, { shape: TopoDS_Shape }>["why"]): string {
  const word = sizeWord(f);
  const n = items.length;
  if (n === 1 && why === "unchanged") return `the ${f.op} changed nothing${where}`;
  const failing = n === 1 ? items : items.slice(0, 60).filter((it) => !("shape" in attempt(oc, s, f, body, [it], 1, before)));
  const name = (it: Item) => `edge ${items.indexOf(it) + 1}${n > 1 ? ` of ${n}` : ""} (${edgeWords(part.edgeInfos[it.t.edge])})${where}`;
  if (failing.length === 0) {
    const k = largestScale(oc, s, f, body, items, before);
    const biggest = Math.max(...items.map((it) => Math.max(it.t.size, it.t.size2 ?? 0)));
    const fits = k > 0 ? ` Together they work up to ${word} ≈ ${sizeThatWorks(k * biggest)} mm.` : "";
    // The edges that cannot join the rest: put them in a feature of their own.
    const together: Item[] = [];
    for (const it of items) if ("shape" in attempt(oc, s, f, body, [...together, it], 1, before)) together.push(it);
    const odd = items.filter((it) => !together.includes(it));
    const fix =
      odd.length && odd.length <= 3
        ? ` ${odd.map(name).join(" and ")} ${odd.length === 1 ? "is the edge" : "are the edges"} that cannot join the others: give ${odd.length === 1 ? "it" : "them"} a ${f.op} of ${odd.length === 1 ? "its" : "their"} own, or pick fewer edges.`
        : ` Pick fewer edges, or treat them in separate ${f.op}s.`;
    return `the ${f.op} fails where its ${n} edges${where} meet (each works alone).${fits}${fix}`;
  }
  const lines = failing.slice(0, 8).map((it) => {
    const t = it.t;
    const info = part.edgeInfos[t.edge];
    const size = `${word} ${sizeText(f, t)}`;
    const room = roomAt(part.edgeInfos, info);
    const biggest = Math.max(t.size, t.size2 ?? 0);
    // Bisect for the size that works on a few edges; with many, naming them is enough.
    const scale = failing.length <= 3 ? largestScale(oc, s, f, body, [it], before) : -1;
    const fits = scale > 0 ? sizeThatWorks(scale * biggest) : 0;
    const most = fits > 0 ? `: the most that fits here is ${word} ≈ ${fits} mm` : `; try a smaller ${word}`;
    if (Number.isFinite(room) && biggest >= room - 1e-9) return `${name(it)}: ${size} is too large for the ${roundTo(room, 4)} mm face beside it${most}`;
    if (fits > 0) return `${name(it)}: ${size} does not fit here${Number.isFinite(room) ? ` (the faces beside it leave ${roundTo(room, 4)} mm)` : ""}${most}`;
    if (scale === 0) {
      const freeform = info.faces.some((fi) => part.faceInfos[fi].type === "other");
      return `${name(it)}: the kernel cannot ${f.op} this edge at any ${word}${freeform ? " (a freeform face meets it)" : ""}: ${f.op === "fillet" ? "try a chamfer, or " : ""}leave it out`;
    }
    if (why === "invalid" && n === 1) return `the ${f.op} produced an invalid solid${where}: try a smaller ${word}`;
    return `${name(it)}: ${size} fails on it; try a smaller ${word}`;
  });
  if (failing.length > 8) lines.push(`and ${failing.length - 8} more of its edges fail alone too`);
  return lines.join("\n");
}

/** Smooth edges picked on purpose: there is no corner there. */
function smoothText(f: FilletFeature | ChamferFeature, part: DescribedPart, list: Treatment[], smooth: Treatment[], where: string): string {
  return smooth
    .map((t) => {
      const label = `edge ${list.indexOf(t) + 1}${list.length > 1 ? ` of ${list.length}` : ""} (${edgeWords(part.edgeInfos[t.edge])})${where}`;
      return `${label}: the faces meet smoothly there (it is the edge of a round), so there is no corner to ${verb(f)}: pick the sharp edge beside it instead`;
    })
    .join("\n");
}

function verb(f: FilletFeature | ChamferFeature): string {
  return f.op === "fillet" ? "round" : "bevel";
}

function sizeWord(f: FilletFeature | ChamferFeature): string {
  return f.op === "fillet" ? "radius" : "distance";
}

function sizeText(f: FilletFeature | ChamferFeature, t: Treatment): string {
  if (f.op === "fillet") return t.size2 !== undefined ? `${roundTo(t.size, 6)} to ${roundTo(t.size2, 6)}` : `${roundTo(t.size, 6)}`;
  if (t.angle !== undefined) return `${roundTo(t.size, 6)} at ${roundTo(t.angle, 6)}°`;
  return t.size2 !== undefined ? `${roundTo(t.size, 6)} by ${roundTo(t.size2, 6)}` : `${roundTo(t.size, 6)}`;
}

/** "straight, +Z, length 6, at [0, 0, 3]", "round, radius 3, at [..]", "curved, length 9.4, at [..]". */
export function edgeWords(e: EdgeInfo): string {
  const at = `at [${e.mid.map((x) => roundTo(x, 4)).join(", ")}]`;
  if (e.kind === "line") return `straight, ${formatDirection(e.direction!)}, length ${roundTo(e.length, 4)}, ${at}`;
  if (e.kind === "circle") return `round, radius ${roundTo(e.radius!, 4)}, ${at}`;
  return `curved, length ${roundTo(e.length, 4)}, ${at}`;
}

/** "the edge (straight, +Z, ...)": an edge as messages name it. */
function describeEdge(e: EdgeInfo): string {
  return `the edge (${edgeWords(e)})`;
}

/**
 * The face of an edge that takes a chamfer's first distance: the one facing
 * most up (+Z, then +Y, then +X, by its outward normal beside the edge);
 * `flip` takes the other.
 */
export function firstFace(part: DescribedPart, edge: number, flip: boolean): TopoDS_Face {
  const info = part.edgeInfos[edge];
  const faces = [...new Set(info.faces)];
  if (faces.length < 2) return part.faces[faces[0]];
  const ranked = faces
    .map((fi) => ({ fi, n: normalBeside(part.faceInfos[fi], info) }))
    .sort((a, b) => {
      for (const k of [2, 1, 0]) if (Math.abs(a.n[k] - b.n[k]) > 1e-6) return b.n[k] - a.n[k];
      return a.fi - b.fi;
    });
  return part.faces[ranked[flip ? 1 : 0].fi];
}

/** A face's outward normal near an edge of it (planes and cylinders exactly; other faces roughly, toward their middle). */
function normalBeside(face: FaceInfo, edge: EdgeInfo): Vec3 {
  if (face.type === "plane" && face.normal) return normalize3(face.normal);
  if (face.type === "cylinder" && face.cylinder) {
    const c = face.cylinder;
    const rel = sub3(edge.mid, c.origin);
    const radial = sub3(rel, scale3(c.axis, dot3(rel, c.axis)));
    const n = len3(radial) > 1e-12 ? normalize3(radial) : ([0, 0, 1] as Vec3);
    return c.concave ? scale3(n, -1) : n;
  }
  const toward = sub3(face.centroid, edge.mid);
  return dist3(face.centroid, edge.mid) > 1e-12 ? normalize3(toward) : [0, 0, 1];
}

/** The edges of each body a feature treats, as OCCT edges, by body name. */
export function byBody(part: DescribedPart, list: Treatment[]): { name: string; list: Treatment[] }[] {
  return part.ranges
    .map((r) => ({ name: r.name, list: list.filter((t) => t.edge >= r.edges[0] && t.edge < r.edges[1]) }))
    .filter((b) => b.list.length > 0);
}

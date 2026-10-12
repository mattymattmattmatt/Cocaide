// sketchProfile: a whole sketch from a compact description, the way a careful
// CAD user would draw it. Each shape (an outline of lines and arcs with
// rounded corners, a rectangle, a circle, a slot, a polygon, a line, a point)
// becomes plain entities joined by the relations the app's own tools write
// (coincident ends, horizontal and vertical lines, tangent arcs, equal
// fillets), its sizes become dimensions (keeping any "=expression" the
// description gave), and Fully Define (src/geom/fullyDefine.ts) adds what is
// still missing, measured from the geometry as drawn, so the sketch comes out
// fully defined and nothing moves.
//
// Pure: document in, one command out (a new sketch, or the existing sketch's
// entities and constraints replaced with the old ones plus the new).

import type { Command, RawDocument } from "../../doc/commands";
import { documentParameters, isExpression, resolveExpressions } from "../../doc/parameters";
import type { Constraint, SketchEntity, Vec2 } from "../../doc/types";
import { isObject } from "../../doc/validate";
import { checkConstraints } from "../../geom/constraints";
import { fullyDefine } from "../../geom/fullyDefine";
import { buildProfile } from "../../geom/profile";
import { sketchStatus } from "../../geom/solver";
import { add2, cross2, dist2, dot2, len2, scale2, sub2 } from "../../geom/vec";
import { r6 } from "./common";

type Raw = Record<string, unknown>;
type Num = { value: number; expr?: string };

/** What sketchProfile made, for the tool result. */
export interface ProfileMade {
  command: Command;
  sketch: string;
  created: boolean;
  /** Per shape: the ids of the entities it became. */
  shapes: { shape: string; entities: string[] }[];
  /** The constraints added, with their index in the sketch. */
  added: { index: number; constraint: Constraint }[];
  dof: number;
  profile: { closed: true; regions: number; area: number } | { closed: false; problem: string };
}

const TOL = 1e-9;

class ProfileError extends Error {}

/** Builds the command. Throws nothing: an error is returned as a string that says what to fix. */
export function sketchProfile(doc: RawDocument, input: unknown): ProfileMade | string {
  try {
    return build(doc, isObject(input) ? input : {});
  } catch (e) {
    if (e instanceof ProfileError) return `sketchProfile: ${e.message}`;
    throw e;
  }
}

function build(doc: RawDocument, a: Raw): ProfileMade {
  const id = typeof a.sketch === "string" ? a.sketch : "";
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) throw new ProfileError('"sketch" must be the id of a sketch to add to, or of a new one ("sk_profile")');
  if (!Array.isArray(a.shapes) || a.shapes.length === 0) throw new ProfileError('"shapes" must list at least one shape (polyline, rect, circle, slot, polygon, line or point)');
  const existing = doc.features.find((f) => f.id === id);
  if (existing && existing.op !== "sketch") throw new ProfileError(`"${id}" is a ${String(existing.op)}, not a sketch`);
  if (existing && a.plane !== undefined) throw new ProfileError(`"${id}" already exists: leave out "plane" (it keeps its own), or give a new sketch id`);
  const params = documentParameters(doc);
  const old = existing ? (resolveExpressions(existing, params, []) as { entities?: SketchEntity[]; constraints?: Constraint[] }) : {};
  const oldEntities = (old.entities ?? []) as SketchEntity[];
  const oldConstraints = (old.constraints ?? []) as Constraint[];
  const rawOldEntities = existing && Array.isArray(existing.entities) ? (existing.entities as Raw[]) : [];
  const rawOldConstraints = existing && Array.isArray(existing.constraints) ? (existing.constraints as Raw[]) : [];

  const d = new Drawer(params, [...oldEntities.map((e) => e.id)]);
  const shapes: ProfileMade["shapes"] = [];
  a.shapes.forEach((s, i) => {
    if (!isObject(s)) throw new ProfileError(`shapes[${i}] must be an object`);
    const before = d.entities.length;
    const kind = d.shape(s, `shapes[${i}]`);
    shapes.push({ shape: kind, entities: d.entities.slice(before).map((e) => e.id) });
  });

  // Fully define what is still free, measured from the geometry as drawn.
  const resolvedNew = d.entities;
  const all = [...oldEntities, ...resolvedNew];
  const drawnConstraints = [...oldConstraints, ...d.constraints.map((k) => k.solved)];
  let extra: Constraint[] = [];
  if (a.dimensions !== "none") {
    const datum = typeof a.datum === "string" ? a.datum : undefined;
    extra = fullyDefine(all, drawnConstraints, { datum }).add;
  }
  const finalSolved = [...drawnConstraints, ...extra];
  const broken = checkConstraints(all, finalSolved);
  if (broken.length) throw new ProfileError(`the drawn geometry does not meet its own relations (${broken[0]}); check the shapes' numbers`);
  let dof = 0;
  try {
    dof = sketchStatus(all, finalSolved).dof;
  } catch {
    dof = -1;
  }
  const p = buildProfile(all);

  // What goes in the document: the new entities as numbers, the constraints with the expressions they were given.
  const entitiesOut: Raw[] = [...rawOldEntities, ...resolvedNew.map((e) => ({ ...e }) as unknown as Raw)];
  const constraintsOut: Raw[] = [...rawOldConstraints, ...d.constraints.map((k) => k.written as unknown as Raw), ...(extra as unknown as Raw[])];
  const added = [...d.constraints.map((k) => k.solved), ...extra].map((constraint, j) => ({ index: rawOldConstraints.length + j, constraint }));
  let command: Command;
  if (existing) {
    command = { type: "updateFeature", id, patch: { entities: entitiesOut, constraints: constraintsOut } };
  } else {
    const plane = a.plane ?? { type: "ref", ref: { datum: "Top" } };
    command = { type: "addFeature", feature: { id, op: "sketch", plane, entities: entitiesOut, constraints: constraintsOut } };
  }
  return {
    command,
    sketch: id,
    created: !existing,
    shapes,
    added,
    dof,
    profile: p.ok ? { closed: true, regions: p.regions.length, area: r6(p.area) } : { closed: false, problem: p.error },
  };
}

interface Pending {
  /** With numbers (what the geometry is checked and fully defined against). */
  solved: Constraint;
  /** As it goes in the document ("=expression" values kept). */
  written: Constraint;
}

type Seg = { kind: "line"; a: Vec2; b: Vec2 } | { kind: "arc"; a: Vec2; b: Vec2; c: Vec2; cw: boolean; tangentIn?: boolean };

class Drawer {
  readonly entities: SketchEntity[] = [];
  readonly constraints: Pending[] = [];
  private readonly used: Set<string>;

  constructor(
    private readonly params: ReturnType<typeof documentParameters>,
    taken: string[],
  ) {
    this.used = new Set(taken);
  }

  private id(prefix: string, wanted?: string): string {
    if (wanted !== undefined) {
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(wanted) || wanted === "X" || wanted === "Y") throw new ProfileError(`id "${wanted}" is not a usable entity id (letters, digits, _ and -; not X or Y)`);
      if (this.used.has(wanted)) throw new ProfileError(`the sketch already has an entity "${wanted}"`);
      this.used.add(wanted);
      return wanted;
    }
    for (let n = 1; ; n++) {
      const c = `${prefix}${n}`;
      if (!this.used.has(c)) {
        this.used.add(c);
        return c;
      }
    }
  }

  private num(v: unknown, path: string, opts: { positive?: boolean } = {}): Num {
    if (typeof v === "number" && Number.isFinite(v)) {
      if (opts.positive && !(v > 0)) throw new ProfileError(`${path} must be over 0 (got ${v})`);
      return { value: v };
    }
    if (isExpression(v)) {
      const errors: string[] = [];
      const value = resolveExpressions(v, this.params, errors, path);
      if (errors.length || typeof value !== "number") throw new ProfileError(errors[0] ?? `${path}: ${v} is not a number`);
      if (opts.positive && !(value > 0)) throw new ProfileError(`${path} must be over 0 (${v} is ${value})`);
      return { value, expr: v };
    }
    throw new ProfileError(`${path} must be a number or an "=expression" (got ${JSON.stringify(v)})`);
  }

  private pt(v: unknown, path: string): Vec2 {
    if (!Array.isArray(v) || v.length !== 2) throw new ProfileError(`${path} must be [x, y]`);
    return [this.num(v[0], `${path}[0]`).value, this.num(v[1], `${path}[1]`).value];
  }

  private rel(k: Constraint) {
    this.constraints.push({ solved: k, written: k });
  }

  /** A dimension: its number for the geometry, and the expression (if one was given) for the document. */
  private dim(k: Constraint & { value: number }, n: Num | number, name?: string) {
    const v = typeof n === "number" ? { value: n } : n;
    const solved = { ...k, value: v.value, ...(name ? { name } : {}) } as Constraint;
    const written = { ...k, value: v.expr ?? v.value, ...(name ? { name } : {}) } as unknown as Constraint;
    this.constraints.push({ solved, written });
  }

  private add<T extends SketchEntity>(e: T, construction: boolean): T {
    const out = (construction ? { ...e, construction: true } : e) as T;
    this.entities.push(out);
    return out;
  }

  /** Puts a point where it is from the origin: on it, level with or plumb under it, or dimensioned in X and Y. */
  private place(ref: string, p: Vec2, src?: { x?: Num; y?: Num }) {
    const zx = Math.abs(p[0]) <= TOL;
    const zy = Math.abs(p[1]) <= TOL;
    if (zx && zy) return this.rel({ type: "coincident", points: ["origin", ref] });
    if (zx) this.rel({ type: "vertical", points: ["origin", ref] });
    else this.dim({ type: "distanceX", points: ["origin", ref], value: 0 }, src?.x && src.x.expr && p[0] > 0 ? src.x : Math.abs(p[0]));
    if (zy) this.rel({ type: "horizontal", points: ["origin", ref] });
    else this.dim({ type: "distanceY", points: ["origin", ref], value: 0 }, src?.y && src.y.expr && p[1] > 0 ? src.y : Math.abs(p[1]));
  }

  shape(s: Raw, path: string): string {
    const construction = s.construction === true;
    const name = typeof s.name === "string" ? s.name : undefined;
    const want = typeof s.id === "string" ? s.id : undefined;
    if (s.polyline !== undefined) {
      this.polyline(s.polyline, s.closed !== false, construction, want, `${path}.polyline`);
      return "polyline";
    }
    if (s.rect !== undefined) {
      this.rect(s.rect, construction, name, want, `${path}.rect`);
      return "rect";
    }
    if (s.circle !== undefined) {
      this.circle(s.circle, construction, name, want, `${path}.circle`);
      return "circle";
    }
    if (s.slot !== undefined) {
      this.slot(s.slot, construction, name, want, `${path}.slot`);
      return "slot";
    }
    if (s.polygon !== undefined) {
      this.polygon(s.polygon, construction, name, want, `${path}.polygon`);
      return "polygon";
    }
    if (s.line !== undefined) {
      const l = isObject(s.line) ? s.line : {};
      const a = this.pt(l.from, `${path}.line.from`);
      const b = this.pt(l.to, `${path}.line.to`);
      if (dist2(a, b) < 1e-6) throw new ProfileError(`${path}.line: from and to are the same point`);
      const e = this.add({ id: this.id("l", want), type: "line", start: a, end: b }, construction);
      this.orient(e.id, a, b);
      return "line";
    }
    if (s.point !== undefined) {
      const at = this.pt(isObject(s.point) ? s.point.at : s.point, `${path}.point`);
      this.add({ id: this.id("p", want), type: "point", at }, false);
      return "point";
    }
    throw new ProfileError(`${path}: a shape is one of polyline, rect, circle, slot, polygon, line, point (got ${Object.keys(s).join(", ") || "nothing"})`);
  }

  private orient(id: string, a: Vec2, b: Vec2) {
    const len = dist2(a, b);
    if (Math.abs(b[1] - a[1]) <= 1e-9 * Math.max(1, len)) this.rel({ type: "horizontal", entity: id });
    else if (Math.abs(b[0] - a[0]) <= 1e-9 * Math.max(1, len)) this.rel({ type: "vertical", entity: id });
  }

  // ---------------------------------------------------------------- outlines

  /**
   * A chain of lines and arcs. Each vertex is [x, y], { "at": [x, y], "fillet": r } (that corner rounded), or an arc
   * to the next point: { "arcTo": [x, y], "center": [x, y] | "through": [x, y] | "tangent": true, "clockwise"?: bool }.
   */
  private polyline(raw: unknown, closed: boolean, construction: boolean, want: string | undefined, path: string, fillets: Num[] = []) {
    if (!Array.isArray(raw) || raw.length < 2) throw new ProfileError(`${path} must list at least two vertices`);
    const pts: Vec2[] = [];
    const arcs: (Raw | null)[] = [];
    const round: (Num | null)[] = [];
    raw.forEach((v, i) => {
      const at = `${path}[${i}]`;
      if (Array.isArray(v)) {
        pts.push(this.pt(v, at));
        arcs.push(null);
        round.push(fillets[i] ?? null);
      } else if (isObject(v) && v.arcTo !== undefined) {
        if (i === 0) throw new ProfileError(`${at}: the first vertex is where the chain starts; an arc can only go to a later one`);
        pts.push(this.pt(v.arcTo, `${at}.arcTo`));
        arcs.push(v);
        round.push(null);
      } else if (isObject(v) && v.at !== undefined) {
        pts.push(this.pt(v.at, `${at}.at`));
        arcs.push(null);
        round.push(v.fillet !== undefined ? this.num(v.fillet, `${at}.fillet`, { positive: true }) : (fillets[i] ?? null));
      } else throw new ProfileError(`${at} must be [x, y], { "at": [x, y], "fillet"?: r } or { "arcTo": [x, y], "center" | "through" | "tangent" }`);
    });
    // A closed chain may repeat its first point at the end (needed when the closing piece is an arc).
    let n = pts.length;
    if (closed && n > 2 && dist2(pts[0], pts[n - 1]) < 1e-9) {
      if (arcs[n - 1]) arcs[0] = arcs[n - 1];
      pts.pop();
      arcs.pop();
      round.pop();
      n--;
    } else if (closed) arcs[0] = null;
    if (closed && n < 2) throw new ProfileError(`${path}: a closed outline needs at least two points`);
    if (closed && n === 2 && !arcs[0] && !arcs[1]) throw new ProfileError(`${path}: two points and straight lines enclose nothing`);
    // Segment i runs from point i to point i+1 (the last back to point 0 when closed); arcs[i+1] says how.
    const segs: Seg[] = [];
    const count = closed ? n : n - 1;
    for (let i = 0; i < count; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const how = arcs[(i + 1) % n];
      if (dist2(a, b) < 1e-6) throw new ProfileError(`${path}: vertices ${i} and ${(i + 1) % n} are the same point`);
      if (!how) segs.push({ kind: "line", a, b });
      else segs.push(this.arcSeg(a, b, how, segs[segs.length - 1] ?? null, `${path}[${(i + 1) % n}]`));
    }
    if (closed && segs[0].kind === "arc" && segs[0].tangentIn && segs.length > 1) {
      // The closing piece is known only now: a tangent first arc follows it.
      segs[0] = this.arcSeg(segs[0].a, segs[0].b, { tangent: true }, segs[segs.length - 1], `${path}[0]`);
    }
    // Rounded corners: between two lines only.
    const corner: (Num | null)[] = segs.map(() => null);
    for (let v = 0; v < n; v++) {
      const r = round[v];
      if (!r) continue;
      const inSeg = closed ? (v - 1 + segs.length) % segs.length : v - 1;
      const outSeg = v;
      if (inSeg < 0 || outSeg >= segs.length) throw new ProfileError(`${path}[${v}]: the end of an open chain has no corner to round`);
      if (segs[inSeg].kind !== "line" || segs[outSeg].kind !== "line") throw new ProfileError(`${path}[${v}]: only a corner between two straight lines can be rounded`);
      corner[outSeg] = r;
    }
    this.chain(segs, closed, corner, construction, want, path);
  }

  private arcSeg(a: Vec2, b: Vec2, how: Raw, prev: Seg | null, path: string): Seg {
    if (how.center !== undefined) {
      const c = this.pt(how.center, `${path}.center`);
      const ra = dist2(a, c);
      const rb = dist2(b, c);
      if (Math.abs(ra - rb) > 1e-6 * Math.max(1, ra)) throw new ProfileError(`${path}: the arc's start and end are not the same distance from its center (${r6(ra)} and ${r6(rb)})`);
      // Default: the shorter way round; "clockwise" chooses.
      const cw = typeof how.clockwise === "boolean" ? how.clockwise : cross2(sub2(a, c), sub2(b, c)) < 0;
      return { kind: "arc", a, b, c, cw };
    }
    if (how.through !== undefined) {
      const m = this.pt(how.through, `${path}.through`);
      const c = circumcentre(a, m, b);
      if (!c) throw new ProfileError(`${path}: the arc's three points are on one line`);
      // Counter-clockwise when the middle point is on the right of start-to-end, clockwise when on its left.
      return { kind: "arc", a, b, c, cw: cross2(sub2(b, a), sub2(m, a)) > 0 };
    }
    if (how.tangent === true) {
      if (!prev) return { kind: "arc", a, b, c: a, cw: false, tangentIn: true };
      const t = prev.kind === "line" ? norm(sub2(prev.b, prev.a)) : arcEndTangent(prev);
      const nrm: Vec2 = [-t[1], t[0]];
      const chord = sub2(b, a);
      const k = dot2(nrm, chord);
      if (Math.abs(k) < 1e-9) throw new ProfileError(`${path}: a tangent arc can't end straight ahead of where it starts; that is a line`);
      const r = dot2(chord, chord) / (2 * k);
      const c = add2(a, scale2(nrm, r));
      return { kind: "arc", a, b, c, cw: r < 0, tangentIn: true };
    }
    throw new ProfileError(`${path}: an arc needs "center", "through" or "tangent": true`);
  }

  /** Lines and arcs end to end, corners rounded, with their relations. */
  private chain(segs: Seg[], closed: boolean, corner: (Num | null)[], construction: boolean, want: string | undefined, path: string) {
    // Trim lines back for the rounded corners: corner[i] rounds the joint at the start of segment i.
    const trimmed = segs.map((s) => ({ ...s }));
    const fillets: { at: number; c: Vec2; a: Vec2; b: Vec2; cw: boolean; r: Num }[] = [];
    for (let i = 0; i < segs.length; i++) {
      const r = corner[i];
      if (!r) continue;
      const prevI = (i - 1 + segs.length) % segs.length;
      const p = segs[i].a;
      const u = norm(sub2(segs[prevI].b, segs[prevI].a));
      const v = norm(sub2(segs[i].b, segs[i].a));
      const turn = cross2(u, v);
      const cos = Math.max(-1, Math.min(1, dot2(scale2(u, -1), v)));
      const opening = Math.acos(cos);
      if (Math.abs(turn) < 1e-9) throw new ProfileError(`${path}: the corner at [${p.join(", ")}] is straight; there is nothing to round`);
      const t = r.value / Math.tan(opening / 2);
      const lenIn = dist2(trimmed[prevI].a, trimmed[prevI].b);
      const lenOut = dist2(trimmed[i].a, trimmed[i].b);
      if (t >= lenIn - 1e-9 || t >= lenOut - 1e-9) throw new ProfileError(`${path}: a fillet of ${r6(r.value)} at [${p.join(", ")}] needs ${r6(t)} of each side, more than the sides have; use a smaller radius`);
      const a = sub2(p, scale2(u, t));
      const b = add2(p, scale2(v, t));
      trimmed[prevI].b = a;
      trimmed[i].a = b;
      const bis = norm(sub2(v, u));
      const c = add2(p, scale2(bis, r.value / Math.sin(opening / 2)));
      fillets.push({ at: i, c, a, b, cw: turn < 0, r });
    }
    // The pieces in order: each segment, with its corner's fillet arc before it.
    type Piece = { id: string; kind: "line" | "arc"; tangentPrev: boolean };
    const pieces: Piece[] = [];
    const filletIds: { id: string; r: Num }[] = [];
    let n = 0;
    const pid = (prefix: string) => (want ? this.id(prefix, `${want}_${++n}`) : this.id(prefix));
    for (let i = 0; i < trimmed.length; i++) {
      const f = fillets.find((x) => x.at === i);
      if (f) {
        // Runs the chain's way: from where it leaves the incoming line to where it joins the outgoing one.
        const e = this.add({ id: pid("a"), type: "arc", center: f.c, start: f.a, end: f.b, ...(f.cw ? { clockwise: true } : {}) } as SketchEntity, construction);
        pieces.push({ id: e.id, kind: "arc", tangentPrev: true });
        // One radius dimension per size; the other fillets of that size are equal to the first.
        const same = filletIds.find((x) => x.r.value === f.r.value && x.r.expr === f.r.expr);
        if (same) this.rel({ type: "equal", entities: [same.id, e.id] });
        else this.dim({ type: "radius", entity: e.id, value: 0 }, f.r);
        filletIds.push({ id: e.id, r: f.r });
      }
      const s = trimmed[i];
      if (s.kind === "line") {
        const e = this.add({ id: pid("l"), type: "line", start: s.a, end: s.b }, construction);
        this.orient(e.id, s.a, s.b);
        pieces.push({ id: e.id, kind: "line", tangentPrev: !!f });
      } else {
        // An arc entity runs counter-clockwise from start to end unless clockwise; its ends follow the chain's direction.
        const e = this.add({ id: pid("a"), type: "arc", center: s.c, start: s.a, end: s.b, ...(s.cw ? { clockwise: true } : {}) } as SketchEntity, construction);
        pieces.push({ id: e.id, kind: "arc", tangentPrev: !!s.tangentIn || !!f });
      }
    }
    // Joints: each piece's end on the next one's start (arcs run the chain's way); tangent where an arc runs on smoothly.
    const endOf = (p: Piece) => `${p.id}.end`;
    const startOf = (p: Piece) => `${p.id}.start`;
    for (let i = 0; i < pieces.length; i++) {
      if (!closed && i === pieces.length - 1) break;
      const p = pieces[i];
      const q = pieces[(i + 1) % pieces.length];
      if (p === q) break;
      this.rel({ type: "coincident", points: [endOf(p), startOf(q)] });
      if (q.tangentPrev && (p.kind === "arc" || q.kind === "arc")) this.rel({ type: "tangent", entities: [p.id, q.id] });
    }
  }

  // ---------------------------------------------------------------- shapes

  private rect(raw: unknown, construction: boolean, name: string | undefined, want: string | undefined, path: string) {
    if (!isObject(raw)) throw new ProfileError(`${path} must be { "center" | "corner": [x, y], "width", "height", "fillet"? }`);
    const w = this.num(raw.width, `${path}.width`, { positive: true });
    const h = this.num(raw.height, `${path}.height`, { positive: true });
    if ((raw.center === undefined) === (raw.corner === undefined)) throw new ProfileError(`${path}: give "center" or "corner" (its lower left), not both`);
    const centred = raw.center !== undefined;
    const cRaw = (centred ? raw.center : raw.corner) as unknown[];
    const at = this.pt(cRaw, `${path}.${centred ? "center" : "corner"}`);
    const src = Array.isArray(cRaw) ? { x: this.num(cRaw[0], `${path}.x`), y: this.num(cRaw[1], `${path}.y`) } : undefined;
    const bl: Vec2 = centred ? [at[0] - w.value / 2, at[1] - h.value / 2] : at;
    const corners: Vec2[] = [bl, [bl[0] + w.value, bl[1]], [bl[0] + w.value, bl[1] + h.value], [bl[0], bl[1] + h.value]];
    const fillet = raw.fillet !== undefined ? this.num(raw.fillet, `${path}.fillet`, { positive: true }) : null;
    const first = this.entities.length;
    this.polyline(corners, true, construction, want, path, fillet ? [fillet, fillet, fillet, fillet] : []);
    const made = this.entities.slice(first);
    const lines = made.filter((e) => e.type === "line");
    // Bottom, right, top, left: width between the left and right sides, height between bottom and top.
    const [bottom, right, , left] = lines;
    this.dim({ type: "distance", lines: [left.id, right.id], value: 0 } as Constraint & { value: number }, w, name ? `${name}_w` : undefined);
    this.dim({ type: "distance", lines: [bottom.id, lines[2].id], value: 0 } as Constraint & { value: number }, h, name ? `${name}_h` : undefined);
    // Where it is: its centre (on a construction diagonal) or its lower left corner.
    const arcs = made.filter((e) => e.type === "arc") as Extract<SketchEntity, { type: "arc" }>[];
    if (centred) {
      const from = arcs.length ? `${arcs[0].id}.center` : `${bottom.id}.start`;
      const to = arcs.length ? `${arcs[2].id}.center` : `${right.id}.end`;
      const pa = arcs.length ? arcs[0].center : corners[0];
      const pb = arcs.length ? arcs[2].center : corners[2];
      const diag = this.add({ id: this.id("l"), type: "line", start: pa, end: pb }, true);
      this.rel({ type: "coincident", points: [`${diag.id}.start`, from] });
      this.rel({ type: "coincident", points: [`${diag.id}.end`, to] });
      const p = this.add({ id: this.id("p"), type: "point", at: [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2] }, false);
      this.rel({ type: "midpoint", point: `${p.id}.at`, entity: diag.id });
      this.place(`${p.id}.at`, p.at, src);
    } else if (!arcs.length) {
      this.place(`${bottom.id}.start`, corners[0], src);
    }
  }

  private circle(raw: unknown, construction: boolean, name: string | undefined, want: string | undefined, path: string) {
    if (!isObject(raw)) throw new ProfileError(`${path} must be { "center": [x, y], "diameter" | "radius" }`);
    const cRaw = raw.center as unknown[];
    const c = this.pt(cRaw ?? [0, 0], `${path}.center`);
    const src = Array.isArray(cRaw) ? { x: this.num(cRaw[0], `${path}.center[0]`), y: this.num(cRaw[1], `${path}.center[1]`) } : undefined;
    if ((raw.diameter === undefined) === (raw.radius === undefined)) throw new ProfileError(`${path}: give "diameter" or "radius"`);
    const e = this.add(
      { id: this.id("c", want), type: "circle", center: c, radius: raw.diameter !== undefined ? this.num(raw.diameter, `${path}.diameter`, { positive: true }).value / 2 : this.num(raw.radius, `${path}.radius`, { positive: true }).value },
      construction,
    );
    if (raw.diameter !== undefined) this.dim({ type: "diameter", entity: e.id, value: 0 }, this.num(raw.diameter, `${path}.diameter`), name);
    else this.dim({ type: "radius", entity: e.id, value: 0 }, this.num(raw.radius, `${path}.radius`), name);
    this.place(`${e.id}.center`, c, src);
  }

  private slot(raw: unknown, construction: boolean, name: string | undefined, want: string | undefined, path: string) {
    if (!isObject(raw)) throw new ProfileError(`${path} must be { "from": [x, y], "to": [x, y], "width" } (the two arc centres)`);
    const a = this.pt(raw.from, `${path}.from`);
    const b = this.pt(raw.to, `${path}.to`);
    const w = this.num(raw.width, `${path}.width`, { positive: true });
    const L = dist2(a, b);
    if (L < 1e-6) throw new ProfileError(`${path}: from and to are the same point; use a circle`);
    const u = norm(sub2(b, a));
    const nrm: Vec2 = [-u[1], u[0]];
    const r = w.value / 2;
    const off = (p: Vec2, s: number) => add2(p, scale2(nrm, s * r));
    let n = 0;
    const pid = (prefix: string) => (want ? this.id(prefix, `${want}_${++n}`) : this.id(prefix));
    const cl = this.add({ id: pid("l"), type: "line", start: a, end: b }, true);
    const l1 = this.add({ id: pid("l"), type: "line", start: off(a, -1), end: off(b, -1) }, construction);
    const a1 = this.add({ id: pid("a"), type: "arc", center: b, start: off(b, -1), end: off(b, 1) }, construction);
    const l2 = this.add({ id: pid("l"), type: "line", start: off(b, 1), end: off(a, 1) }, construction);
    const a2 = this.add({ id: pid("a"), type: "arc", center: a, start: off(a, 1), end: off(a, -1) }, construction);
    this.rel({ type: "coincident", points: [`${l1.id}.end`, `${a1.id}.start`] });
    this.rel({ type: "coincident", points: [`${a1.id}.end`, `${l2.id}.start`] });
    this.rel({ type: "coincident", points: [`${l2.id}.end`, `${a2.id}.start`] });
    this.rel({ type: "coincident", points: [`${a2.id}.end`, `${l1.id}.start`] });
    for (const l of [l1, l2]) for (const arc of [a1, a2]) this.rel({ type: "tangent", entities: [l.id, arc.id] });
    this.rel({ type: "equal", entities: [a1.id, a2.id] });
    this.rel({ type: "coincident", points: [`${cl.id}.end`, `${a1.id}.center`] });
    this.rel({ type: "coincident", points: [`${cl.id}.start`, `${a2.id}.center`] });
    this.orient(cl.id, a, b);
    const len = raw.length !== undefined ? this.num(raw.length, `${path}.length`, { positive: true }) : { value: L };
    if (Math.abs(len.value - L) > 1e-6) throw new ProfileError(`${path}: length ${len.value} is not the distance from "from" to "to" (${r6(L)})`);
    this.dim({ type: "distance", entity: cl.id, value: 0 }, len, name ? `${name}_len` : undefined);
    this.dim({ type: "radius", entity: a1.id, value: 0 }, w.expr ? { value: r, expr: `=(${w.expr.slice(1)}) / 2` } : r, name ? `${name}_r` : undefined);
    const fromRaw = raw.from as unknown[];
    this.place(`${cl.id}.start`, a, Array.isArray(fromRaw) ? { x: this.num(fromRaw[0], `${path}.from[0]`), y: this.num(fromRaw[1], `${path}.from[1]`) } : undefined);
  }

  private polygon(raw: unknown, construction: boolean, name: string | undefined, want: string | undefined, path: string) {
    if (!isObject(raw)) throw new ProfileError(`${path} must be { "center": [x, y], "sides", "diameter" (across corners) | "acrossFlats", "angle"? }`);
    const c = this.pt(raw.center ?? [0, 0], `${path}.center`);
    const sides = raw.sides;
    if (typeof sides !== "number" || !Number.isInteger(sides) || sides < 3 || sides > 40) throw new ProfileError(`${path}.sides must be a whole number from 3 to 40`);
    if ((raw.diameter === undefined) === (raw.acrossFlats === undefined)) throw new ProfileError(`${path}: give "diameter" (across corners) or "acrossFlats"`);
    const flats = raw.acrossFlats !== undefined ? this.num(raw.acrossFlats, `${path}.acrossFlats`, { positive: true }) : null;
    if (flats && sides % 2 === 1) throw new ProfileError(`${path}: "acrossFlats" needs an even number of sides; give "diameter" for ${sides}`);
    const dia = flats ?{ value: flats.value / Math.cos(Math.PI / sides) } : this.num(raw.diameter, `${path}.diameter`, { positive: true });
    const R = dia.value / 2;
    // A flat at the bottom by default; "angle" turns it (degrees, counter-clockwise).
    const turn = raw.angle !== undefined ? (this.num(raw.angle, `${path}.angle`).value * Math.PI) / 180 : 0;
    const start = -Math.PI / 2 - Math.PI / sides + turn;
    const corners: Vec2[] = Array.from({ length: sides }, (_, k) => [c[0] + R * Math.cos(start + (2 * Math.PI * k) / sides), c[1] + R * Math.sin(start + (2 * Math.PI * k) / sides)]);
    let n = 0;
    const pid = (prefix: string) => (want ? this.id(prefix, `${want}_${++n}`) : this.id(prefix));
    const circle = this.add({ id: pid("c"), type: "circle", center: c, radius: R }, true);
    const lines = corners.map((p, k) => this.add({ id: pid("l"), type: "line", start: p, end: corners[(k + 1) % sides] }, construction));
    lines.forEach((l, k) => {
      this.rel({ type: "coincident", points: [`${l.id}.end`, `${lines[(k + 1) % sides].id}.start`] });
      this.rel({ type: "pointOn", point: `${l.id}.start`, entity: circle.id });
      if (k > 0) this.rel({ type: "equal", entities: [lines[0].id, l.id] });
    });
    this.orient(lines[0].id, lines[0].start, lines[0].end);
    if (flats) this.dim({ type: "distance", lines: [lines[0].id, lines[Math.floor(sides / 2)].id], value: 0 } as Constraint & { value: number }, flats, name);
    else this.dim({ type: "diameter", entity: circle.id, value: 0 }, dia, name);
    this.place(`${circle.id}.center`, c);
  }
}

function norm(v: Vec2): Vec2 {
  const l = len2(v);
  return [v[0] / l, v[1] / l];
}

function arcEndTangent(s: Extract<Seg, { kind: "arc" }>): Vec2 {
  const rad = norm(sub2(s.b, s.c));
  return s.cw ? [rad[1], -rad[0]] : [-rad[1], rad[0]];
}

function circumcentre(a: Vec2, b: Vec2, c: Vec2): Vec2 | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = dot2(a, a);
  const b2 = dot2(b, b);
  const c2 = dot2(c, c);
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}

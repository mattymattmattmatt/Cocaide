// 2D geometry for DXF entities (src/io/dxf.ts): bulges and arcs, NURBS
// evaluation, sampling curves into polylines, the affine maps an INSERT puts
// a block's entities through, bounds, and chaining lines and arcs into
// closed polylines (what laser and plasma CAM wants: one contour per cut).
// Pure: no DOM, no kernel. Angles in DXF entities are degrees (arcs) or
// radians (ellipse parameters), as the DXF format has them.

import type { DxfEntity, Vec2 } from "./dxf";

export const TAU = 2 * Math.PI;
const DEG = Math.PI / 180;

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const polar = (c: Vec2, r: number, angle: number): Vec2 => [c[0] + r * Math.cos(angle), c[1] + r * Math.sin(angle)];

/** An angle in [0, 2π). */
export function wrap(a: number): number {
  const w = a % TAU;
  return w < 0 ? w + TAU : w;
}

/** Degrees in [0, 360). */
export function wrapDeg(a: number): number {
  const w = a % 360;
  return w < 0 ? w + 360 : w;
}

/** How far counter-clockwise from `start` to `end` (degrees), in (0, 360]: equal angles are a whole turn. */
export function ccwSpanDeg(start: number, end: number): number {
  const s = wrapDeg(end - start);
  return s < 1e-12 ? 360 : s;
}

/** The arc a polyline segment with this bulge makes from a to b: centre, radius, start and end angles (degrees, counter-clockwise). */
export function bulgeArc(a: Vec2, b: Vec2, bulge: number): { c: Vec2; r: number; start: number; end: number } {
  const chord = dist(a, b);
  const theta = 4 * Math.atan(bulge); // signed included angle
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  // The centre sits on the chord's perpendicular bisector, to the left for a counter-clockwise (positive) bulge.
  const mid = mul(add(a, b), 0.5);
  const u = mul(sub(b, a), 1 / chord);
  const left: Vec2 = [-u[1], u[0]];
  const h = (chord / 2) / Math.tan(theta / 2); // signed: a bulge over 1 puts the centre on the other side
  const c = add(mid, mul(left, h));
  const sa = Math.atan2(a[1] - c[1], a[0] - c[0]) / DEG;
  const sb = Math.atan2(b[1] - c[1], b[0] - c[0]) / DEG;
  return bulge > 0 ? { c, r, start: wrapDeg(sa), end: wrapDeg(sb) } : { c, r, start: wrapDeg(sb), end: wrapDeg(sa) };
}

/** The bulge of an arc run from `from` to `to` through `sweep` radians (positive counter-clockwise). */
export function sweepBulge(sweep: number): number {
  return Math.tan(sweep / 4);
}

/** An arc's ends: its point at the start angle and at the end angle. */
export function arcEnds(c: Vec2, r: number, startDeg: number, endDeg: number): [Vec2, Vec2] {
  return [polar(c, r, startDeg * DEG), polar(c, r, endDeg * DEG)];
}

/** The minor semi-axis vector of a DXF ellipse: the major turned a quarter left, times the ratio. */
export function ellipseMinor(major: Vec2, ratio: number): Vec2 {
  return [-major[1] * ratio, major[0] * ratio];
}

export function ellipsePoint(c: Vec2, major: Vec2, ratio: number, t: number): Vec2 {
  const minor = ellipseMinor(major, ratio);
  return [c[0] + Math.cos(t) * major[0] + Math.sin(t) * minor[0], c[1] + Math.cos(t) * major[1] + Math.sin(t) * minor[1]];
}

/** The ellipse parameter of a point on it (or nearest to its direction). */
export function ellipseParam(c: Vec2, major: Vec2, ratio: number, p: Vec2): number {
  const a = len(major);
  const u = mul(major, 1 / a);
  const d = sub(p, c);
  const x = d[0] * u[0] + d[1] * u[1];
  const y = -d[0] * u[1] + d[1] * u[0];
  return wrap(Math.atan2(y / (a * ratio), x / a));
}

// ---------------------------------------------------------------- NURBS

/** The knot span index for t (de Boor), for a clamped or open knot vector. */
function findSpan(n: number, p: number, t: number, U: number[]): number {
  if (t >= U[n + 1]) return n;
  if (t <= U[p]) return p;
  let lo = p;
  let hi = n + 1;
  let mid = (lo + hi) >> 1;
  while (t < U[mid] || t >= U[mid + 1]) {
    if (t < U[mid]) hi = mid;
    else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}

/** A point of a (rational) B-spline curve at parameter t, by de Boor's algorithm. */
export function nurbsPoint(degree: number, knots: number[], control: Vec2[], weights: number[] | undefined, t: number): Vec2 {
  const n = control.length - 1;
  const p = Math.min(degree, n);
  const k = findSpan(n, p, t, knots);
  const d: [number, number, number][] = [];
  for (let j = 0; j <= p; j++) {
    const i = k - p + j;
    const w = weights?.[i] ?? 1;
    d.push([control[i][0] * w, control[i][1] * w, w]);
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = k - p + j;
      const den = knots[i + p - r + 1] - knots[i];
      const alpha = den === 0 ? 0 : (t - knots[i]) / den;
      for (let q = 0; q < 3; q++) d[j][q] = (1 - alpha) * d[j - 1][q] + alpha * d[j][q];
    }
  }
  const [x, y, w] = d[p];
  return [x / w, y / w];
}

/** The parameter range a spline's knots cover: [knots[degree], knots[n + 1]]. */
export function nurbsRange(degree: number, knots: number[], count: number): [number, number] {
  return [knots[degree], knots[count]];
}

// --------------------------------------------------------------- sampling

/** Points along an arc (degrees, counter-clockwise), so no chord strays more than `tol` from it. */
export function sampleArc(c: Vec2, r: number, startDeg: number, endDeg: number, tol = 0.01): Vec2[] {
  const sweep = ccwSpanDeg(startDeg, endDeg) * DEG;
  const step = r > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / r)) : Math.PI / 2;
  const n = Math.max(2, Math.ceil(sweep / Math.max(step, 1e-3)));
  return Array.from({ length: n + 1 }, (_, i) => polar(c, r, startDeg * DEG + (sweep * i) / n));
}

/** Points along a DXF ellipse (or its arc), within `tol`. */
export function sampleEllipse(e: Extract<DxfEntity, { type: "ellipse" }>, tol = 0.01): Vec2[] {
  const a = len(e.major);
  const span = wrap(e.end - e.start) < 1e-12 ? TAU : wrap(e.end - e.start);
  // The tightest bend is at the major ends: radius b²/a.
  const b = a * e.ratio;
  const rMin = Math.max((b * b) / a, 1e-6);
  const step = rMin > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / rMin)) : Math.PI / 2;
  const n = Math.max(4, Math.ceil(span / Math.max(step, 1e-3)));
  return Array.from({ length: n + 1 }, (_, i) => ellipsePoint(e.c, e.major, e.ratio, e.start + (span * i) / n));
}

/** Points along a DXF spline: its fit points if it has nothing else, else its curve sampled until the chords are within `tol`. */
export function sampleSpline(e: Extract<DxfEntity, { type: "spline" }>, tol = 0.01): Vec2[] {
  if (e.control.length < 2) return e.fit ? [...e.fit] : [...e.control];
  const [t0, t1] = nurbsRange(e.degree, e.knots, e.control.length);
  const at = (t: number) => nurbsPoint(e.degree, e.knots, e.control, e.weights, t);
  // Start from the knot spans, then halve any chord whose middle strays too far.
  const ts = [...new Set(e.knots.filter((k) => k >= t0 && k <= t1))].sort((x, y) => x - y);
  if (ts.length < 2) ts.splice(0, ts.length, t0, t1);
  let params: number[] = [];
  for (let i = 0; i + 1 < ts.length; i++) for (let j = 0; j < 4; j++) params.push(ts[i] + ((ts[i + 1] - ts[i]) * j) / 4);
  params.push(t1);
  for (let pass = 0; pass < 8; pass++) {
    const next: number[] = [params[0]];
    let split = false;
    for (let i = 1; i < params.length; i++) {
      const a = at(params[i - 1]);
      const b = at(params[i]);
      const mid = (params[i - 1] + params[i]) / 2;
      const m = at(mid);
      const chord = sub(b, a);
      const l = len(chord);
      const off = l < 1e-12 ? dist(m, a) : Math.abs((m[0] - a[0]) * chord[1] - (m[1] - a[1]) * chord[0]) / l;
      if (off > tol && params[i] - params[i - 1] > 1e-9) {
        next.push(mid);
        split = true;
      }
      next.push(params[i]);
    }
    params = next;
    if (!split || params.length > 4000) break;
  }
  return params.map(at);
}

/** The points of a polyline with bulges, its arcs sampled within `tol`. */
export function samplePolyline(e: Extract<DxfEntity, { type: "polyline" }>, tol = 0.01): Vec2[] {
  const pts = e.points;
  const count = e.closed ? pts.length : pts.length - 1;
  const out: Vec2[] = [pts[0]];
  for (let i = 0; i < count; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const bulge = e.bulges?.[i] ?? 0;
    if (Math.abs(bulge) < 1e-12 || dist(a, b) < 1e-12) {
      out.push(b);
      continue;
    }
    const arc = bulgeArc(a, b, bulge);
    const s = sampleArc(arc.c, arc.r, arc.start, arc.end, tol);
    if (bulge < 0) s.reverse();
    out.push(...s.slice(1));
  }
  return out;
}

/** Any curve entity as points (a circle closes on itself); [] for a point or text. */
export function entityPoints(e: DxfEntity, tol = 0.01): Vec2[] {
  switch (e.type) {
    case "line":
      return [e.a, e.b];
    case "circle":
      return sampleArc(e.c, e.r, 0, 360, tol);
    case "arc":
      return sampleArc(e.c, e.r, e.start, e.end, tol);
    case "polyline":
      return samplePolyline(e, tol);
    case "ellipse":
      return sampleEllipse(e, tol);
    case "spline":
      return sampleSpline(e, tol);
    default:
      return [];
  }
}

// ----------------------------------------------------------------- bounds

export interface Box2 {
  min: Vec2;
  max: Vec2;
}

/** The box around the entities (text by its insertion point and a rough width), or null when there is nothing. */
export function boundsOf(entities: DxfEntity[]): Box2 | null {
  let min: Vec2 = [Infinity, Infinity];
  let max: Vec2 = [-Infinity, -Infinity];
  const take = (p: Vec2) => {
    min = [Math.min(min[0], p[0]), Math.min(min[1], p[1])];
    max = [Math.max(max[0], p[0]), Math.max(max[1], p[1])];
  };
  for (const e of entities) {
    if (e.type === "point") take(e.at);
    else if (e.type === "text") {
      take(e.at);
      take([e.at[0] + e.height * 0.6 * e.text.length, e.at[1] + e.height]);
    } else if (e.type === "circle") {
      take([e.c[0] - e.r, e.c[1] - e.r]);
      take([e.c[0] + e.r, e.c[1] + e.r]);
    } else for (const p of entityPoints(e, 1e-3)) take(p);
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

// ------------------------------------------------------------ transforms

/** x' = a·x + b·y + e, y' = c·x + d·y + f. */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function apply(m: Affine, p: Vec2): Vec2 {
  return [m.a * p[0] + m.b * p[1] + m.e, m.c * p[0] + m.d * p[1] + m.f];
}

/** m after n: first n, then m. */
export function compose(m: Affine, n: Affine): Affine {
  return {
    a: m.a * n.a + m.b * n.c,
    b: m.a * n.b + m.b * n.d,
    c: m.c * n.a + m.d * n.c,
    d: m.c * n.b + m.d * n.d,
    e: m.a * n.e + m.b * n.f + m.e,
    f: m.c * n.e + m.d * n.f + m.f,
  };
}

/** Translate, then rotate (degrees) and scale about the origin: what an INSERT does to a block (after taking off its base point). */
export function placement(at: Vec2, sx: number, sy: number, rotationDeg: number): Affine {
  const r = rotationDeg * DEG;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { a: cos * sx, b: -sin * sy, c: sin * sx, d: cos * sy, e: at[0], f: at[1] };
}

export function translation(v: Vec2): Affine {
  return { ...IDENTITY, e: v[0], f: v[1] };
}

const det = (m: Affine) => m.a * m.d - m.b * m.c;

/** True when the map keeps circles circles (a rotation and one scale, maybe mirrored). */
export function isSimilarity(m: Affine): boolean {
  const s1 = Math.hypot(m.a, m.c);
  const s2 = Math.hypot(m.b, m.d);
  const dot = m.a * m.b + m.c * m.d;
  return Math.abs(s1 - s2) <= 1e-9 * Math.max(1, s1) && Math.abs(dot) <= 1e-9 * Math.max(1, s1 * s2);
}

/** The counter-clockwise arc (degrees) through three points of a circle: from p to q, passing m. */
function arcThrough(c: Vec2, p: Vec2, m: Vec2, q: Vec2): { start: number; end: number } {
  const ang = (x: Vec2) => wrapDeg(Math.atan2(x[1] - c[1], x[0] - c[0]) / DEG);
  const a = ang(p);
  const b = ang(q);
  const mid = ang(m);
  // m must lie counter-clockwise between start and end; otherwise the arc runs the other way.
  return ccwSpanDeg(a, mid) < ccwSpanDeg(a, b) ? { start: a, end: b } : { start: b, end: a };
}

/**
 * The entity put through an affine map. A circle or arc stays one when the
 * map keeps circles round, else it becomes an ellipse; a polyline's bulges
 * flip with a mirror, and under a stretch its arcs are drawn as ellipse arcs
 * (the polyline comes apart into lines and ellipses).
 */
export function transformEntity(e: DxfEntity, m: Affine): DxfEntity[] {
  const scale = Math.sqrt(Math.abs(det(m)));
  const similar = isSimilarity(m);
  const mirrored = det(m) < 0;
  const layer = e.layer;
  const keep = <T extends DxfEntity>(x: T): T => (layer !== undefined ? { ...x, layer } : x);
  switch (e.type) {
    case "line":
      return [keep({ type: "line", a: apply(m, e.a), b: apply(m, e.b) })];
    case "point":
      return [keep({ type: "point", at: apply(m, e.at) })];
    case "text": {
      const dir = apply({ ...m, e: 0, f: 0 }, polar([0, 0], 1, (e.rotation ?? 0) * DEG));
      return [keep({ ...e, at: apply(m, e.at), height: e.height * scale, rotation: wrapDeg(Math.atan2(dir[1], dir[0]) / DEG) })];
    }
    case "circle":
      if (similar) return [keep({ type: "circle", c: apply(m, e.c), r: e.r * scale })];
      return [keep(circleImage(m, e.c, e.r, 0, TAU, true))];
    case "arc": {
      if (similar) {
        const c = apply(m, e.c);
        const [p, q] = arcEnds(e.c, e.r, e.start, e.end);
        const mid = polar(e.c, e.r, (e.start + ccwSpanDeg(e.start, e.end) / 2) * DEG);
        const span = arcThrough(c, apply(m, p), apply(m, mid), apply(m, q));
        return [keep({ type: "arc", c, r: e.r * scale, ...span })];
      }
      return [keep(circleImage(m, e.c, e.r, e.start * DEG, e.start * DEG + ccwSpanDeg(e.start, e.end) * DEG, false))];
    }
    case "ellipse":
      return [keep(ellipseImage(m, e))];
    case "polyline": {
      if (similar || !(e.bulges ?? []).some((b) => Math.abs(b) > 1e-12)) {
        const points = e.points.map((p) => apply(m, p));
        const bulges = e.bulges && mirrored ? e.bulges.map((b) => -b) : e.bulges;
        return [keep({ type: "polyline", points, ...(bulges ? { bulges } : {}), ...(e.closed ? { closed: true } : {}) })];
      }
      return explodePolyline(e).flatMap((x) => transformEntity(x, m));
    }
    case "spline":
      // A B-spline's affine image is the B-spline of its control points' images.
      return [keep({ ...e, control: e.control.map((p) => apply(m, p)), ...(e.fit ? { fit: e.fit.map((p) => apply(m, p)) } : {}) })];
  }
}

/** A polyline as its lines and arcs, each on the polyline's layer. */
export function explodePolyline(e: Extract<DxfEntity, { type: "polyline" }>): DxfEntity[] {
  const out: DxfEntity[] = [];
  const n = e.points.length;
  const count = e.closed ? n : n - 1;
  const layer = e.layer !== undefined ? { layer: e.layer } : {};
  for (let i = 0; i < count; i++) {
    const a = e.points[i];
    const b = e.points[(i + 1) % n];
    if (dist(a, b) < 1e-12) continue;
    const bulge = e.bulges?.[i] ?? 0;
    if (Math.abs(bulge) < 1e-12) out.push({ type: "line", a, b, ...layer });
    else out.push({ type: "arc", ...bulgeArc(a, b, bulge), ...layer });
  }
  return out;
}

/** The image of a circle (or the arc from t0 to t1 radians, counter-clockwise) under a map that stretches it into an ellipse. */
function circleImage(m: Affine, c: Vec2, r: number, t0: number, t1: number, whole: boolean): Extract<DxfEntity, { type: "ellipse" }> {
  // Write the circle as an ellipse with equal axes, then map it.
  return ellipseImage(m, { type: "ellipse", c, major: [r, 0], ratio: 1, start: whole ? 0 : t0, end: whole ? TAU : t1 });
}

/**
 * The image of an ellipse under an affine map: its conjugate semi-diameters
 * map to conjugate semi-diameters, from which the principal axes follow.
 */
function ellipseImage(m: Affine, e: Extract<DxfEntity, { type: "ellipse" }>): Extract<DxfEntity, { type: "ellipse" }> {
  const lin = { ...m, e: 0, f: 0 };
  const P = apply(lin, e.major);
  const Q = apply(lin, ellipseMinor(e.major, e.ratio));
  const c = apply(m, e.c);
  // Point at parameter t: c + cos t·P + sin t·Q. The axes are at the t where |...| is extreme: tan 2t = 2P·Q / (P·P − Q·Q).
  const pp = P[0] * P[0] + P[1] * P[1];
  const qq = Q[0] * Q[0] + Q[1] * Q[1];
  const pq = P[0] * Q[0] + P[1] * Q[1];
  const t0 = 0.5 * Math.atan2(2 * pq, pp - qq);
  const at = (t: number): Vec2 => [Math.cos(t) * P[0] + Math.sin(t) * Q[0], Math.cos(t) * P[1] + Math.sin(t) * Q[1]];
  let A = at(t0);
  let B = at(t0 + Math.PI / 2);
  if (len(B) > len(A)) [A, B] = [B, A];
  const ratio = Math.min(1, len(B) / Math.max(len(A), 1e-300));
  const whole = wrap(e.end - e.start) < 1e-12 || Math.abs(e.end - e.start - TAU) < 1e-12;
  if (whole) return { type: "ellipse", c, major: A, ratio, start: 0, end: TAU, ...(e.layer !== undefined ? { layer: e.layer } : {}) };
  // The arc's ends and middle, mapped, give its parameters on the new ellipse (counter-clockwise).
  const span = wrap(e.end - e.start);
  const p = apply(m, ellipsePoint(e.c, e.major, e.ratio, e.start));
  const q = apply(m, ellipsePoint(e.c, e.major, e.ratio, e.start + span));
  const mid = apply(m, ellipsePoint(e.c, e.major, e.ratio, e.start + span / 2));
  const a = ellipseParam(c, A, ratio, p);
  const b = ellipseParam(c, A, ratio, q);
  const t = ellipseParam(c, A, ratio, mid);
  const forward = wrap(t - a) < wrap(b - a);
  const [start, end] = forward ? [a, b] : [b, a];
  return { type: "ellipse", c, major: A, ratio, start, end, ...(e.layer !== undefined ? { layer: e.layer } : {}) };
}

// --------------------------------------------------------------- contours

/** Where an open curve entity starts and ends (null for closed ones: circles, whole ellipses, closed polylines and splines, points, text). */
export function endsOf(e: DxfEntity): [Vec2, Vec2] | null {
  switch (e.type) {
    case "line":
      return [e.a, e.b];
    case "arc":
      return arcEnds(e.c, e.r, e.start, e.end);
    case "polyline":
      return e.closed ? null : [e.points[0], e.points[e.points.length - 1]];
    case "ellipse": {
      if (wrap(e.end - e.start) < 1e-12) return null;
      return [ellipsePoint(e.c, e.major, e.ratio, e.start), ellipsePoint(e.c, e.major, e.ratio, e.end)];
    }
    case "spline": {
      if (e.closed) return null;
      const pts = e.control.length >= 2 ? e.control : (e.fit ?? []);
      if (pts.length < 2) return null;
      // A clamped spline starts and ends on its end control points; otherwise evaluate.
      if (e.control.length >= 2) {
        const [t0, t1] = nurbsRange(e.degree, e.knots, e.control.length);
        return [nurbsPoint(e.degree, e.knots, e.control, e.weights, t0), nurbsPoint(e.degree, e.knots, e.control, e.weights, t1)];
      }
      return [pts[0], pts[pts.length - 1]];
    }
    default:
      return null;
  }
}

/**
 * Joins lines and arcs that meet end to end (within `tol`, on the same
 * layer) into polylines with bulges: closed where a chain comes back to its
 * start. Laser and plasma CAM reads one closed polyline as one cut, with its
 * lead-in and kerf on the right side. Everything else passes through.
 */
export function joinContours(entities: DxfEntity[], tol = 1e-6): DxfEntity[] {
  type Piece = { a: Vec2; b: Vec2; bulge: number; i: number };
  const out: DxfEntity[] = [];
  const byLayer = new Map<string, Piece[]>();
  entities.forEach((e, i) => {
    if (e.type === "line" || e.type === "arc") {
      const [a, b] = e.type === "line" ? [e.a, e.b] : arcEnds(e.c, e.r, e.start, e.end);
      if (dist(a, b) <= tol && e.type === "line") return; // nothing to draw
      const bulge = e.type === "line" ? 0 : sweepBulge(ccwSpanDeg(e.start, e.end) * DEG);
      const list = byLayer.get(e.layer ?? "0") ?? [];
      list.push({ a, b, bulge, i });
      byLayer.set(e.layer ?? "0", list);
    } else out.push(e);
  });
  for (const [layer, pieces] of byLayer) {
    const used = new Array(pieces.length).fill(false);
    const near = (p: Vec2, q: Vec2) => dist(p, q) <= tol;
    /** An unused piece touching p: [index, forward]. */
    const touching = (p: Vec2): [number, boolean] | null => {
      for (let j = 0; j < pieces.length; j++) {
        if (used[j]) continue;
        if (near(pieces[j].a, p)) return [j, true];
        if (near(pieces[j].b, p)) return [j, false];
      }
      return null;
    };
    for (let s = 0; s < pieces.length; s++) {
      if (used[s]) continue;
      used[s] = true;
      // Grow both ways from the first piece.
      let points: Vec2[] = [pieces[s].a, pieces[s].b];
      let bulges: number[] = [pieces[s].bulge];
      for (;;) {
        const next = touching(points[points.length - 1]);
        if (!next) break;
        const [j, fwd] = next;
        used[j] = true;
        const p = pieces[j];
        points.push(fwd ? p.b : p.a);
        bulges.push(fwd ? p.bulge : -p.bulge);
      }
      for (;;) {
        const prev = touching(points[0]);
        if (!prev) break;
        const [j, fwd] = prev;
        used[j] = true;
        const p = pieces[j];
        // A piece ending at our start runs forward into it; one starting there runs backward.
        points = [fwd ? p.b : p.a, ...points];
        bulges = [fwd ? -p.bulge : p.bulge, ...bulges];
      }
      const closed = points.length > 2 && near(points[0], points[points.length - 1]);
      if (closed) points.pop();
      const layerOf = layer === "0" && entities[pieces[s].i].layer === undefined ? {} : { layer };
      if (points.length === 2 && !closed) {
        // A lone piece stays what it was.
        out.push(entities[pieces[s].i]);
        continue;
      }
      const hasArc = bulges.some((b) => Math.abs(b) > 1e-12);
      out.push({ type: "polyline", points, ...(hasArc ? { bulges } : {}), ...(closed ? { closed: true } : {}), ...layerOf });
    }
  }
  return out;
}

/** Moves every entity by v. */
export function translateAll(entities: DxfEntity[], v: Vec2): DxfEntity[] {
  return entities.flatMap((e) => transformEntity(e, translation(v)));
}

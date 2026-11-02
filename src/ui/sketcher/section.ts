// Intersection curves, as the sketcher sees them: where the model's faces
// cut the sketch plane, from the view's mesh (each face's triangles cut by
// the plane, the pieces chained), each piece made the sketch entity it is: a
// flat face's cut a line; a cylinder's a circle or arc (axis square to the
// plane), lines (axis along it) or an ellipse; anything else a spline
// through points along it. Each entity references the face it comes from and
// a point of the piece ({ face, section: [x, y] }), so the rebuild cuts the
// face again, exactly, and the curve follows the model.
//
// Pure: Vitest covers it in node.

import type { FaceSelector, SketchEntity, Vec2, Vec3 } from "../../doc/types";
import { to2D, type Frame } from "../../geom/frame";
import type { MeshData } from "../../kernel/mesh";
import { faceSelectorFor } from "../../kernel/synthesize";
import type { FaceInfo } from "../../kernel/topology";

/** One piece of the section: the face it cuts, its polyline in the sketch, and the entity it makes (no id yet). */
export interface SectionPiece {
  face: number;
  poly: Vec2[];
  /** The entity's numbers and reference, or why there is none (the face can't be found again by a selector). */
  entity: (BareEntity & { ref: { face: FaceSelector; section: Vec2 } }) | null;
  problem?: string;
}

const TOL = 1e-6;

/** An entity without its id (and ref), kind by kind. */
export type BareEntity = SketchEntity extends infer E ? (E extends SketchEntity ? Omit<E, "id" | "ref"> : never) : never;

/** The segments where a triangle crosses the plane z = 0 (frame heights), in the sketch. */
function cutTriangle(a: Vec3, b: Vec3, c: Vec3, h: (p: Vec3) => number, frame: Frame): [Vec2, Vec2] | null {
  const pts = [a, b, c];
  const hs = pts.map(h);
  const out: Vec3[] = [];
  for (let i = 0; i < 3; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % 3];
    const hp = hs[i];
    const hq = hs[(i + 1) % 3];
    if ((hp > 0 && hq < 0) || (hp < 0 && hq > 0)) {
      const t = hp / (hp - hq);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])]);
    } else if (hp === 0) out.push(p);
  }
  if (out.length < 2) return null;
  const s: [Vec2, Vec2] = [to2D(frame, out[0]), to2D(frame, out[1])];
  return Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]) > TOL ? s : null;
}

/** Segments chained end to end into polylines. */
export function chainSegments(segs: [Vec2, Vec2][], tol = 1e-5): Vec2[][] {
  const left = [...segs];
  const out: Vec2[][] = [];
  const near = (p: Vec2, q: Vec2) => Math.abs(p[0] - q[0]) < tol && Math.abs(p[1] - q[1]) < tol;
  while (left.length) {
    const first = left.pop()!;
    const line: Vec2[] = [first[0], first[1]];
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const [p, q] = left[i];
        const head = line[0];
        const tail = line[line.length - 1];
        if (near(p, tail)) line.push(q);
        else if (near(q, tail)) line.push(p);
        else if (near(q, head)) line.unshift(p);
        else if (near(p, head)) line.unshift(q);
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    out.push(line);
  }
  return out;
}

function length(poly: Vec2[]): number {
  let l = 0;
  for (let i = 1; i < poly.length; i++) l += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
  return l;
}

/** The point half way along a polyline. */
export function midway(poly: Vec2[]): Vec2 {
  const half = length(poly) / 2;
  let l = 0;
  for (let i = 1; i < poly.length; i++) {
    const d = Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
    if (l + d >= half && d > 0) {
      const t = (half - l) / d;
      return [poly[i - 1][0] + t * (poly[i][0] - poly[i - 1][0]), poly[i - 1][1] + t * (poly[i][1] - poly[i - 1][1])];
    }
    l += d;
  }
  return poly[0];
}

/** Points spread evenly along a polyline (its ends included), for a spline through it. */
export function resample(poly: Vec2[], n: number): Vec2[] {
  const total = length(poly);
  const closed = Math.hypot(poly[0][0] - poly[poly.length - 1][0], poly[0][1] - poly[poly.length - 1][1]) < 1e-6;
  const count = closed ? n : n;
  const out: Vec2[] = [];
  for (let k = 0; k < count; k++) {
    const want = (total * k) / (closed ? count : count - 1);
    let l = 0;
    for (let i = 1; i < poly.length; i++) {
      const d = Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
      if (l + d >= want - 1e-12 || i === poly.length - 1) {
        const t = d > 0 ? Math.min(1, Math.max(0, (want - l) / d)) : 0;
        out.push([poly[i - 1][0] + t * (poly[i][0] - poly[i - 1][0]), poly[i - 1][1] + t * (poly[i][1] - poly[i - 1][1])]);
        break;
      }
      l += d;
    }
  }
  return out;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * The entity a piece makes, from the face's kind: a line, circle or arc where
 * the cut is analytic, else a spline through points along it.
 */
export function pieceEntity(face: FaceInfo, poly: Vec2[], frame: Frame): BareEntity {
  const closed = poly.length > 3 && Math.hypot(poly[0][0] - poly[poly.length - 1][0], poly[0][1] - poly[poly.length - 1][1]) < 1e-4;
  const a = poly[0];
  const b = poly[poly.length - 1];
  if (face.type === "plane") return { type: "line", start: a, end: b };
  const cyl = face.cylinder;
  if (face.type === "cylinder" && cyl) {
    const along = Math.abs(dot(cyl.axis, frame.z));
    if (along > 1 - 1e-9) {
      const center = to2D(frame, cyl.origin);
      if (closed) return { type: "circle", center, radius: cyl.radius };
      // Which way round: the way the polyline turns about the centre.
      const m = poly[Math.floor(poly.length / 2)];
      const cross = (a[0] - center[0]) * (m[1] - center[1]) - (a[1] - center[1]) * (m[0] - center[0]);
      return { type: "arc", center, start: a, end: b, ...(cross < 0 ? { clockwise: true } : {}) };
    }
    if (along < 1e-9) return { type: "line", start: a, end: b };
  }
  const pts = resample(closed ? poly.slice(0, -1).concat([poly[0]]) : poly, closed ? 24 : 16);
  return closed ? { type: "spline", points: pts.slice(0, Math.max(3, pts.length)), closed: true } : { type: "spline", points: pts };
}

/** Every piece where the view's faces cross the sketch plane (faces lying in or along it are left out). */
export function sectionPieces(view: { mesh: MeshData | null; faces: FaceInfo[] } | null, frame: Frame): SectionPiece[] {
  if (!view?.mesh) return [];
  const mesh = view.mesh;
  const h = (p: Vec3) => (p[0] - frame.origin[0]) * frame.z[0] + (p[1] - frame.origin[1]) * frame.z[1] + (p[2] - frame.origin[2]) * frame.z[2];
  const out: SectionPiece[] = [];
  view.faces.forEach((f, i) => {
    if (f.type === "plane" && f.normal && Math.abs(dot(f.normal, frame.z)) > 1 - 1e-9) return;
    const range = mesh.faceRanges[i];
    if (!range) return;
    const v = (k: number): Vec3 => [mesh.positions[3 * k], mesh.positions[3 * k + 1], mesh.positions[3 * k + 2]];
    const segs: [Vec2, Vec2][] = [];
    for (let k = range.start; k + 2 < range.start + range.count; k += 3) {
      const s = cutTriangle(v(mesh.indices[k]), v(mesh.indices[k + 1]), v(mesh.indices[k + 2]), h, frame);
      if (s) segs.push(s);
    }
    if (!segs.length) return;
    const selector = faceSelectorFor(view.faces, f.index);
    for (const poly of chainSegments(segs)) {
      if (length(poly) < 1e-4) continue;
      if (!selector.ok) {
        out.push({ face: f.index, poly, entity: null, problem: selector.error });
        continue;
      }
      const base = pieceEntity(f, poly, frame);
      out.push({ face: f.index, poly, entity: { ...base, ref: { face: selector.selector, section: midway(poly) } } });
    }
  });
  return out;
}

/**
 * The sketch with the section pieces added as intersection curves (profile
 * geometry unless `construction`), each a fresh id; pieces it holds already
 * (the same face and a section point on the same curve) are left out. A
 * message when there is nothing to add.
 */
export function addSections(pieces: readonly SectionPiece[], entities: SketchEntity[], construction: boolean): { entities: SketchEntity[]; added: number } | string {
  const usable = pieces.filter((p) => p.entity);
  if (!usable.length) return pieces.length ? `no intersection curve can be added: ${pieces.find((p) => p.problem)?.problem ?? "the faces can't be found again"}` : "no face of the model crosses the sketch plane here";
  const used = new Set(entities.map((e) => e.id));
  const fresh = (prefix: string) => {
    let n = 1;
    while (used.has(`${prefix}${n}`)) n++;
    used.add(`${prefix}${n}`);
    return `${prefix}${n}`;
  };
  const prefix: Record<string, string> = { line: "l", circle: "c", arc: "a", spline: "sp" };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const have = (p: SectionPiece) =>
    entities.some((e) => {
      const r = e.ref as { face?: unknown; section?: Vec2 } | undefined;
      if (!r?.section || !same(r.face, p.entity!.ref.face)) return false;
      // On the same piece: its section point lies on the piece's polyline.
      return p.poly.some((q, i) => i > 0 && segDistance(r.section!, p.poly[i - 1], q) < 1e-3);
    });
  const add = usable.filter((p) => !have(p)).map((p) => ({ ...p.entity!, id: fresh(prefix[p.entity!.type] ?? "e"), construction }) as SketchEntity);
  if (!add.length) return "the sketch has every intersection curve already";
  return { entities: [...entities, ...add], added: add.length };
}

function segDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

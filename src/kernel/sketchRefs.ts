// A sketch's references to the model (DESIGN §2.4), at rebuild time. Each
// reference entity is the model's edge, axis or point as it stands at the
// sketch's place in history, projected into the sketch plane (src/geom/
// projection.ts); then the sketch is solved from its stored geometry with
// those numbers held, so a circle dimensioned to a model edge follows the
// edge when the part changes. A sketch with no references is left exactly
// as the document has it (the rebuild only checks it).

import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { DatumRef, SketchEntity, SketchFeature } from "../doc/types";
import { isAxisId } from "../geom/axes";
import type { Frame } from "../geom/frame";
import { edgePointOf, projectAxis, projectEdge, projectPoint, withPoint, withProjection } from "../geom/projection";
import { solveSketch } from "../geom/solver";
import { len3, sub3 } from "../geom/vec";
import { describePart, type DescribedPart } from "./bodies";
import { resolveDatum, type DatumContext } from "./datum";
import { boundingBoxOf } from "./measure";
import { scoped } from "./oc";
import { OpError } from "./ops";
import { describeEdgeSelector, edgeSelectionError, selectEdges } from "./selectors";
import type { EdgeInfo } from "./topology";

/** An axis is drawn this far each way at least, mm, when there is little or no part to cover. */
const MIN_AXIS_HALF = 100;

/**
 * The sketch with its references projected from the model and its geometry
 * solved around them. `hold`: solver field refs written as expressions in the
 * document ("c1.radius"), which stay where the expressions put them. The
 * sketch itself when it references nothing.
 */
export function solvedSketch(ctx: DatumContext, f: SketchFeature, frame: Frame, hold: string[] = []): SketchFeature {
  if (!f.entities.some((e) => e.ref)) return f;
  const entities = projectReferences(ctx, f, frame);
  const r = solveSketch(entities, f.constraints ?? [], { fixed: hold.filter((h) => !isReferenceField(entities, h)) });
  if (!r.ok) {
    throw new OpError(
      `its relations and dimensions can't all hold with its references where the model puts them now (${r.error}); change or delete the relation that ties the sketch to the moved geometry`,
    );
  }
  return { ...f, entities: r.entities };
}

/** The entities, each reference entity's numbers replaced by its projection now. */
export function projectReferences(ctx: DatumContext, f: SketchFeature, frame: Frame): SketchEntity[] {
  let part: DescribedPart | null = null;
  let half: number | null = null;
  return scoped((s) => {
    /** The part's faces and edges, described once for every edge reference. */
    const described = () => (part ??= describePart(ctx.oc, s, ctx.bodies as Map<string, TopoDS_Shape>, true));
    /** Half the length an axis is drawn: enough to cross the whole part. */
    const axisHalf = () => {
      if (half !== null) return half;
      let size = 0;
      if (ctx.bodies.size) {
        const box = boundingBoxOf(ctx.oc, s, described().shape);
        if (box) size = len3(sub3(box.max, box.min)) + len3(box.max) + len3(box.min);
      }
      return (half = Math.max(MIN_AXIS_HALF, size));
    };
    const edgeOf = (sel: Extract<DatumRef, { edge: unknown }>["edge"], path: string): EdgeInfo => {
      if (ctx.bodies.size === 0) throw new OpError(`${path}: there is no solid before this sketch to take an edge from`);
      const p = described();
      const found = selectEdges(p.edgeInfos, p.faceInfos, sel, path);
      const problem = edgeSelectionError(sel, found, path);
      if (problem) throw new OpError(problem);
      if (found.matches.length > 1) throw new OpError(`${path}: selector matched ${found.matches.length} edges (wanted 1 of ${describeEdgeSelector(sel)})`);
      return found.matches[0];
    };
    return f.entities.map((e, i) => {
      if (!e.ref) return e;
      const name = `"${e.id}"`;
      const path = `entities[${i}].ref`;
      try {
        const got = project(e, e.ref, path, name);
        if (typeof got === "string") throw new OpError(got);
        return got;
      } catch (err) {
        if (!(err instanceof OpError)) throw err;
        throw new OpError(`${err.message}. The sketch's reference ${name} (${refWhat(e.ref)}) no longer finds what it projects: open the sketch and re-pick it, or delete ${name}`);
      }
    });

    function project(e: SketchEntity, ref: DatumRef, path: string, name: string): SketchEntity | string {
      if ("edge" in ref) {
        const edge = edgeOf(ref.edge, `${path}.edge`);
        if (e.type === "point") {
          const at = edgePointOf(edge, ref.at ?? "center");
          if (typeof at === "string") return `${path}.at: ${at}`;
          return withPoint(e, projectPoint(at, frame), name);
        }
        const shape = projectEdge(edge, frame);
        if (!shape.ok) return `${path}: ${shape.error}`;
        return withProjection(e, shape.shape, name);
      }
      if (e.type === "point") return withPoint(e, projectPoint(resolveDatum(ctx, ref, "point", path).at, frame), name);
      if (e.type !== "line") return `${path}: ${name} is ${e.type === "arc" ? "an" : "a"} ${e.type}; it can reference an edge only`;
      const axis = resolveDatum(ctx, ref, "axis", path);
      const shape = projectAxis(axis.origin, axis.direction, frame, axisHalf());
      if (!shape.ok) return `${path}: ${shape.error}`;
      return withProjection(e, shape.shape, name);
    }
  });
}

/** Whether a solver field ref ("l1.start.0") is a reference entity's: those follow the model, not an expression. */
function isReferenceField(entities: SketchEntity[], field: string): boolean {
  const id = field.split(".")[0];
  return isAxisId(id) || !!entities.find((e) => e.id === id)?.ref;
}

/** A reference as the failure message names it: "an edge", "the start of an edge", "axis Z". */
function refWhat(ref: DatumRef): string {
  if ("edge" in ref) return ref.at ? `the ${ref.at === "mid" ? "middle" : ref.at} of a model edge` : "a model edge";
  if ("datum" in ref) return ref.datum;
  if ("face" in ref) return "a face";
  return "a point";
}

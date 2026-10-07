// rebuild(doc) -> { ok, solid, measurements, errors[] }
//
// Features run in order against one body. A failed feature contributes
// nothing and the rebuild carries on, so one bad hole does not hide the rest
// of the part; every failure is reported as "<feature id>: <reason>".

import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { SketchFeature, Vec3 } from "../doc/types";
import { validateDocument } from "../doc/validate";
import { checkConstraints } from "../geom/constraints";
import { planeFrame, to3D } from "../geom/frame";
import { buildProfile, entityPolylines } from "../geom/profile";
import { measure, type Measurements } from "./measure";
import { getOC, type OC, scoped } from "./oc";
import { edgeTreatment, extrudeOrCut, hole, OpError, pattern, type BooleanKind, type SketchProfile, type ToolResult } from "./ops";

export interface FeatureStatus {
  id: string;
  op: string;
  ok: boolean;
  /** Skipped on purpose; `ok` stays true. */
  suppressed?: boolean;
  /** Same text as the matching entry in `errors`. */
  error?: string;
}

/** Sketch geometry in world space, for display. */
export interface SketchOverlay {
  id: string;
  ok: boolean;
  polylines: { construction: boolean; points: Vec3[] }[];
}

export interface RebuildResult {
  ok: boolean;
  /** The body after the last successful feature. Owned by the result; call dispose(). */
  solid: TopoDS_Shape | null;
  measurements: Measurements | null;
  errors: string[];
  features: FeatureStatus[];
  sketches: SketchOverlay[];
  name: string;
  dispose(): void;
}

export function rebuild(input: unknown, oc: OC = getOC()): RebuildResult {
  const v = validateDocument(input);
  const errors = [...v.headerErrors];
  const features: FeatureStatus[] = [];
  const sketches: SketchOverlay[] = [];
  let body: TopoDS_Shape | null = null;

  const result = (): RebuildResult => {
    const solid = body;
    return {
      ok: errors.length === 0 && solid !== null,
      solid,
      measurements: solid ? scoped((s) => measure(oc, s, solid, v.material)) : null,
      errors,
      features,
      sketches,
      name: v.name || "untitled",
      dispose: () => solid?.delete(),
    };
  };

  if (v.headerErrors.length > 0) return result();

  const profiles = new Map<string, SketchProfile | null>();
  /** Tool bodies of extrude, cut and hole features, for patterns. Disposed before returning. */
  const tools = new Map<string, { tool: TopoDS_Shape; kind: BooleanKind }>();
  const suppressed = new Set<string>();
  const missing = (id: string, what: string) =>
    suppressed.has(id) ? `${what} "${id}" is suppressed` : `${what} "${id}" failed`;
  const advance = (step: (before: TopoDS_Shape | null) => TopoDS_Shape) => {
    const before: TopoDS_Shape | null = body;
    body = step(before);
    before?.delete();
  };
  const keepTool = (id: string, r: ToolResult): TopoDS_Shape => {
    tools.set(id, { tool: r.tool, kind: r.kind });
    return r.body;
  };

  for (const vf of v.features) {
    const raw = vf.feature;
    const op = vf.op;
    if (!raw) {
      errors.push(...vf.errors);
      features.push({ id: vf.id, op, ok: false, error: vf.errors.join("\n") });
      profiles.set(vf.id, null);
      continue;
    }
    if (raw.suppressed) {
      suppressed.add(raw.id);
      profiles.set(raw.id, null);
      features.push({ id: raw.id, op, ok: true, suppressed: true });
      continue;
    }
    try {
      switch (raw.op) {
        case "sketch":
          profiles.set(raw.id, null);
          sketches.push(overlay(raw, false));
          profiles.set(raw.id, buildSketch(raw));
          sketches[sketches.length - 1].ok = true;
          break;
        case "extrude":
        case "cut": {
          const profile = profiles.get(raw.sketch);
          if (!profile) throw new OpError(`${missing(raw.sketch, "sketch")}, so there is no profile to ${raw.op}`);
          advance((before) => keepTool(raw.id, scoped((s) => extrudeOrCut(oc, s, raw, profile, before))));
          break;
        }
        case "hole":
          advance((before) => keepTool(raw.id, scoped((s) => hole(oc, s, raw, before))));
          break;
        case "fillet":
        case "chamfer":
          advance((before) => scoped((s) => edgeTreatment(oc, s, raw, before)));
          break;
        case "linearPattern":
        case "circularPattern": {
          const seed = tools.get(raw.feature);
          if (!seed) throw new OpError(`${missing(raw.feature, "feature")}, so there is nothing to repeat`);
          advance((before) => scoped((s) => pattern(oc, s, raw, seed, before)));
          break;
        }
      }
      features.push({ id: raw.id, op, ok: true });
    } catch (e) {
      const messages = e instanceof OpError ? e.message.split("\n") : [`kernel error: ${kernelMessage(oc, e)}`];
      const prefixed = messages.map((m) => `${raw.id}: ${m}`);
      errors.push(...prefixed);
      features.push({ id: raw.id, op, ok: false, error: prefixed.join("\n") });
    }
  }
  for (const t of tools.values()) t.tool.delete();
  if (!body && errors.length === 0) errors.push("document: no solid; add an extrude");
  return result();
}

function buildSketch(f: SketchFeature): SketchProfile {
  const problems = checkConstraints(f.entities, f.constraints ?? []);
  if (problems.length > 0) throw new OpError(problems.join("\n"));
  const profile = buildProfile(f.entities);
  if (!profile.ok) throw new OpError(profile.error);
  const frame = planeFrame(f.plane.normal, f.plane.origin, f.plane.xDir);
  return { frame, regions: profile.regions, area: profile.area };
}

function overlay(f: SketchFeature, ok: boolean): SketchOverlay {
  const frame = planeFrame(f.plane.normal, f.plane.origin, f.plane.xDir);
  return {
    id: f.id,
    ok,
    polylines: f.entities.flatMap((e) =>
      entityPolylines(e).map((pts) => ({ construction: !!e.construction, points: pts.map((p) => to3D(frame, p)) })),
    ),
  };
}

function kernelMessage(oc: OC, e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    const [type, message] = (oc as unknown as { getExceptionMessage(e: unknown): [string, string] }).getExceptionMessage(e);
    return `${type}${message ? `: ${message}` : ""}`;
  } catch {
    return String(e);
  }
}

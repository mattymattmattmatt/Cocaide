// The context packet (spec 6.1). A right-click builds it, and it is the
// whole prompt: the target node, its parent, its direct children, the
// target's own measurements, the selector for a picked face or edge, and the
// error of a failed feature. Never the whole tree.
//
// The write scope (spec 6.2) comes with it, and apply() enforces that scope.

import { references, type RawDocument } from "../doc/commands";
import { documentParameters, parameterRefs, resolveExpressions } from "../doc/parameters";
import { photoGuesses, photoOf } from "../doc/photo";
import { constraintEntities } from "../doc/sketch";
import { DEFAULT_BODY, type Constraint, type MemberFeature, type ProfileDef, type SketchEntity } from "../doc/types";
import { isObject, memberAtNode, validateDocument } from "../doc/validate";
import { measureConstraint } from "../geom/constraints";
import { buildProfile } from "../geom/profile";
import { sketchDof } from "../geom/solver";
import { dist2 } from "../geom/vec";
import { edgeSummary, faceSummary, measurementSummary, round6 } from "../kernel/inspect";
import { edgeSelectorFor, faceSelectorFor } from "../kernel/synthesize";
import { fabricationChecks } from "../weldment/fabrication";
import { defOf } from "../features/defs";
import { DATUM_OPS, type Datum } from "../features/datum";
import { drawingPacket } from "./drawingPacket";
import type { CheckResult, KernelPort, PartTopology } from "./kernel";

export type AskTarget =
  /** A feature row in the tree. A sketch feature is asked about as a sketch. */
  | { kind: "feature"; id: string }
  /** A failed rebuild row: the error is the subject. */
  | { kind: "failed"; id: string }
  | { kind: "entity"; sketch: string; entity: string }
  | { kind: "constraint"; sketch: string; index: number }
  | { kind: "face"; index: number }
  | { kind: "edge"; index: number }
  | { kind: "parameter"; name: string }
  /** One body of a part of several (Phase H): its features, and new features that touch only it. */
  | { kind: "body"; name: string }
  /** Empty space: the whole part, the weakest scope (spec 6). Never applied without the user accepting. */
  | { kind: "part" }
  /** A view on the drawing's sheet (Phase L): the view and the annotations in it. */
  | { kind: "view"; id: string }
  /** One annotation on the sheet. */
  | { kind: "annotation"; id: string }
  /** Empty paper: the whole drawing, never the part's features. */
  | { kind: "drawing" };

export type PacketKind =
  | "feature"
  | "sketch"
  | "member"
  | "joint"
  | "failed"
  | "entity"
  | "constraint"
  | "face"
  | "edge"
  | "parameter"
  | "body"
  | "part"
  | "view"
  | "annotation"
  | "drawing";

/** Targets on the drawing's sheet: their asks edit the drawing alone. */
export function isDrawingTarget(t: AskTarget): t is Extract<AskTarget, { kind: "view" | "annotation" | "drawing" }> {
  return t.kind === "view" || t.kind === "annotation" || t.kind === "drawing";
}

/** What a feature row is asked about as: a sketch, a member or a joint get their own actions and packet. */
export function featureKind(op: unknown): PacketKind {
  return op === "sketch" ? "sketch" : op === "member" ? "member" : op === "joint" ? "joint" : "feature";
}

export interface Packet {
  target: { kind: PacketKind; label: string } & Record<string, unknown>;
  writeScope: string[];
  units: "mm";
  /** The target node itself (key named by kind: feature, sketch, entity, ...). */
  [node: string]: unknown;
  parent: unknown;
  children: unknown[];
  measurements: Record<string, unknown>;
  error: string | null;
}

type Raw = Record<string, unknown>;

/** The write scope for a target, by the table in spec 6.2. Face and edge add the one-feature rule in the session. */
export function scopeFor(doc: RawDocument, target: AskTarget): string[] {
  switch (target.kind) {
    case "feature": {
      const f = doc.features.find((x) => x.id === target.id);
      return f?.op === "sketch" ? [`${target.id}/*`] : [target.id];
    }
    case "failed":
      return [target.id];
    case "entity":
      return [`${target.sketch}/${target.entity}`];
    case "constraint": {
      const k = sketchOf(doc, target.sketch)?.constraints?.[target.index] as Constraint | undefined;
      const ids = k ? [...new Set(constraintEntities(k))] : [];
      return ids.map((e) => `${target.sketch}/${e}`);
    }
    case "face":
    case "edge":
      return ["+"];
    case "parameter":
      return [`param:${target.name}`];
    case "body":
      return [...bodyFeatures(doc, target.name), `body:${target.name}`];
    case "part":
      return ["*"];
    case "view":
      return [`view:${target.id}`];
    case "annotation":
      return [`annotation:${target.id}`];
    case "drawing":
      return ["drawing"];
  }
}

/**
 * The features that make a body or work on it alone: the extrude that starts
 * it and those that add to it, cuts and holes that list only it, a combine
 * into it, and patterns of any of these. A cut that reaches every body is not
 * the body's: changing it would change the others.
 */
export function bodyFeatures(doc: RawDocument, name: string): string[] {
  const ids = new Set<string>();
  for (const f of doc.features) {
    const id = String(f.id);
    const only = (list: unknown) => Array.isArray(list) && list.length > 0 && list.every((b) => b === name);
    if (f.op === "extrude" && (f.newBody ?? f.body ?? DEFAULT_BODY) === name) ids.add(id);
    else if ((f.op === "cut" || f.op === "hole") && only(f.bodies)) ids.add(id);
    else if (f.op === "combine" && f.target === name) ids.add(id);
    else if ((f.op === "member" || f.op === "endCap" || f.op === "gusset") && (f.newBody ?? f.id) === name) ids.add(id);
    else if ((f.op === "linearPattern" || f.op === "circularPattern") && ids.has(String(f.feature))) ids.add(id);
    else if (defOf(f.op)?.onlyBodies?.(f, (n) => n === name, doc)) ids.add(id);
  }
  return [...ids];
}

/** The write scope in words, for the menu. */
export function describeScope(scope: string[]): string {
  if (scope.length === 0) return "nothing";
  return scope
    .map((t) => {
      if (t === "+") return "add one feature that uses it";
      if (t === "*") return "anything";
      if (t.startsWith("param:")) return `parameter ${t.slice(6)}`;
      if (t.startsWith("body:")) return `new features on body ${t.slice(5)} alone`;
      if (t.startsWith("node:")) return `node ${t.slice(5)}`;
      if (t.startsWith("weld:")) return `weld ${t.slice(5)}`;
      if (t.startsWith("view:")) return `view ${t.slice(5)} and its annotations`;
      if (t.startsWith("annotation:")) return `annotation ${t.slice(11)}`;
      if (t === "drawing") return "the drawing";
      const [sketch, part] = t.split("/");
      if (part === "*") return `the geometry of ${sketch}`;
      if (part) return `${part} in ${sketch} and its constraints`;
      return t;
    })
    .join(", ");
}

/** What the target is called in the menu: "hole_1", "l1 in sketch_1", "face 3". */
export function targetLabel(doc: RawDocument, target: AskTarget, topo?: PartTopology | null): string {
  switch (target.kind) {
    case "feature":
    case "failed":
      return target.id;
    case "entity":
      return `${target.entity} in ${target.sketch}`;
    case "constraint": {
      const k = sketchOf(doc, target.sketch)?.constraints?.[target.index];
      return `${k ? `${k.type} ` : ""}constraint ${target.index} of ${target.sketch}`;
    }
    case "face": {
      const f = topo?.faces[target.index];
      return f ? `this ${f.type === "plane" ? "flat" : f.type === "cylinder" ? (f.cylinder?.concave ? "hole wall" : "round") : f.type} face` : `face ${target.index}`;
    }
    case "edge": {
      const e = topo?.edges[target.index];
      return e ? `this ${e.kind === "circle" ? "circular" : e.kind === "line" ? "straight" : ""} edge`.replace("  ", " ") : `edge ${target.index}`;
    }
    case "parameter":
      return target.name;
    case "body":
      return `body ${target.name}`;
    case "part":
      return doc.features.length ? "the whole part" : "a new part";
    case "view":
      return `view ${target.id}`;
    case "annotation": {
      const d = doc.drawing as { annotations?: { id?: unknown; type?: unknown }[] } | undefined;
      const a = d?.annotations?.find((x) => x.id === target.id);
      return a ? `${String(a.type)} ${target.id}` : target.id;
    }
    case "drawing":
      return "the drawing";
  }
}

export async function buildPacket(doc: RawDocument, target: AskTarget, kernel: KernelPort): Promise<Packet> {
  const params = documentParameters(doc);
  const resolved = resolveExpressions(doc, params, []) as RawDocument;
  const check = await kernel.check(doc);
  const needsTopology = target.kind === "face" || target.kind === "edge" || target.kind === "feature" || target.kind === "failed";
  if (target.kind === "part") return partPacket(doc, check, targetLabel(doc, target), scopeFor(doc, target));
  if (isDrawingTarget(target)) return drawingPacket(doc, target, kernel, check, targetLabel(doc, target), scopeFor(doc, target));
  const topo = needsTopology ? await kernel.topology(doc) : null;
  const label = targetLabel(doc, target, topo);
  const writeScope = scopeFor(doc, target);
  const base = { units: "mm" as const, writeScope };
  const usedParams = (node: unknown) => {
    const out: Record<string, number> = {};
    for (const p of parameterRefs(node)) if (p in params) out[p] = params[p];
    return Object.keys(out).length ? { parameters: out } : {};
  };

  switch (target.kind) {
    case "body": {
      const m = check.measurements?.bodies.find((b) => b.name === target.name);
      const made = bodyFeatures(doc, target.name);
      const status = new Map(check.features.map((s) => [s.id, s]));
      return {
        target: { kind: "body", name: target.name, label },
        ...base,
        body: m
          ? { name: m.name, volume: round6(m.volume), massKg: round6(m.massKg), size: m.boundingBox?.size.map(round6), holeCount: m.holeCount }
          : { name: target.name, missing: "the body is not in the rebuilt part: the feature that makes it failed or is suppressed" },
        parent: null,
        children: doc.features.filter((f) => made.includes(String(f.id))).map((f) => ({ ...brief(f), ok: status.get(String(f.id))?.ok ?? false })),
        measurements: {
          otherBodies: (check.measurements?.bodies ?? []).filter((b) => b.name !== target.name).map((b) => b.name),
          interference: (check.measurements?.interference ?? []).filter((i) => i.bodies.includes(target.name)),
        },
        error: null,
      };
    }
    case "feature":
    case "failed": {
      const f = doc.features.find((x) => x.id === target.id);
      if (!f) throw new Error(`no feature "${target.id}"`);
      const status = check.features.find((s) => s.id === target.id);
      const isSketch = f.op === "sketch";
      const kind: PacketKind = target.kind === "failed" ? "failed" : featureKind(f.op);
      const parents = await parentsOf(doc, check, topo, kernel);
      const parentId = parents.get(target.id) ?? null;
      const parent = parentId ? brief(doc.features.find((x) => x.id === parentId)!) : null;
      const children = doc.features.filter((x) => parents.get(String(x.id)) === target.id).map(brief);
      return {
        target: { kind, id: target.id, op: f.op, label },
        ...base,
        [isSketch ? "sketch" : "feature"]: f,
        ...usedParams(f),
        parent,
        children,
        measurements: isSketch
          ? sketchMeasurements(resolved.features.find((x) => x.id === target.id)!)
          : { ...featureMeasurements(f, resolved, topo), ...(check.datums?.[target.id] ? { now: datumFrame(check.datums[target.id]) } : {}) },
        // A member or joint: what the frame around it is (Phase K).
        ...(f.op === "member" ? { member: memberDetails(doc, f, check) } : {}),
        ...(f.op === "joint" ? { joint: jointDetails(doc, f, check) } : {}),
        error: status && !status.ok ? (status.error ?? "failed") : null,
        ...(status?.suppressed ? { suppressed: true } : {}),
      };
    }
    case "entity": {
      const sketch = sketchOf(doc, target.sketch);
      const rsketch = sketchOf(resolved, target.sketch);
      const e = sketch?.entities?.find((x) => x.id === target.entity);
      const re = rsketch?.entities?.find((x) => x.id === target.entity);
      if (!sketch || !rsketch || !e || !re) throw new Error(`no entity "${target.entity}" in "${target.sketch}"`);
      const on = (rsketch.constraints ?? []).map((k, index) => ({ index, k })).filter(({ k }) => constraintEntities(k).includes(target.entity));
      return {
        target: { kind: "entity", sketch: target.sketch, entity: target.entity, label },
        ...base,
        entity: e,
        ...usedParams(e),
        parent: sketchBrief(sketch as unknown as Raw),
        children: on.map(({ index }) => ({ index, ...(sketch.constraints![index] as unknown as Raw) })),
        measurements: entityMeasurements(re),
        error: null,
      };
    }
    case "constraint": {
      const sketch = sketchOf(doc, target.sketch);
      const rsketch = sketchOf(resolved, target.sketch);
      const k = sketch?.constraints?.[target.index];
      const rk = rsketch?.constraints?.[target.index];
      if (!sketch || !rsketch || !k || !rk) throw new Error(`no constraint ${target.index} in "${target.sketch}"`);
      const ids = new Set(constraintEntities(rk));
      let measured: Record<string, unknown> = {};
      try {
        const m = measureConstraint(rsketch.entities ?? [], rk);
        measured = { measures: m.label, actual: round6(m.actual), expected: round6(m.expected), satisfied: Math.abs(m.actual - m.expected) < 1e-6 };
      } catch {
        measured = { error: "the constraint refers to geometry that is not there" };
      }
      return {
        target: { kind: "constraint", sketch: target.sketch, index: target.index, label },
        ...base,
        constraint: k,
        ...usedParams(k),
        parent: sketchBrief(sketch as unknown as Raw),
        children: (sketch.entities ?? []).filter((e) => ids.has(e.id)),
        measurements: measured,
        error: null,
      };
    }
    case "face": {
      const f = topo?.faces[target.index];
      if (!topo || !f) throw new Error(`no face ${target.index}`);
      const made = topo.faceOrigins[target.index];
      const sel = faceSelectorFor(topo.faces, target.index);
      return {
        target: { kind: "face", index: target.index, label },
        ...base,
        face: { index: target.index, type: f.type, madeBy: made },
        parent: made ? brief(doc.features.find((x) => x.id === made)!) : null,
        children: [],
        measurements: faceSummary(f),
        selection: sel.ok ? sel.selector : null,
        ...(sel.ok ? {} : { selectionError: sel.error }),
        error: null,
      };
    }
    case "edge": {
      const e = topo?.edges[target.index];
      if (!topo || !e) throw new Error(`no edge ${target.index}`);
      const sel = edgeSelectorFor(topo.edges, topo.faces, target.index);
      const madeBy = [...new Set(e.faces.map((fi) => topo.faceOrigins[fi]).filter((x): x is string => !!x))];
      return {
        target: { kind: "edge", index: target.index, label },
        ...base,
        edge: { index: target.index, kind: e.kind },
        parent: madeBy.map((id) => brief(doc.features.find((x) => x.id === id)!)),
        children: [],
        measurements: { ...edgeSummary(e), between: e.faces.map((fi) => ({ type: topo.faces[fi].type, madeBy: topo.faceOrigins[fi] })) },
        selection: sel.ok ? sel.selector : null,
        ...(sel.ok ? {} : { selectionError: sel.error }),
        error: null,
      };
    }
    case "parameter": {
      if (!(target.name in params)) throw new Error(`no parameter "${target.name}"`);
      const users = doc.features.filter((f) => parameterRefs(f).has(target.name));
      return {
        target: { kind: "parameter", name: target.name, label },
        ...base,
        parameter: { name: target.name, value: params[target.name] },
        parent: null,
        children: users.map(brief),
        measurements: { value: params[target.name], usedBy: users.map((f) => String(f.id)) },
        error: null,
      };
    }
  }
}

/**
 * The part in brief: its name, parameters and each feature as one line (a
 * sketch as its entity list), with whether it rebuilt. What an ask about the
 * whole part reads, and what a wide ask from one thing gets beside its packet.
 */
export function partOutline(doc: RawDocument, check: CheckResult): Record<string, unknown> {
  const status = new Map(check.features.map((s) => [s.id, s]));
  const params = documentParameters(doc);
  return {
    name: doc.name,
    ...(Object.keys(params).length ? { parameters: params } : {}),
    features: doc.features.map((f) => {
      const s = status.get(String(f.id));
      return { ...brief(f), ok: s?.ok ?? false, ...(s?.error ? { error: s.error } : {}), ...(s?.suppressed ? { suppressed: true } : {}) };
    }),
    referenceGeometry: referenceGeometry(doc, check),
    ...(isObject(doc.drawing) ? { drawing: { views: Array.isArray(doc.drawing.views) ? doc.drawing.views.length : 0, annotations: Array.isArray(doc.drawing.annotations) ? doc.drawing.annotations.length : 0 } } : {}),
  };
}

/** A resolved plane, axis or point, rounded for the agent to read. */
function datumFrame(d: Datum): Record<string, unknown> {
  const r = (v: readonly number[]) => v.map((x) => round6(x) + 0);
  if (d.kind === "plane") return { kind: "plane", origin: r(d.origin), normal: r(d.normal), xDir: r(d.xDir) };
  if (d.kind === "axis") return { kind: "axis", origin: r(d.origin), direction: r(d.direction) };
  return { kind: "point", at: r(d.at) };
}

/**
 * The reference geometry the agent can stand things on by { "datum": "<id>" }
 * (a sketch's plane { "type": "ref", "ref": { "datum": "plane_1" } }, a plane
 * offset from another, an axis): the default planes, axes and origin, then
 * each plane, axis and point feature with where it is now (or why it isn't).
 */
export function referenceGeometry(doc: RawDocument, check: CheckResult): Record<string, unknown> {
  const status = new Map(check.features.map((s) => [s.id, s]));
  return {
    defaults: "planes Top (XY, normal +Z), Front (XZ, normal -Y), Right (YZ, normal +X); point Origin; axes X, Y, Z (all through the origin)",
    features: doc.features
      .filter((f) => Object.hasOwn(DATUM_OPS, String(f.op)))
      .map((f) => {
        const id = String(f.id);
        const d = check.datums?.[id];
        const s = status.get(id);
        return { id, op: f.op, mode: f.mode ?? (f.op === "plane" ? "offset" : undefined), ...(d ? datumFrame(d) : { built: false, ...(s?.suppressed ? { suppressed: true } : s?.error ? { error: s.error } : {}) }) };
      }),
  };
}

/** The whole part as a target: its features as one line each, its parameters and measurements. */
function partPacket(doc: RawDocument, check: CheckResult, label: string, writeScope: string[]): Packet {
  const fabrication = fabricationChecks(doc, check.measurements);
  // A part estimated from a photo: which sizes are the photo's, so an answer never calls them exact.
  const photo = photoOf(doc);
  const fromPhoto = photo && {
    image: photo.image,
    scale: `${photo.scale.what} = ${photo.scale.length} mm, ${photo.scale.confirmed ? "confirmed by the user" : "not confirmed: export is refused until the user confirms it"}`,
    estimated: Object.keys(photo.estimated).filter((p) => photo.estimated[p] !== null),
    guesses: photoGuesses(photo),
  };
  return {
    target: { kind: "part", label },
    units: "mm",
    writeScope,
    part: { ...partOutline(doc, check), ...(fromPhoto ? { photo: fromPhoto } : {}) },
    parent: null,
    children: [],
    measurements: check.measurements ? measurementSummary(check.measurements) : { solid: false },
    // A weldment: what a workshop would check before cutting it.
    ...(fabrication.length ? { fabrication } : {}),
    error: check.errors.filter((e) => e.startsWith("document:") && !e.startsWith("document: no solid")).join("; ") || null,
  };
}

/**
 * Each feature's parent: what it references (an extrude's sketch, a pattern's
 * seed), else for a hole the feature that made the face it drills, else the
 * nearest earlier feature that shapes the solid.
 */
async function parentsOf(doc: RawDocument, check: CheckResult, topo: PartTopology | null, kernel: KernelPort): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ok = new Set(check.features.filter((s) => s.ok && !s.suppressed).map((s) => s.id));
  let lastSolid: string | null = null;
  for (const f of doc.features) {
    const id = String(f.id);
    const refs = references(f);
    // A sketch placed on a face stands on it the way a hole does.
    const onFace = f.op === "sketch" && isObject(f.plane) && f.plane.type === "ref" && isObject(f.plane.ref) && isObject(f.plane.ref.face) ? f.plane.ref.face : undefined;
    if (refs.length) out.set(id, refs[0]);
    else if ((f.op === "hole" && isObject(f.face)) || onFace) {
      const r = topo ? await kernel.select(doc, resolveExpressions(onFace ?? f.face, documentParameters(doc), [])) : null;
      const origin = r && r.ok && r.kind === "faces" && r.indices.length === 1 ? topo!.faceOrigins[r.indices[0]] : null;
      if (origin && origin !== id) out.set(id, origin);
      else if (f.op === "hole" && lastSolid) out.set(id, lastSolid);
    } else if (f.op !== "sketch" && lastSolid) out.set(id, lastSolid);
    if (f.op !== "sketch" && ok.has(id)) lastSolid = id;
  }
  return out;
}

/** A feature as a neighbour: all its fields, except a sketch's geometry, which is summarised. */
/** A member: the sizes it can swap to (its profile's, in this part), its ends, and its cut as measured. */
function memberDetails(doc: RawDocument, f: Raw, check: CheckResult): Raw {
  const profile = ((doc.profiles ?? {}) as Record<string, ProfileDef>)[String(f.profile)];
  const v = validateDocument(doc);
  const m = v.features.find((x) => x.id === f.id)?.feature as MemberFeature | undefined;
  const cut = check.measurements?.members.find((x) => x.id === f.id);
  const jointAt = (node?: string) => (node ? doc.features.find((x) => x.op === "joint" && x.node === node)?.id ?? null : null);
  return {
    profile: f.profile,
    size: f.size,
    sizes: profile?.sizes.map((s) => s.designation) ?? [],
    ...(profile?.library ? { library: `a copy of library profile ${profile.name} v${profile.library.version}; other sizes must be added from the section library first` } : {}),
    ...(m
      ? {
          from: m.fromNode ? { node: m.fromNode, at: m.from.map(round6), joint: jointAt(m.fromNode) } : { at: m.from.map(round6) },
          to: m.toNode ? { node: m.toNode, at: m.to.map(round6), joint: jointAt(m.toNode) } : { at: m.to.map(round6) },
        }
      : {}),
    measured: cut ? { length: cut.length, angles: cut.angles, massKg: round6(cut.massKg) } : null,
  };
}

/** A joint: its node, every member there (ending at it or passing through), and their cuts as measured. */
function jointDetails(doc: RawDocument, f: Raw, check: CheckResult): Raw {
  const v = validateDocument(doc);
  const node = String(f.node);
  const at = v.nodes[node];
  const members = v.features.flatMap((x) => (x.feature?.op === "member" ? [x.feature] : []));
  return {
    node,
    at: at?.map(round6) ?? null,
    members: at
      ? members.flatMap((m) => {
          const how = memberAtNode(m, node, at);
          if (!how) return [];
          const cut = check.measurements?.members.find((x) => x.id === m.id);
          const end = m.fromNode === node ? 0 : 1;
          return [{ id: m.id, size: m.size, [how === "ends" ? "endsHere" : "passesThrough"]: true, ...(cut && how === "ends" ? { cutHere: `${cut.angles[end]}° from square` } : {}) }];
        })
      : [],
  };
}

function brief(f: Raw): Raw {
  return f.op === "sketch" ? sketchBrief(f) : f;
}

function sketchBrief(f: Raw): Raw {
  const entities = (Array.isArray(f.entities) ? f.entities : []) as Raw[];
  return {
    id: f.id,
    op: "sketch",
    plane: f.plane,
    entities: entities.map((e) => `${String(e.id)} ${String(e.type)}${e.construction ? " (construction)" : ""}`).join(", "),
    constraints: Array.isArray(f.constraints) ? f.constraints.length : 0,
  };
}

function sketchOf(doc: RawDocument, id: string): { entities?: SketchEntity[]; constraints?: Constraint[] } | undefined {
  const f = doc.features.find((x) => x.id === id);
  return f && f.op === "sketch" ? (f as { entities?: SketchEntity[]; constraints?: Constraint[] }) : undefined;
}

function sketchMeasurements(f: Raw): Record<string, unknown> {
  const entities = (f.entities ?? []) as SketchEntity[];
  const constraints = (f.constraints ?? []) as Constraint[];
  const out: Record<string, unknown> = { entities: entities.length, constraints: constraints.length };
  try {
    out.dof = sketchDof(entities, constraints);
    out.fullyDefined = out.dof === 0;
  } catch {
    // malformed: the feature's error says why
  }
  const p = buildProfile(entities);
  out.profile = p.ok ? { closed: true, regions: p.regions.length, area: round6(p.area) } : { closed: false, problem: p.error };
  return out;
}

function featureMeasurements(f: Raw, resolved: RawDocument, topo: PartTopology | null): Record<string, unknown> {
  const rf = resolved.features.find((x) => x.id === f.id) ?? f;
  const out: Record<string, unknown> = {};
  const keys = new Set(["distance", "diameter", "depth", "radius", "count", "spacing", "angle", ...(defOf(f.op)?.measurementKeys ?? [])]);
  for (const k of keys) if (typeof rf[k] === "number" || rf[k] === "through") out[k] = rf[k];
  if (topo) {
    const mine = topo.faces.filter((_, i) => topo.faceOrigins[i] === f.id);
    out.faces = mine.length;
    const walls = mine.filter((x) => x.cylinder?.concave);
    if (walls.length) {
      out.measuredDiameters = [...new Set(walls.map((x) => round6(2 * x.cylinder!.radius)))].sort((a, b) => a - b);
      out.measuredDepth = round6(Math.max(...walls.map((x) => x.cylinder!.axial[1] - x.cylinder!.axial[0])));
    }
  }
  return out;
}

function entityMeasurements(e: SketchEntity): Record<string, unknown> {
  switch (e.type) {
    case "line":
      return { length: round6(dist2(e.start, e.end)), angleDeg: round6((Math.atan2(e.end[1] - e.start[1], e.end[0] - e.start[0]) * 180) / Math.PI) };
    case "circle":
      return { radius: e.radius, diameter: round6(2 * e.radius) };
    case "arc":
      return { radius: round6(dist2(e.start, e.center)) };
    case "rect":
      return { width: e.w, height: e.h };
    case "slot":
      return { length: round6(dist2(e.center1, e.center2) + e.width), width: e.width };
  }
}

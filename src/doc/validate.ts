// Strict schema validation for .cocaide.json. Unknown fields are errors: a
// typo such as "diamter" must fail loudly instead of being ignored.
//
// Header problems (version, units, features not an array) make the whole
// document unusable. Feature problems are reported per feature so the rest of
// the part can still rebuild.

import {
  BODY_NAME,
  COMBINE_OPERATIONS,
  DEFAULT_BODY,
  EDGE_PICKS,
  FEATURE_OPS,
  JOINT_TYPES,
  NODE_NAME,
  PATTERNABLE_OPS,
  PHOTO_KEYS,
  PHOTO_SCALE_KEYS,
  PHOTO_SCALE_SOURCES,
  PICKS,
  SOURCE_KEYS,
  WELD_KEYS,
  WELD_TYPES,
  type ChamferFeature,
  type CircularPatternFeature,
  type CombineFeature,
  type CocaideDocument,
  type Constraint,
  type EdgeSelector,
  type EndCapFeature,
  type ExtrudeFeature,
  type FaceSelector,
  type Feature,
  type FilletFeature,
  type GussetFeature,
  type HoleFeature,
  type JointFeature,
  type LinearPatternFeature,
  type Material,
  type MemberFeature,
  PROFILE_KEYS,
  type ProfileDef,
  type SketchEntity,
  type SketchFeature,
  type Vec2,
  type Vec3,
  type Weld,
  type Drawing,
  type MirrorFeature,
  type SplitFeature,
  type MoveFeature,
  type DeleteBodyFeature,
  type DatumRef,
  type EdgePoint,
  type PlaneSpec,
  DERIVED_SUFFIX,
} from "./types";
import { validateDrawing } from "./drawing";
import { PARAMETER_NAME, resolveExpressions, type Parameters } from "./parameters";
import { defOf, type FeatureDef, type ValidateKit } from "../features/defs";
import { aKinds, DATUM_OPS, datumSelectors, defaultDatum, featureDatumRefs, possibleKinds, RESERVED_DATUMS, type DatumKind } from "../features/datum";
import { isSketchAxis } from "./sketch";
import { SKETCH_AXES } from "./types";

export interface ValidatedFeature {
  index: number;
  /** The raw id when it is a string, else a positional placeholder. */
  id: string;
  /** The raw op when it is a string, else "unknown". */
  op: string;
  /** Present only when the feature passed validation. */
  feature: Feature | null;
  errors: string[];
}

export interface ValidationResult {
  /** Errors that make the document as a whole unusable. */
  headerErrors: string[];
  name: string;
  parameters: Parameters;
  material: Material | undefined;
  features: ValidatedFeature[];
  /** The bodies the part ends with, in order of first use. */
  bodies: string[];
  /** Every body any feature makes, deleted and consumed ones too, in order. */
  madeBodies: string[];
  /** Each body's own material, where it has one. */
  bodyMaterials: Record<string, Material>;
  /** The weldment profiles that validated, by name. */
  profiles: Record<string, ProfileDef>;
  /** The frame's nodes, with expressions evaluated. */
  nodes: Record<string, Vec3>;
  /** The weld table. */
  welds: Weld[];
  /** The drawing, when the document has one and it is valid. */
  drawing: Drawing | null;
  /** What is wrong with the drawing. Never stops the part rebuilding. */
  drawingErrors: string[];
}

/** What a feature may refer to: the part's profiles and nodes, and the members before it. */
export interface FeatureContext {
  profiles: Record<string, ProfileDef>;
  /** Every profile the part lists, valid or not. */
  listed: string[];
  nodes: Record<string, Vec3>;
  /** Valid members so far, by id. */
  members: Map<string, MemberFeature>;
  /** The joint at each node so far. */
  joints: Map<string, string>;
}

const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Every error in the document, flattened, in feature order. */
export function allErrors(v: ValidationResult): string[] {
  return [...v.headerErrors, ...v.features.flatMap((f) => f.errors), ...v.drawingErrors];
}

/** The typed document, or null when anything failed validation. */
export function toDocument(v: ValidationResult): CocaideDocument | null {
  if (allErrors(v).length > 0) return null;
  const doc: CocaideDocument = {
    version: 1,
    units: "mm",
    name: v.name,
    features: v.features.map((f) => f.feature as Feature),
  };
  if (Object.keys(v.parameters).length) doc.parameters = v.parameters;
  if (v.material) doc.material = v.material;
  return doc;
}

export function validateDocument(input: unknown): ValidationResult {
  const result: ValidationResult = { headerErrors: [], name: "", parameters: {}, material: undefined, features: [], bodies: [], madeBodies: [], bodyMaterials: {}, profiles: {}, nodes: {}, welds: [], drawing: null, drawingErrors: [] };
  const header = new Checker("document");
  if (!isObject(input)) {
    header.fail("", `must be a JSON object (got ${describe(input)})`);
    result.headerErrors = header.errors;
    return result;
  }
  header.keys(input, "", ["version", "units", "name", "parameters", "material", "bodyMaterials", "source", "photo", "profiles", "nodes", "welds", "features", "drawing"]);
  if (input.version !== 1) header.fail("version", `must be 1 (got ${describe(input.version)})`);
  if (input.units !== "mm") {
    header.fail("units", `must be "mm" (got ${describe(input.units)}); v1 documents store millimetres only`);
  }
  if (typeof input.name !== "string" || input.name.trim() === "") {
    header.fail("name", `must be a non-empty string (got ${describe(input.name)})`);
  } else {
    result.name = input.name;
  }
  if (input.material !== undefined) {
    if (!isObject(input.material)) {
      header.fail("material", `must be an object (got ${describe(input.material)})`);
    } else {
      const m = input.material;
      header.keys(m, "material", ["name", "densityKgPerM3"]);
      const density = header.num(m, "densityKgPerM3", "material", { positive: true });
      if (m.name !== undefined && typeof m.name !== "string") {
        header.fail("material.name", `must be a string (got ${describe(m.name)})`);
      }
      if (density !== undefined) {
        result.material = { densityKgPerM3: density };
        if (typeof m.name === "string") result.material.name = m.name;
      }
    }
  }
  if (input.source !== undefined) {
    if (!isObject(input.source)) {
      header.fail("source", `must be an object of notes (got ${describe(input.source)})`);
    } else {
      header.keys(input.source, "source", [...SOURCE_KEYS]);
      for (const [k, v] of Object.entries(input.source)) {
        if (typeof v !== "string") header.fail(`source.${k}`, `must be a string (got ${describe(v)})`);
      }
    }
  }
  if (input.parameters !== undefined) {
    if (!isObject(input.parameters)) {
      header.fail("parameters", `must be an object of name: number (got ${describe(input.parameters)})`);
    } else {
      for (const [k, v] of Object.entries(input.parameters)) {
        if (!PARAMETER_NAME.test(k)) header.fail(`parameters.${k}`, "a parameter name is letters, digits and _ and starts with a letter");
        else if (typeof v !== "number" || !Number.isFinite(v)) header.fail(`parameters.${k}`, `must be a number (got ${describe(v)})`);
        else result.parameters[k] = v;
      }
    }
  }
  if (input.photo !== undefined) checkPhoto(input.photo, result.parameters, header);
  if (input.profiles !== undefined) {
    if (!isObject(input.profiles)) header.fail("profiles", `must be an object of name: profile (got ${describe(input.profiles)})`);
    else for (const [name, def] of Object.entries(input.profiles)) {
      const p = validateProfile(def, `profiles.${name}`, header);
      if (p && p.name !== name) header.fail(`profiles.${name}.name`, `must be "${name}", the name it is listed under (got ${describe(p.name)})`);
      else if (p) result.profiles[name] = p;
    }
  }
  if (input.nodes !== undefined) {
    if (!isObject(input.nodes)) header.fail("nodes", `must be an object of name: [x, y, z] (got ${describe(input.nodes)})`);
    else
      for (const [name, at] of Object.entries(input.nodes)) {
        if (!NODE_NAME.test(name)) {
          header.fail(`nodes.${name}`, "a node name is letters, digits and _ and starts with a letter");
          continue;
        }
        const exprErrors: string[] = [];
        const point = resolveExpressions(at, result.parameters, exprErrors, `nodes.${name}`);
        for (const e of exprErrors) header.fail("", e);
        if (exprErrors.length) continue;
        const v = header.vec3({ [name]: point }, name, "nodes");
        if (v) result.nodes[name] = v;
      }
  }
  if (!Array.isArray(input.features)) {
    header.fail("features", `must be an array (got ${describe(input.features)})`);
    result.headerErrors = header.errors;
    return result;
  }
  result.headerErrors = header.errors;
  /** Every profile the part lists, valid or not: a member of a broken one points at its errors. */
  const listed = isObject(input.profiles) ? Object.keys(input.profiles) : [];
  const ctx: FeatureContext = { profiles: result.profiles, listed, nodes: result.nodes, members: new Map(), joints: new Map() };

  const seen = new Map<string, string>(); // id -> op, for features before the current one
  const bodies = new BodyNames();
  input.features.forEach((original, index) => {
    const rawId = isObject(original) && typeof original.id === "string" && original.id !== "" ? original.id : `features[${index}]`;
    const c = new Checker(rawId);
    let feature: Feature | null = null;
    // Expressions become numbers first; a bad expression fails this feature only.
    const exprErrors: string[] = [];
    const raw = isObject(original) ? (resolveExpressions(original, result.parameters, exprErrors) as Record<string, unknown>) : original;
    for (const e of exprErrors) c.fail("", e);
    if (!isObject(raw)) {
      c.fail("", `must be an object (got ${describe(raw)})`);
    } else {
      if (typeof raw.id !== "string" || !ID_PATTERN.test(raw.id)) {
        c.fail("id", `must be an identifier like "hole_1" (got ${describe(raw.id)})`);
      } else if (RESERVED_DATUMS.includes(raw.id)) {
        c.fail("id", `"${raw.id}" names a default plane, axis or the origin (${RESERVED_DATUMS.join(", ")}); give the feature another id`);
      } else if (seen.has(raw.id)) {
        c.fail("id", `duplicate id "${raw.id}"`);
      }
      // A bad expression already says what is wrong with that field.
      if (exprErrors.length === 0) feature = validateFeature(raw, c, seen, ctx);
      if (feature) bodies.check(feature, c);
      if (feature?.op === "member" && c.errors.length === 0) ctx.members.set(feature.id, feature);
      if (feature?.op === "joint" && c.errors.length === 0) ctx.joints.set(feature.node, feature.id);
      if (typeof raw.id === "string" && !seen.has(raw.id)) seen.set(raw.id, String(raw.op));
    }
    result.features.push({
      index,
      id: rawId,
      op: isObject(raw) && typeof raw.op === "string" ? raw.op : "unknown",
      feature: c.errors.length === 0 ? feature : null,
      errors: c.errors,
    });
  });
  result.bodies = bodies.all();
  result.madeBodies = bodies.everMade();
  if (input.bodyMaterials !== undefined) {
    const m = new Checker("document");
    if (!isObject(input.bodyMaterials)) m.fail("bodyMaterials", `must be an object of body name: material (got ${describe(input.bodyMaterials)})`);
    else
      for (const [name, raw] of Object.entries(input.bodyMaterials)) {
        if (!result.madeBodies.includes(name)) {
          m.fail(`bodyMaterials.${name}`, `no body "${name}" (bodies: ${result.madeBodies.join(", ") || "none"})`);
          continue;
        }
        const mat = checkMaterial(raw, `bodyMaterials.${name}`, m);
        if (mat) result.bodyMaterials[name] = mat;
      }
    result.headerErrors.push(...m.errors);
  }
  if (input.welds !== undefined) {
    const welds = new Checker("document");
    result.welds = checkWelds(input.welds, result.bodies, welds);
    result.headerErrors.push(...welds.errors);
  }
  if (input.drawing !== undefined) {
    const drawing = new Checker("document");
    result.drawing = validateDrawing(input.drawing, drawing);
    result.drawingErrors = drawing.errors;
  }
  return result;
}

function validateFeature(input: Record<string, unknown>, c: Checker, earlier: Map<string, string>, ctx: FeatureContext): Feature | null {
  // `suppressed` is common to every op; check it here and validate the rest per op.
  const { suppressed, ...raw } = input;
  if (suppressed !== undefined && typeof suppressed !== "boolean") {
    c.fail("suppressed", `must be true or false (got ${describe(suppressed)})`);
  }
  let feature: Feature | null;
  switch (raw.op) {
    case "sketch":
      feature = validateSketch(raw, c, earlier);
      break;
    case "extrude":
    case "cut":
      feature = validateExtrude(raw, c, earlier);
      break;
    case "hole":
      feature = validateHole(raw, c);
      break;
    case "fillet":
    case "chamfer":
      feature = validateEdgeTreatment(raw, c);
      break;
    case "linearPattern":
    case "circularPattern":
      feature = validatePattern(raw, c, earlier);
      break;
    case "combine":
      feature = validateCombine(raw, c);
      break;
    case "member":
      feature = validateMember(raw, c, ctx);
      break;
    case "joint":
      feature = validateJoint(raw, c, earlier, ctx);
      break;
    case "endCap":
      feature = validateEndCap(raw, c, earlier, ctx);
      break;
    case "gusset":
      feature = validateGusset(raw, c, earlier, ctx);
      break;
    case "mirror":
      feature = validateMirror(raw, c, earlier);
      break;
    case "split":
      feature = validateSplit(raw, c, earlier);
      break;
    case "move":
      feature = validateMove(raw, c);
      break;
    case "deleteBody":
      feature = validateDeleteBody(raw, c);
      break;
    default: {
      // An op of the registry (src/features/<op>/doc.ts).
      const d = defOf(raw.op);
      if (!d) {
        c.fail("op", `unknown op ${describe(raw.op)} (supported: ${FEATURE_OPS.join(", ")})`);
        return null;
      }
      feature = d.validate(raw, c, validateKit(c, earlier, ctx));
      if (c.errors.length > 0) feature = null;
    }
  }
  if (feature && typeof suppressed === "boolean") feature.suppressed = suppressed;
  return feature;
}

// ---------------------------------------------------------------- sketch

const ENTITY_FIELDS: Record<SketchEntity["type"], string[]> = {
  line: ["start", "end"],
  circle: ["center", "radius"],
  arc: ["center", "start", "end", "clockwise"],
  rect: ["center", "w", "h"],
  slot: ["center1", "center2", "width"],
  point: ["at"],
};

const POINT_NAMES: Record<SketchEntity["type"], string[]> = {
  line: ["start", "end"],
  circle: ["center"],
  arc: ["start", "end", "center"],
  rect: ["center"],
  slot: ["center1", "center2"],
  point: ["at"],
};

/** What each entity type may reference (DESIGN §2.4), as the messages say it. Rects and slots reference nothing. */
const REF_KINDS: Partial<Record<SketchEntity["type"], string>> = {
  line: 'a straight edge ({ "edge": <selector> }) or an axis ({ "datum": "Z" } or an axis feature)',
  circle: 'a whole circular edge ({ "edge": <selector> })',
  arc: 'part of a circular edge ({ "edge": <selector> })',
  point: 'a point of an edge ({ "edge": <selector>, "at": "start" | "end" | "mid" | "center" }), a point feature or { "datum": "Origin" }',
};

/** An entity's `ref`: a DatumRef of a kind the entity can be (the rebuild checks the geometry it finds). */
function referenceOf(v: unknown, type: SketchEntity["type"], path: string, c: Checker, opts: { earlier: ReadonlyMap<string, string>; profile: boolean }): DatumRef | undefined {
  const takes = REF_KINDS[type]!;
  if (opts.profile) {
    c.fail(path, "a weldment profile is drawn on its own, with no model to reference; remove ref");
    return undefined;
  }
  const before = c.errors.length;
  const ref = validateDatumRef(v, path, c, opts.earlier);
  if (!ref || c.errors.length > before) return undefined;
  const refuse = (what: string) => {
    c.fail(path, `a ${type} references ${takes}, not ${what}`);
    return undefined;
  };
  if ("face" in ref) return refuse("a face (pick one of its edges)");
  const kinds = possibleKinds(ref, opts.earlier);
  if ("edge" in ref) {
    if (type === "point") {
      if (!ref.at && ref.edge.kind === "line") return refuse('a straight edge without "at" (say which point of it)');
      return ref;
    }
    if (ref.at) return refuse(`a point of an edge ("at": "${ref.at}"); use a point entity for that`);
    if ((type === "circle" || type === "arc") && ref.edge.kind === "line") return refuse("a straight edge");
    return ref;
  }
  if ("point" in ref) return type === "point" ? ref : refuse("a point");
  // A default or a reference feature: a line takes an axis, a point a point.
  const want = type === "line" ? "axis" : type === "point" ? "point" : null;
  if (!want || !kinds.includes(want)) return refuse(`${ref.datum}, ${aKinds(kinds)}`);
  return ref;
}

/**
 * A sketch. `profile`: it is a weldment profile's sketch, drawn in a plane of
 * its own, so it has no model to reference.
 */
function validateSketch(raw: Record<string, unknown>, c: Checker, earlier: ReadonlyMap<string, string>, opts: { profile?: boolean } = {}): SketchFeature | null {
  c.keys(raw, "", ["id", "op", "plane", "entities", "constraints", "profile"]);
  let mark: SketchFeature["profile"];
  if (raw.profile !== undefined) {
    if (!isObject(raw.profile)) c.fail("profile", `must be { "name": ... } (got ${describe(raw.profile)})`);
    else {
      c.keys(raw.profile, "profile", ["name", "library"]);
      if (typeof raw.profile.name !== "string" || !raw.profile.name.trim()) c.fail("profile.name", `must be the profile's name (got ${describe(raw.profile.name)})`);
      const library = raw.profile.library === undefined ? undefined : libraryRef(raw.profile.library, "profile.library", c);
      if (typeof raw.profile.name === "string") mark = { name: raw.profile.name, ...(library ? { library } : {}) };
    }
  }
  // On a datum plane written out, or by reference: a face (it follows the face), a default plane, a plane feature.
  const plane = validatePlane(raw.plane, "plane", c, earlier);

  const entities: SketchEntity[] = [];
  const entityTypes = new Map<string, SketchEntity["type"]>();
  /** The reference entities: their numbers follow the model, so nothing may fix them. */
  const references = new Set<string>();
  if (!Array.isArray(raw.entities)) {
    c.fail("entities", `must be an array (got ${describe(raw.entities)})`);
  } else {
    raw.entities.forEach((e, i) => {
      const entity = validateEntity(e, `entities[${i}]`, c, entityTypes, { earlier, profile: !!opts.profile });
      if (entity) {
        entities.push(entity);
        entityTypes.set(entity.id, entity.type);
        if (entity.ref) references.add(entity.id);
      }
    });
  }

  const constraints: Constraint[] = [];
  if (raw.constraints !== undefined) {
    if (!Array.isArray(raw.constraints)) {
      c.fail("constraints", `must be an array (got ${describe(raw.constraints)})`);
    } else {
      raw.constraints.forEach((k, i) => {
        const constraint = validateConstraint(k, `constraints[${i}]`, c, entityTypes, references);
        if (constraint) constraints.push(constraint);
      });
    }
  }

  if (!plane || c.errors.length > 0) return null;
  const sketch: SketchFeature = { id: raw.id as string, op: "sketch", plane, entities };
  if (raw.constraints !== undefined) sketch.constraints = constraints;
  if (mark) sketch.profile = mark;
  return sketch;
}

function validateEntity(
  e: unknown,
  path: string,
  c: Checker,
  known: Map<string, SketchEntity["type"]>,
  opts: { earlier: ReadonlyMap<string, string>; profile: boolean },
): SketchEntity | null {
  if (!isObject(e)) {
    c.fail(path, `must be an object (got ${describe(e)})`);
    return null;
  }
  const label = typeof e.id === "string" ? `${path} "${e.id}"` : path;
  const before = c.errors.length;
  if (typeof e.id !== "string" || !ID_PATTERN.test(e.id)) {
    c.fail(label, `id must be an identifier like "r1" (got ${describe(e.id)})`);
  } else if (isSketchAxis(e.id)) {
    c.fail(label, `"${e.id}" names the sketch's ${e.id} axis (${SKETCH_AXES.join(" and ")} are taken); give the entity another id`);
  } else if (known.has(e.id)) {
    c.fail(label, `duplicate entity id "${e.id}"`);
  }
  if (e.construction !== undefined && typeof e.construction !== "boolean") {
    c.fail(label, `construction must be true or false (got ${describe(e.construction)})`);
  }
  const type = e.type as SketchEntity["type"];
  if (!(type in ENTITY_FIELDS)) {
    c.fail(label, `unknown entity type ${describe(e.type)} (supported: ${Object.keys(ENTITY_FIELDS).join(", ")})`);
    return null;
  }
  c.keys(e, label, ["id", "type", "construction", "ref", ...ENTITY_FIELDS[type]]);
  // A rect or a slot is several curves at once: it takes no ref.
  if (e.ref !== undefined && !REF_KINDS[type]) c.fail(`${label} ref`, `a ${type} can't reference the model (lines, circles, arcs and points can); remove ref, or reference the edges with lines (Convert Entities)`);
  const ref = e.ref === undefined || !REF_KINDS[type] ? undefined : referenceOf(e.ref, type, `${label} ref`, c, opts);
  const base = {
    id: e.id as string,
    ...(e.construction === undefined ? {} : { construction: e.construction as boolean }),
    ...(ref ? { ref } : {}),
  };
  let entity: SketchEntity | null = null;
  switch (type) {
    case "line": {
      const start = c.vec2(e, "start", label);
      const end = c.vec2(e, "end", label);
      if (start && end) entity = { ...base, type, start, end };
      break;
    }
    case "circle": {
      const center = c.vec2(e, "center", label);
      const radius = c.num(e, "radius", label, { positive: true });
      if (center && radius !== undefined) entity = { ...base, type, center, radius };
      break;
    }
    case "arc": {
      const center = c.vec2(e, "center", label);
      const start = c.vec2(e, "start", label);
      const end = c.vec2(e, "end", label);
      if (e.clockwise !== undefined && typeof e.clockwise !== "boolean") {
        c.fail(label, `clockwise must be true or false (got ${describe(e.clockwise)})`);
      }
      if (center && start && end) {
        entity = { ...base, type, center, start, end };
        if (e.clockwise !== undefined) entity.clockwise = e.clockwise as boolean;
      }
      break;
    }
    case "rect": {
      const center = c.vec2(e, "center", label);
      const w = c.num(e, "w", label, { positive: true });
      const h = c.num(e, "h", label, { positive: true });
      if (center && w !== undefined && h !== undefined) entity = { ...base, type, center, w, h };
      break;
    }
    case "slot": {
      const center1 = c.vec2(e, "center1", label);
      const center2 = c.vec2(e, "center2", label);
      const width = c.num(e, "width", label, { positive: true });
      if (center1 && center2 && width !== undefined) entity = { ...base, type, center1, center2, width };
      break;
    }
    case "point": {
      const at = c.vec2(e, "at", label);
      if (at) entity = { ...base, type, at };
      break;
    }
  }
  return c.errors.length === before ? entity : null;
}

function validateConstraint(
  k: unknown,
  path: string,
  c: Checker,
  entities: Map<string, SketchEntity["type"]>,
  references: ReadonlySet<string> = new Set(),
): Constraint | null {
  if (!isObject(k)) {
    c.fail(path, `must be an object (got ${describe(k)})`);
    return null;
  }
  const label = typeof k.type === "string" ? `${path} ${k.type}` : path;
  const before = c.errors.length;
  /** `axis`: the sketch's X or Y axis may stand for the line. */
  const entityRef = (key: string, value: unknown, allowed: SketchEntity["type"][], axis = false): string | undefined => {
    if (isSketchAxis(value)) {
      if (axis && allowed.includes("line")) return value;
      c.fail(label, `${key} "${value}" is the sketch's ${value} axis; this constraint needs ${allowed.join(" or ")} of the sketch`);
      return undefined;
    }
    if (typeof value !== "string" || !entities.has(value)) {
      c.fail(label, `${key} must name an entity in this sketch (got ${describe(value)})`);
      return undefined;
    }
    const type = entities.get(value)!;
    if (!allowed.includes(type)) {
      c.fail(label, `${key} "${value}" is a ${type}; this constraint applies to ${allowed.join(" or ")}`);
      return undefined;
    }
    return value;
  };
  const pointRef = (value: unknown): string | undefined => {
    if (typeof value !== "string") {
      c.fail(label, `point refs must be strings like "l1.end" (got ${describe(value)})`);
      return undefined;
    }
    if (value === "origin") return value;
    const [id, point, ...rest] = value.split(".");
    const type = entities.get(id);
    if (!type || point === undefined || rest.length > 0) {
      c.fail(label, `point ref "${value}" must be "origin" or "<entity>.<point>" for an entity in this sketch`);
      return undefined;
    }
    if (!POINT_NAMES[type].includes(point)) {
      c.fail(label, `point ref "${value}": a ${type} has points ${POINT_NAMES[type].join(", ")}`);
      return undefined;
    }
    return value;
  };
  const pointPair = (value: unknown): [string, string] | undefined => {
    if (!Array.isArray(value) || value.length !== 2) {
      c.fail(label, `points must be an array of two point refs (got ${describe(value)})`);
      return undefined;
    }
    const a = pointRef(value[0]);
    const b = pointRef(value[1]);
    return a && b ? [a, b] : undefined;
  };
  const entityPair = (allowed: SketchEntity["type"][], axis = false): [string, string] | undefined => {
    if (!Array.isArray(k.entities) || k.entities.length !== 2) {
      c.fail(label, `entities must be an array of two entity ids (got ${describe(k.entities)})`);
      return undefined;
    }
    const a = entityRef("entities[0]", k.entities[0], allowed, axis);
    const b = entityRef("entities[1]", k.entities[1], allowed, axis);
    if (a && b && a === b) {
      c.fail(label, `needs two different entities (got "${a}" twice)`);
      return undefined;
    }
    if (a && b && isSketchAxis(a) && isSketchAxis(b)) {
      c.fail(label, "relates the sketch's two axes to each other; one of the pair must be an entity of the sketch");
      return undefined;
    }
    return a && b ? [a, b] : undefined;
  };

  switch (k.type) {
    case "coincident": {
      c.keys(k, label, ["type", "points"]);
      const points = pointPair(k.points);
      return points && c.errors.length === before ? { type: "coincident", points } : null;
    }
    case "horizontal":
    case "vertical": {
      c.keys(k, label, ["type", "entity", "points"]);
      if ((k.entity !== undefined) === (k.points !== undefined)) {
        c.fail(label, "needs exactly one of entity (a line) or points (two point refs)");
        return null;
      }
      if (k.points !== undefined) {
        const points = pointPair(k.points);
        return points && c.errors.length === before ? { type: k.type, points } : null;
      }
      const entity = entityRef("entity", k.entity, ["line"]);
      return entity && c.errors.length === before ? { type: k.type, entity } : null;
    }
    case "distance":
    case "distanceX":
    case "distanceY": {
      c.keys(k, label, ["type", "entity", "points", "point", "line", "value"]);
      const value = c.num(k, "value", label, { nonNegative: true });
      const forms = [k.entity !== undefined, k.points !== undefined, k.point !== undefined || k.line !== undefined].filter(Boolean).length;
      if (forms !== 1) {
        c.fail(label, k.type === "distance" ? "needs exactly one of entity, points, or point with line" : "needs exactly one of entity or points");
        return null;
      }
      if (k.point !== undefined || k.line !== undefined) {
        if (k.type !== "distance") {
          c.fail(label, "a point's distance from a line is a distance, not a distanceX or distanceY");
          return null;
        }
        const point = pointRef(k.point);
        const line = entityRef("line", k.line, ["line"], true);
        if (point && line && point.split(".")[0] === line) c.fail(label, `"${point}" is a point of "${line}" itself`);
        if (value === undefined || !point || !line || c.errors.length > before) return null;
        return { type: "distance", point, line, value };
      }
      const allowed: SketchEntity["type"][] = k.type === "distance" ? ["line", "slot"] : ["line", "rect", "slot"];
      const entity = k.entity !== undefined ? entityRef("entity", k.entity, allowed) : undefined;
      const points = k.points !== undefined ? pointPair(k.points) : undefined;
      if (value === undefined || c.errors.length > before) return null;
      return entity ? { type: k.type, entity, value } : { type: k.type, points: points!, value };
    }
    case "radius":
    case "diameter": {
      c.keys(k, label, ["type", "entity", "value"]);
      const entity = entityRef("entity", k.entity, ["circle", "arc"]);
      const value = c.num(k, "value", label, { positive: true });
      return entity && value !== undefined && c.errors.length === before ? { type: k.type, entity, value } : null;
    }
    case "equal": {
      c.keys(k, label, ["type", "entities"]);
      const pair = entityPair(["line", "circle", "arc"]);
      if (!pair) return null;
      const [a, b] = pair;
      const kind = (id: string) => (entities.get(id) === "line" ? "line" : "round");
      if (kind(a) !== kind(b)) {
        c.fail(label, `cannot make a line equal to a circle or arc ("${a}", "${b}")`);
        return null;
      }
      return c.errors.length === before ? { type: "equal", entities: [a, b] } : null;
    }
    case "parallel":
    case "perpendicular":
    case "collinear":
    case "concentric":
    case "angle": {
      c.keys(k, label, k.type === "angle" ? ["type", "entities", "value"] : ["type", "entities"]);
      const pair = entityPair(k.type === "concentric" ? ["circle", "arc"] : ["line"], k.type !== "concentric");
      if (k.type === "angle") {
        const value = c.num(k, "value", label, {});
        if (value !== undefined && !(value > 0 && value < 180)) c.fail(label, `value must be over 0 and under 180 degrees (got ${value}); for 0 use parallel`);
        return pair && value !== undefined && c.errors.length === before ? { type: "angle", entities: pair, value } : null;
      }
      return pair && c.errors.length === before ? { type: k.type, entities: pair } : null;
    }
    case "tangent": {
      c.keys(k, label, ["type", "entities"]);
      const pair = entityPair(["line", "circle", "arc"], true);
      if (!pair) return null;
      if (pair.every((id) => isSketchAxis(id) || entities.get(id) === "line")) {
        c.fail(label, `two lines cannot be tangent ("${pair[0]}", "${pair[1]}"); use collinear or parallel`);
        return null;
      }
      return c.errors.length === before ? { type: "tangent", entities: pair } : null;
    }
    case "midpoint":
    case "pointOn": {
      c.keys(k, label, ["type", "point", "entity"]);
      const point = pointRef(k.point);
      const entity = entityRef("entity", k.entity, k.type === "midpoint" ? ["line", "slot"] : ["line", "circle", "arc"], k.type === "pointOn");
      if (point && entity && point.split(".")[0] === entity) c.fail(label, `"${point}" is a point of "${entity}" itself`);
      return point && entity && c.errors.length === before ? { type: k.type, point, entity } : null;
    }
    case "symmetric": {
      c.keys(k, label, ["type", "points", "line"]);
      const points = pointPair(k.points);
      const line = entityRef("line", k.line, ["line"], true);
      return points && line && c.errors.length === before ? { type: "symmetric", points, line } : null;
    }
    case "fix": {
      c.keys(k, label, ["type", "entity", "point"]);
      if ((k.entity !== undefined) === (k.point !== undefined)) {
        c.fail(label, "needs exactly one of entity or point");
        return null;
      }
      if (k.point !== undefined) {
        const point = pointRef(k.point);
        if (point === "origin") c.fail(label, "the origin is fixed already");
        else if (point && references.has(point.split(".")[0])) c.fail(label, `"${point}" is a point of a reference entity: it follows the model already`);
        return point && c.errors.length === before ? { type: "fix", point } : null;
      }
      const entity = entityRef("entity", k.entity, ["line", "circle", "arc", "rect", "slot", "point"]);
      if (entity && references.has(entity)) c.fail(label, `"${entity}" is a reference entity: it follows the model already`);
      return entity && c.errors.length === before ? { type: "fix", entity } : null;
    }
    default:
      c.fail(path, `unknown constraint type ${describe(k.type)} (supported: ${CONSTRAINT_TYPES.join(", ")})`);
      return null;
  }
}

export const CONSTRAINT_TYPES = [
  "coincident",
  "horizontal",
  "vertical",
  "distance",
  "distanceX",
  "distanceY",
  "radius",
  "diameter",
  "angle",
  "equal",
  "parallel",
  "perpendicular",
  "collinear",
  "tangent",
  "concentric",
  "midpoint",
  "pointOn",
  "symmetric",
  "fix",
] as const;

// ------------------------------------------------------- extrude and cut

function validateExtrude(
  raw: Record<string, unknown>,
  c: Checker,
  earlier: Map<string, string>,
): ExtrudeFeature | null {
  c.keys(raw, "", raw.op === "extrude" ? ["id", "op", "sketch", "extent", "distance", "direction", "body", "newBody"] : ["id", "op", "sketch", "extent", "distance", "direction", "bodies"]);
  if (typeof raw.sketch !== "string") {
    c.fail("sketch", `must be the id of a sketch feature (got ${describe(raw.sketch)})`);
  } else if (!earlier.has(raw.sketch)) {
    c.fail("sketch", `"${raw.sketch}" is not a feature before this one`);
  } else if (earlier.get(raw.sketch) !== "sketch") {
    c.fail("sketch", `"${raw.sketch}" is a ${earlier.get(raw.sketch)}, not a sketch`);
  }
  const extent = raw.extent ?? "blind";
  if (extent !== "blind" && extent !== "midplane" && extent !== "throughAll") {
    c.fail("extent", `must be "blind", "midplane" or "throughAll" (got ${describe(raw.extent)})`);
  }
  let distance: number | undefined;
  if (extent === "throughAll") {
    if (raw.distance !== undefined) c.fail("distance", "must be omitted when extent is throughAll");
  } else {
    distance = c.num(raw, "distance", "", { positive: true });
  }
  const direction = raw.direction === undefined ? undefined : c.unitVec(raw, "direction", "");
  // Where the material goes: an extrude names a body; a cut, the bodies it cuts. (keys() reports the other fields.)
  const extrude = raw.op === "extrude";
  const body = extrude && raw.body !== undefined ? bodyName(raw.body, "body", c) : undefined;
  const newBody = extrude && raw.newBody !== undefined ? bodyName(raw.newBody, "newBody", c) : undefined;
  if (extrude && raw.body !== undefined && raw.newBody !== undefined) c.fail("", "give body (add to it) or newBody (start one), not both");
  const bodies = !extrude && raw.bodies !== undefined ? bodyList(raw.bodies, "bodies", c) : undefined;
  if (c.errors.length > 0) return null;
  const feature: ExtrudeFeature = { id: raw.id as string, op: raw.op as "extrude" | "cut", sketch: raw.sketch as string };
  if (raw.extent !== undefined) feature.extent = extent as ExtrudeFeature["extent"];
  if (distance !== undefined) feature.distance = distance;
  if (direction) feature.direction = direction;
  if (body) feature.body = body;
  if (newBody) feature.newBody = newBody;
  if (bodies) feature.bodies = bodies;
  return feature;
}

// ------------------------------------------------------------------ hole

function validateHole(raw: Record<string, unknown>, c: Checker): HoleFeature | null {
  c.keys(raw, "", ["id", "op", "face", "center", "diameter", "depth", "counterbore", "countersink", "bodies"]);
  const bodies = raw.bodies === undefined ? undefined : bodyList(raw.bodies, "bodies", c);
  const face = validateFaceSelector(raw.face, "face", c);
  if (face && face.type !== "planar") c.fail("face", `a hole needs a planar face selector (got "${face.type}")`);
  const center = c.vec2(raw, "center", "");
  const diameter = c.num(raw, "diameter", "", { positive: true });
  let depth: number | "through" | undefined;
  if (raw.depth === "through") depth = "through";
  else if (typeof raw.depth === "number" && Number.isFinite(raw.depth) && raw.depth > 0) depth = raw.depth;
  else c.fail("depth", `must be a positive number or "through" (got ${describe(raw.depth)})`);

  let counterbore: HoleFeature["counterbore"];
  let countersink: HoleFeature["countersink"];
  if (raw.counterbore !== undefined && raw.countersink !== undefined) {
    c.fail("", "use counterbore or countersink, not both");
  }
  if (raw.counterbore !== undefined) {
    if (!isObject(raw.counterbore)) {
      c.fail("counterbore", `must be an object (got ${describe(raw.counterbore)})`);
    } else {
      c.keys(raw.counterbore, "counterbore", ["diameter", "depth"]);
      const d = c.num(raw.counterbore, "diameter", "counterbore", { positive: true });
      const t = c.num(raw.counterbore, "depth", "counterbore", { positive: true });
      if (d !== undefined && diameter !== undefined && d <= diameter) {
        c.fail("counterbore.diameter", `must be larger than the hole diameter ${diameter} (got ${d})`);
      }
      if (t !== undefined && typeof depth === "number" && t >= depth) {
        c.fail("counterbore.depth", `must be less than the hole depth ${depth} (got ${t})`);
      }
      if (d !== undefined && t !== undefined) counterbore = { diameter: d, depth: t };
    }
  }
  if (raw.countersink !== undefined) {
    if (!isObject(raw.countersink)) {
      c.fail("countersink", `must be an object (got ${describe(raw.countersink)})`);
    } else {
      c.keys(raw.countersink, "countersink", ["diameter", "angle"]);
      const d = c.num(raw.countersink, "diameter", "countersink", { positive: true });
      const angle = c.num(raw.countersink, "angle", "countersink", { positive: true });
      if (angle !== undefined && angle >= 180) c.fail("countersink.angle", `must be below 180 degrees (got ${angle})`);
      if (d !== undefined && diameter !== undefined && d <= diameter) {
        c.fail("countersink.diameter", `must be larger than the hole diameter ${diameter} (got ${d})`);
      }
      if (d !== undefined && angle !== undefined && angle < 180 && diameter !== undefined && typeof depth === "number") {
        const sinkDepth = (d - diameter) / 2 / Math.tan(((angle / 2) * Math.PI) / 180);
        if (sinkDepth >= depth) {
          c.fail("countersink", `is ${round(sinkDepth)} deep, which reaches the hole depth ${depth}`);
        }
      }
      if (d !== undefined && angle !== undefined) countersink = { diameter: d, angle };
    }
  }
  if (c.errors.length > 0 || !face || !center || diameter === undefined || depth === undefined) return null;
  const hole: HoleFeature = { id: raw.id as string, op: "hole", face, center, diameter, depth };
  if (counterbore) hole.counterbore = counterbore;
  if (countersink) hole.countersink = countersink;
  if (bodies) hole.bodies = bodies;
  return hole;
}

// ---------------------------------------------------- fillet and chamfer

function validateEdgeTreatment(raw: Record<string, unknown>, c: Checker): FilletFeature | ChamferFeature | null {
  const size = raw.op === "fillet" ? "radius" : "distance";
  c.keys(raw, "", ["id", "op", "edges", size]);
  const value = c.num(raw, size, "", { positive: true });
  const edges = edgeSelectors(raw.edges, "edges", c);
  if (c.errors.length > 0 || !edges || value === undefined) return null;
  return raw.op === "fillet"
    ? { id: raw.id as string, op: "fillet", edges, radius: value }
    : { id: raw.id as string, op: "chamfer", edges, distance: value };
}

/** One edge selector, or a non-empty list of them whose matches are combined. */
function edgeSelectors(v: unknown, path: string, c: Checker): EdgeSelector | EdgeSelector[] | null {
  if (!Array.isArray(v)) return validateEdgeSelector(v, path, c);
  if (v.length === 0) c.fail(path, "must list at least one edge selector");
  const list = v.map((e, i) => validateEdgeSelector(e, `${path}[${i}]`, c));
  return v.length > 0 && list.every((e) => e !== null) ? (list as EdgeSelector[]) : null;
}

export function validateEdgeSelector(raw: unknown, path: string, c: Checker): EdgeSelector | null {
  if (!isObject(raw)) {
    c.fail(path, `must be an edge selector object (got ${describe(raw)})`);
    return null;
  }
  const before = c.errors.length;
  c.keys(raw, path, ["type", "kind", "onFace", "between", "direction", "radius", "length", "near", "pick", "body"]);
  const body = raw.body === undefined ? undefined : bodyName(raw.body, `${path}.body`, c);
  if (raw.type !== "edge") c.fail(`${path}.type`, `must be "edge" (got ${describe(raw.type)})`);
  if (!EDGE_PICKS.includes(raw.pick as never)) {
    c.fail(`${path}.pick`, `must be one of ${EDGE_PICKS.map((p) => `"${p}"`).join(", ")} (got ${describe(raw.pick)})`);
  }
  if (raw.kind !== undefined && !["line", "circle", "other"].includes(raw.kind as string)) {
    c.fail(`${path}.kind`, `must be "line", "circle" or "other" (got ${describe(raw.kind)})`);
  }
  const onFace = raw.onFace === undefined ? undefined : validateFaceSelector(raw.onFace, `${path}.onFace`, c);
  let between: [FaceSelector, FaceSelector] | undefined;
  if (raw.between !== undefined) {
    if (!Array.isArray(raw.between) || raw.between.length !== 2) {
      c.fail(`${path}.between`, `must be an array of two face selectors (got ${describe(raw.between)})`);
    } else {
      const a = validateFaceSelector(raw.between[0], `${path}.between[0]`, c);
      const b = validateFaceSelector(raw.between[1], `${path}.between[1]`, c);
      if (a && b) between = [a, b];
    }
  }
  const direction = raw.direction === undefined ? undefined : c.unitVec(raw, "direction", path);
  const radius = raw.radius === undefined ? undefined : c.num(raw, "radius", path, { positive: true });
  const length = raw.length === undefined ? undefined : c.num(raw, "length", path, { positive: true });
  const near = raw.near === undefined ? undefined : c.vec3(raw, "near", path);
  if (direction && raw.kind !== undefined && raw.kind !== "line") {
    c.fail(`${path}.direction`, `applies to straight edges, but kind is ${describe(raw.kind)}`);
  }
  if (radius !== undefined && raw.kind !== undefined && raw.kind !== "circle") {
    c.fail(`${path}.radius`, `applies to circular edges, but kind is ${describe(raw.kind)}`);
  }
  if (c.errors.length > before) return null;
  const sel: EdgeSelector = { type: "edge", pick: raw.pick as EdgeSelector["pick"] };
  if (raw.kind !== undefined) sel.kind = raw.kind as EdgeSelector["kind"];
  if (onFace) sel.onFace = onFace;
  if (between) sel.between = between;
  if (direction) sel.direction = direction;
  if (radius !== undefined) sel.radius = radius;
  if (length !== undefined) sel.length = length;
  if (near) sel.near = near;
  if (body) sel.body = body;
  return sel;
}

// -------------------------------------------------------------- patterns

function validatePattern(
  raw: Record<string, unknown>,
  c: Checker,
  earlier: Map<string, string>,
): LinearPatternFeature | CircularPatternFeature | null {
  const linear = raw.op === "linearPattern";
  c.keys(
    raw,
    "",
    linear
      ? ["id", "op", "feature", "direction", "spacing", "count", "direction2", "spacing2", "count2"]
      : ["id", "op", "feature", "axis", "count", "angle"],
  );
  if (typeof raw.feature !== "string") {
    c.fail("feature", `must be the id of an earlier extrude, cut or hole (got ${describe(raw.feature)})`);
  } else if (!earlier.has(raw.feature)) {
    c.fail("feature", `"${raw.feature}" is not a feature before this one`);
  } else if (!patternable(earlier.get(raw.feature))) {
    c.fail("feature", `"${raw.feature}" is a ${earlier.get(raw.feature)}; a pattern repeats an extrude, cut or hole`);
  }
  const count = instanceCount(raw, "count", c);
  if (linear) {
    const direction = c.unitVec(raw, "direction", "");
    const spacing = c.num(raw, "spacing", "", { positive: true });
    const second = ["direction2", "spacing2", "count2"].filter((k) => raw[k] !== undefined);
    let direction2: [number, number, number] | undefined;
    let spacing2: number | undefined;
    let count2: number | undefined;
    if (second.length > 0 && second.length < 3) {
      c.fail("", "a second direction needs direction2, spacing2 and count2 together");
    } else if (second.length === 3) {
      direction2 = c.unitVec(raw, "direction2", "");
      spacing2 = c.num(raw, "spacing2", "", { positive: true });
      count2 = instanceCount(raw, "count2", c);
      if (direction && direction2) {
        const n1 = Math.hypot(...direction);
        const n2 = Math.hypot(...direction2);
        const cos = Math.abs(direction[0] * direction2[0] + direction[1] * direction2[1] + direction[2] * direction2[2]) / (n1 * n2);
        if (cos > 1 - 1e-9) c.fail("direction2", "must not be parallel to direction");
      }
    }
    if (c.errors.length > 0 || !direction || spacing === undefined || count === undefined) return null;
    const f: LinearPatternFeature = { id: raw.id as string, op: "linearPattern", feature: raw.feature as string, direction, spacing, count };
    if (direction2 && spacing2 !== undefined && count2 !== undefined) Object.assign(f, { direction2, spacing2, count2 });
    return f;
  }
  let axis: CircularPatternFeature["axis"] | undefined;
  if (!isObject(raw.axis)) {
    c.fail("axis", `must be { "origin": [x, y, z], "direction": [x, y, z] } (got ${describe(raw.axis)})`);
  } else {
    c.keys(raw.axis, "axis", ["origin", "direction"]);
    const origin = c.vec3(raw.axis, "origin", "axis");
    const direction = c.unitVec(raw.axis, "direction", "axis");
    if (origin && direction) axis = { origin, direction };
  }
  const angle = raw.angle === undefined ? undefined : c.num(raw, "angle", "", { positive: true });
  if (angle !== undefined && angle > 360) c.fail("angle", `must be at most 360 degrees (got ${angle})`);
  if (c.errors.length > 0 || !axis || count === undefined) return null;
  const f: CircularPatternFeature = { id: raw.id as string, op: "circularPattern", feature: raw.feature as string, axis, count };
  if (angle !== undefined) f.angle = angle;
  return f;
}

function instanceCount(raw: Record<string, unknown>, key: string, c: Checker): number | undefined {
  const v = raw[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 2 || v > 1000) {
    c.fail(key, `must be a whole number from 2 to 1000, counting the original (got ${describe(v)})`);
    return undefined;
  }
  return v;
}

export function validateFaceSelector(raw: unknown, path: string, c: Checker): FaceSelector | null {
  if (!isObject(raw)) {
    c.fail(path, `must be a face selector object (got ${describe(raw)})`);
    return null;
  }
  const before = c.errors.length;
  const pick = raw.pick;
  if (!PICKS.includes(pick as never)) {
    c.fail(`${path}.pick`, `must be one of ${PICKS.map((p) => `"${p}"`).join(", ")} (got ${describe(pick)})`);
  }
  switch (raw.type) {
    case "planar": {
      c.keys(raw, path, ["type", "normal", "pick", "offset", "near", "body"]);
      const normal = c.unitVec(raw, "normal", path);
      const offset = raw.offset === undefined ? undefined : c.num(raw, "offset", path, {});
      const near = raw.near === undefined ? undefined : c.vec3(raw, "near", path);
      const body = raw.body === undefined ? undefined : bodyName(raw.body, `${path}.body`, c);
      if (!normal || c.errors.length > before) return null;
      const s: FaceSelector = { type: "planar", normal, pick: pick as FaceSelector["pick"] };
      if (offset !== undefined) s.offset = offset;
      if (near) s.near = near;
      if (body) s.body = body;
      return s;
    }
    case "cylindrical": {
      c.keys(raw, path, ["type", "radius", "axis", "pick", "near", "body"]);
      const radius = raw.radius === undefined ? undefined : c.num(raw, "radius", path, { positive: true });
      const axis = raw.axis === undefined ? undefined : c.unitVec(raw, "axis", path);
      const near = raw.near === undefined ? undefined : c.vec3(raw, "near", path);
      const body = raw.body === undefined ? undefined : bodyName(raw.body, `${path}.body`, c);
      if (c.errors.length > before) return null;
      const s: FaceSelector = { type: "cylindrical", pick: pick as FaceSelector["pick"] };
      if (radius !== undefined) s.radius = radius;
      if (axis) s.axis = axis;
      if (near) s.near = near;
      if (body) s.body = body;
      return s;
    }
    default:
      c.fail(`${path}.type`, `must be "planar" or "cylindrical" (got ${describe(raw.type)})`);
      return null;
  }
}

// ------------------------------------------------------- weldment profiles

const XY = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };

/** A weldment profile: its sketch, checked like any sketch with its own size parameters, and its sizes. */
export function validateProfile(input: unknown, path: string, c: Checker): ProfileDef | null {
  if (!isObject(input)) {
    c.fail(path, `must be a profile object (got ${describe(input)})`);
    return null;
  }
  const before = c.errors.length;
  c.keys(input, path, [...PROFILE_KEYS]);
  if (typeof input.name !== "string" || !input.name.trim()) c.fail(`${path}.name`, `must be the profile's name (got ${describe(input.name)})`);
  const parameters: Record<string, number> = {};
  if (!isObject(input.parameters)) c.fail(`${path}.parameters`, `must be an object of name: number (got ${describe(input.parameters)})`);
  else {
    for (const [k, v] of Object.entries(input.parameters)) {
      if (!PARAMETER_NAME.test(k)) c.fail(`${path}.parameters.${k}`, "a parameter name is letters, digits and _ and starts with a letter");
      else if (typeof v !== "number" || !Number.isFinite(v)) c.fail(`${path}.parameters.${k}`, `must be a number (got ${describe(v)})`);
      else parameters[k] = v;
    }
  }
  // The sketch, checked as one: its expressions use the profile's own parameters.
  const exprErrors: string[] = [];
  const sketchRaw = resolveExpressions({ id: "profile", op: "sketch", plane: XY, entities: input.entities, ...(input.constraints !== undefined ? { constraints: input.constraints } : {}) }, parameters, exprErrors) as Record<string, unknown>;
  for (const e of exprErrors) c.fail(path, e);
  const inner = new Checker(path);
  if (!exprErrors.length) validateSketch(sketchRaw, inner, new Map(), { profile: true });
  for (const e of inner.errors) c.errors.push(e);
  const sizes: ProfileDef["sizes"] = [];
  if (!Array.isArray(input.sizes) || input.sizes.length === 0) c.fail(`${path}.sizes`, `must list at least one size (got ${describe(input.sizes)})`);
  else {
    input.sizes.forEach((sz, i) => {
      const at = `${path}.sizes[${i}]`;
      if (!isObject(sz)) return c.fail(at, `must be { "designation", "values" } (got ${describe(sz)})`);
      c.keys(sz, at, ["designation", "values"]);
      const designation = typeof sz.designation === "string" ? sz.designation.trim() : "";
      if (!designation) c.fail(`${at}.designation`, `must name the size, like "SHS 40x40x3" (got ${describe(sz.designation)})`);
      else if (sizes.some((x) => x.designation === designation)) c.fail(`${at}.designation`, `"${designation}" is listed twice`);
      const values: Record<string, number> = {};
      if (!isObject(sz.values)) c.fail(`${at}.values`, `must be an object of parameter: number (got ${describe(sz.values)})`);
      else {
        for (const [k, v] of Object.entries(sz.values)) {
          if (!(k in parameters)) c.fail(`${at}.values.${k}`, `is not one of the profile's parameters (${Object.keys(parameters).join(", ") || "none"})`);
          else if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) c.fail(`${at}.values.${k}`, `must be a number greater than 0 (got ${describe(v)})`);
          else values[k] = v;
        }
        for (const k of Object.keys(parameters)) if (!(k in sz.values)) c.fail(`${at}.values`, `needs a value for ${k}`);
      }
      if (designation) sizes.push({ designation, values });
    });
  }
  if (input.anchor !== "centroid" && input.anchor !== "origin") c.fail(`${path}.anchor`, `must be "centroid" or "origin" (got ${describe(input.anchor)})`);
  if (!Array.isArray(input.tags) || !input.tags.every((t) => typeof t === "string")) c.fail(`${path}.tags`, `must be a list of words (got ${describe(input.tags)})`);
  if (input.material !== undefined && typeof input.material !== "string") c.fail(`${path}.material`, `must be a string (got ${describe(input.material)})`);
  const library = input.library === undefined ? undefined : libraryRef(input.library, `${path}.library`, c);
  if (c.errors.length > before) return null;
  const def: ProfileDef = {
    name: input.name as string,
    entities: input.entities as ProfileDef["entities"],
    ...(input.constraints !== undefined ? { constraints: input.constraints as ProfileDef["constraints"] } : {}),
    parameters,
    sizes,
    anchor: input.anchor as ProfileDef["anchor"],
    tags: input.tags as string[],
  };
  if (typeof input.material === "string") def.material = input.material;
  if (library) def.library = library;
  return def;
}

function libraryRef(v: unknown, path: string, c: Checker): { id: string; version: number } | undefined {
  if (!isObject(v) || typeof v.id !== "string" || !v.id || !Number.isInteger(v.version) || (v.version as number) < 1) {
    c.fail(path, `must be { "id": "...", "version": 1 or more } (got ${describe(v)})`);
    return undefined;
  }
  c.keys(v, path, ["id", "version"]);
  return { id: v.id, version: v.version as number };
}

function validateMember(raw: Record<string, unknown>, c: Checker, ctx: FeatureContext): MemberFeature | null {
  const { profiles, listed } = ctx;
  c.keys(raw, "", ["id", "op", "profile", "size", "from", "to", "rotation", "align", "newBody"]);
  const profile = typeof raw.profile === "string" ? profiles[raw.profile] : undefined;
  if (typeof raw.profile !== "string") c.fail("profile", `must name a profile in the part's profiles (got ${describe(raw.profile)})`);
  else if (!profile && listed.includes(raw.profile)) c.fail("profile", `the part's profile "${raw.profile}" has errors (see profiles.${raw.profile})`);
  else if (!profile) c.fail("profile", `no profile "${raw.profile}" in the part (${listed.length ? `profiles: ${listed.join(", ")}` : "it has none: add one from the section library"})`);
  if (typeof raw.size !== "string") c.fail("size", `must be one of the profile's designations (got ${describe(raw.size)})`);
  else if (profile && !profile.sizes.some((s) => s.designation === raw.size)) {
    c.fail("size", `"${raw.size}" is not a size of ${profile.name} (sizes: ${profile.sizes.map((s) => s.designation).join(", ")})`);
  }
  // An end is a point, or the name of a node.
  const end = (key: "from" | "to"): [Vec3 | undefined, string | undefined] => {
    const v = raw[key];
    if (typeof v !== "string") return [c.vec3(raw, key, ""), undefined];
    if (!(v in ctx.nodes)) {
      const names = Object.keys(ctx.nodes);
      c.fail(key, `no node "${v}" (${names.length ? `nodes: ${names.join(", ")}` : "the part has no nodes"})`);
      return [undefined, undefined];
    }
    return [ctx.nodes[v], v];
  };
  const [from, fromNode] = end("from");
  const [to, toNode] = end("to");
  if (from && to && Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) < 1e-6) {
    c.fail("to", fromNode && toNode ? `nodes ${fromNode} and ${toNode} are the same point` : "must not be the same point as from");
  }
  const rotation = raw.rotation === undefined ? undefined : c.num(raw, "rotation", "", {});
  let align: Vec2 | undefined;
  if (raw.align !== undefined) {
    align = c.vec2(raw, "align", "");
    if (align && !align.every((a) => a >= -1 && a <= 1)) {
      c.fail("align", `must be two numbers from -1 to 1, a place on the section's envelope (got ${describe(raw.align)})`);
      align = undefined;
    }
  }
  const newBody = raw.newBody === undefined ? undefined : bodyName(raw.newBody, "newBody", c);
  if (c.errors.length > 0 || !from || !to) return null;
  const f: MemberFeature = { id: raw.id as string, op: "member", profile: raw.profile as string, size: raw.size as string, from, to };
  if (fromNode) f.fromNode = fromNode;
  if (toNode) f.toNode = toNode;
  if (rotation !== undefined) f.rotation = rotation;
  if (align) f.align = align;
  if (newBody) f.newBody = newBody;
  return f;
}

// ---------------------------------------------------------------- frames

/** How a member meets a node: it ends there, its line passes through it, or neither. */
export function memberAtNode(m: MemberFeature, node: string, at: Vec3): "ends" | "passes" | null {
  if (m.fromNode === node || m.toNode === node) return "ends";
  const d: Vec3 = [m.to[0] - m.from[0], m.to[1] - m.from[1], m.to[2] - m.from[2]];
  const l2 = dot3(d, d);
  const t = dot3([at[0] - m.from[0], at[1] - m.from[1], at[2] - m.from[2]], d) / l2;
  if (t < 0 || t > 1) return null;
  const off = Math.hypot(m.from[0] + t * d[0] - at[0], m.from[1] + t * d[1] - at[1], m.from[2] + t * d[2] - at[2]);
  return off <= 0.01 ? "passes" : null;
}

/** A member named by a joint, gusset or end cap: an earlier member, valid. */
function namedMember(id: unknown, path: string, c: Checker, earlier: Map<string, string>, ctx: FeatureContext): MemberFeature | undefined {
  if (typeof id !== "string") {
    c.fail(path, `must be a member's id (got ${describe(id)})`);
    return undefined;
  }
  const m = ctx.members.get(id);
  if (m) return m;
  if (earlier.get(id) === "member") c.fail(path, `member "${id}" has errors`);
  else if (earlier.has(id)) c.fail(path, `"${id}" is a ${earlier.get(id)}, not a member`);
  else c.fail(path, `no member "${id}" before this feature`);
  return undefined;
}

function nodeName(raw: Record<string, unknown>, c: Checker, ctx: FeatureContext): string | undefined {
  if (typeof raw.node === "string" && raw.node in ctx.nodes) return raw.node;
  const names = Object.keys(ctx.nodes);
  c.fail("node", `must name a node (got ${describe(raw.node)}; ${names.length ? `nodes: ${names.join(", ")}` : "the part has no nodes"})`);
  return undefined;
}

function validateJoint(raw: Record<string, unknown>, c: Checker, earlier: Map<string, string>, ctx: FeatureContext): JointFeature | null {
  c.keys(raw, "", ["id", "op", "node", "type", "members", "through", "gap"]);
  const node = nodeName(raw, c, ctx);
  if (!JOINT_TYPES.includes(raw.type as never)) c.fail("type", `must be ${JOINT_TYPES.map((t) => `"${t}"`).join(" or ")} (got ${describe(raw.type)})`);
  const gap = raw.gap === undefined ? undefined : c.num(raw, "gap", "", { nonNegative: true });
  if (node && ctx.joints.has(node)) c.fail("node", `${node} already has a joint (${ctx.joints.get(node)}); a node has one`);
  if (!node || c.errors.length) return null;
  const at = ctx.nodes[node];
  const ending = [...ctx.members.values()].filter((m) => memberAtNode(m, node, at) === "ends").map((m) => m.id);
  const f: JointFeature = { id: raw.id as string, op: "joint", node, type: raw.type as JointFeature["type"] };
  if (raw.type === "mitre") {
    if (raw.through !== undefined) c.fail("through", "is for a butt joint; a mitre names its two members");
    let pair: string[] | undefined;
    if (raw.members === undefined) {
      if (ending.length !== 2) c.fail("members", `${ending.length} members end at ${node}${ending.length ? ` (${ending.join(", ")})` : ""}: name the two to mitre`);
      else pair = ending;
    } else if (!Array.isArray(raw.members) || raw.members.length !== 2 || raw.members[0] === raw.members[1]) {
      c.fail("members", `must be two different members (got ${describe(raw.members)})`);
    } else {
      raw.members.forEach((id, i) => {
        const m = namedMember(id, `members[${i}]`, c, earlier, ctx);
        if (m && memberAtNode(m, node, at) !== "ends") c.fail(`members[${i}]`, `${m.id} does not end at ${node}`);
      });
      pair = raw.members as string[];
    }
    if (pair) f.members = [pair[0], pair[1]];
  } else if (raw.type === "butt") {
    if (raw.members !== undefined) c.fail("members", "is for a mitre; a butt joint names the member that runs through");
    const through = namedMember(raw.through, "through", c, earlier, ctx);
    if (through && !memberAtNode(through, node, at)) c.fail("through", `${through.id} neither ends at ${node} nor passes through it`);
    if (through && !ending.some((id) => id !== through.id)) c.fail("through", `no other member ends at ${node} to butt against ${through.id}`);
    if (through) f.through = through.id;
  }
  if (gap !== undefined) f.gap = gap;
  return c.errors.length ? null : f;
}

function validateEndCap(raw: Record<string, unknown>, c: Checker, earlier: Map<string, string>, ctx: FeatureContext): EndCapFeature | null {
  c.keys(raw, "", ["id", "op", "member", "end", "thickness", "newBody"]);
  const member = namedMember(raw.member, "member", c, earlier, ctx);
  if (raw.end !== "start" && raw.end !== "end") c.fail("end", `must be "start" (the member's from end) or "end" (got ${describe(raw.end)})`);
  const thickness = c.num(raw, "thickness", "", { positive: true });
  const newBody = raw.newBody === undefined ? undefined : bodyName(raw.newBody, "newBody", c);
  if (c.errors.length || !member || thickness === undefined) return null;
  const f: EndCapFeature = { id: raw.id as string, op: "endCap", member: member.id, end: raw.end as EndCapFeature["end"], thickness };
  if (newBody) f.newBody = newBody;
  return f;
}

function validateGusset(raw: Record<string, unknown>, c: Checker, earlier: Map<string, string>, ctx: FeatureContext): GussetFeature | null {
  c.keys(raw, "", ["id", "op", "node", "members", "size", "thickness", "chamfer", "newBody"]);
  const node = nodeName(raw, c, ctx);
  if (!Array.isArray(raw.members) || raw.members.length !== 2 || raw.members[0] === raw.members[1]) {
    c.fail("members", `must be the two members it joins (got ${describe(raw.members)})`);
  } else if (node) {
    raw.members.forEach((id, i) => {
      const m = namedMember(id, `members[${i}]`, c, earlier, ctx);
      if (m && !memberAtNode(m, node, ctx.nodes[node])) c.fail(`members[${i}]`, `${m.id} neither ends at ${node} nor passes through it`);
    });
  }
  const size = c.num(raw, "size", "", { positive: true });
  const thickness = c.num(raw, "thickness", "", { positive: true });
  const chamfer = raw.chamfer === undefined ? undefined : c.num(raw, "chamfer", "", { nonNegative: true });
  if (size !== undefined && chamfer !== undefined && chamfer >= size) c.fail("chamfer", `must be less than the size (${size})`);
  const newBody = raw.newBody === undefined ? undefined : bodyName(raw.newBody, "newBody", c);
  if (c.errors.length || !node || size === undefined || thickness === undefined) return null;
  const pair = raw.members as [string, string];
  const f: GussetFeature = { id: raw.id as string, op: "gusset", node, members: [pair[0], pair[1]], size, thickness };
  if (chamfer !== undefined) f.chamfer = chamfer;
  if (newBody) f.newBody = newBody;
  return f;
}

/** The weld table: notes on bodies the part makes. */
function checkWelds(input: unknown, bodies: string[], c: Checker): Weld[] {
  if (!Array.isArray(input)) {
    c.fail("welds", `must be a list of welds (got ${describe(input)})`);
    return [];
  }
  const out: Weld[] = [];
  const ids = new Set<string>();
  input.forEach((w, i) => {
    const at = `welds[${i}]`;
    if (!isObject(w)) return c.fail(at, `must be a weld object (got ${describe(w)})`);
    const before = c.errors.length;
    c.keys(w, at, [...WELD_KEYS]);
    if (typeof w.id !== "string" || !ID_PATTERN.test(w.id)) c.fail(`${at}.id`, `must be an identifier like "w1" (got ${describe(w.id)})`);
    else if (ids.has(w.id)) c.fail(`${at}.id`, `duplicate weld id "${w.id}"`);
    else ids.add(w.id);
    if (!Array.isArray(w.between) || w.between.length === 0) c.fail(`${at}.between`, `must list the bodies it joins (got ${describe(w.between)})`);
    else
      w.between.forEach((b, k) => {
        if (typeof b !== "string" || !bodies.includes(b)) c.fail(`${at}.between[${k}]`, `no body ${describe(b)} (bodies: ${bodies.join(", ") || "none"})`);
      });
    if (!WELD_TYPES.includes(w.type as never)) c.fail(`${at}.type`, `must be ${WELD_TYPES.map((t) => `"${t}"`).join(", ")} (got ${describe(w.type)})`);
    c.num(w, "size", at, { positive: true });
    c.num(w, "length", at, { positive: true });
    if (w.allRound !== undefined && typeof w.allRound !== "boolean") c.fail(`${at}.allRound`, `must be true or false (got ${describe(w.allRound)})`);
    if (w.note !== undefined && typeof w.note !== "string") c.fail(`${at}.note`, `must be a string (got ${describe(w.note)})`);
    if (c.errors.length === before) out.push(w as unknown as Weld);
  });
  return out;
}

// ------------------------------------------------------- multibody tools

/**
 * A plane: written out, { "type": "datum", "normal", "origin", "xDir"? }, or
 * by reference (DESIGN §2.3), { "type": "ref", "ref": <DatumRef>, "offset"?,
 * "flip"?, "xDir"? }: a face, a default plane or a plane feature, resolved
 * when the part rebuilds.
 */
export function validatePlane(v: unknown, path: string, c: Checker, earlier: ReadonlyMap<string, string>): PlaneSpec | undefined {
  if (!isObject(v)) {
    c.fail(path, `must be a plane: { "type": "datum", "normal": [x, y, z], "origin": [x, y, z] } or { "type": "ref", "ref": { "face": <face selector> } } (got ${describe(v)})`);
    return undefined;
  }
  const before = c.errors.length;
  if (v.type === "ref") {
    c.keys(v, path, ["type", "ref", "offset", "flip", "xDir"]);
    const ref = validateDatumRef(v.ref, `${path}.ref`, c, earlier, "plane");
    const offset = v.offset === undefined ? undefined : c.num(v, "offset", path, {});
    if (v.flip !== undefined && typeof v.flip !== "boolean") c.fail(`${path}.flip`, `must be true or false (got ${describe(v.flip)})`);
    const xDir = v.xDir === undefined ? undefined : c.unitVec(v, "xDir", path);
    if (!ref || c.errors.length > before) return undefined;
    return { type: "ref", ref, ...(offset !== undefined ? { offset } : {}), ...(v.flip !== undefined ? { flip: v.flip as boolean } : {}), ...(xDir ? { xDir } : {}) };
  }
  if (v.type !== "datum") {
    c.fail(`${path}.type`, `must be "datum" (written out) or "ref" (by reference) (got ${describe(v.type)})`);
    return undefined;
  }
  c.keys(v, path, ["type", "normal", "origin", "xDir"]);
  const normal = c.unitVec(v, "normal", path);
  const origin = c.vec3(v, "origin", path);
  const xDir = v.xDir === undefined ? undefined : c.unitVec(v, "xDir", path);
  if (normal && xDir && Math.abs(dot3(normalize3(normal), normalize3(xDir))) > 1 - 1e-9) {
    c.fail(`${path}.xDir`, "must not be parallel to the plane normal");
  }
  if (!normal || !origin || c.errors.length > before) return undefined;
  return { type: "datum", normal, origin, ...(xDir ? { xDir } : {}) };
}

/**
 * A DatumRef (DESIGN §2.1): { "datum": <default or earlier plane, axis or
 * point feature> }, { "face": <face selector> }, { "edge": <edge selector>,
 * "at"? }, or { "point": [x, y, z] }. `want` refuses a reference that cannot
 * be that kind as far as the document says (a default axis where a plane is
 * needed); faces and edges are checked again when the part rebuilds.
 */
export function validateDatumRef(v: unknown, path: string, c: Checker, earlier: ReadonlyMap<string, string>, want?: DatumKind | readonly DatumKind[]): DatumRef | null {
  if (!isObject(v)) {
    c.fail(path, `must be a reference: { "datum": "Top" }, { "face": <face selector> }, { "edge": <edge selector> } or { "point": [x, y, z] } (got ${describe(v)})`);
    return null;
  }
  const forms = ["datum", "face", "edge", "point"].filter((k) => k in v);
  if (forms.length !== 1) {
    c.fail(path, forms.length ? `give one of datum, face, edge or point (got ${forms.join(" and ")})` : `needs one of datum, face, edge or point (got ${describe(v)})`);
    return null;
  }
  const before = c.errors.length;
  let ref: DatumRef | null = null;
  switch (forms[0]) {
    case "datum": {
      c.keys(v, path, ["datum"]);
      const id = v.datum;
      if (typeof id !== "string" || id === "") {
        c.fail(`${path}.datum`, `must name a default (${RESERVED_DATUMS.join(", ")}) or an earlier plane, axis or point (got ${describe(id)})`);
      } else if (!defaultDatum(id) && !earlier.has(id)) {
        c.fail(`${path}.datum`, `"${id}" is not a feature before this one (the defaults are ${RESERVED_DATUMS.join(", ")})`);
      } else if (!defaultDatum(id) && !Object.hasOwn(DATUM_OPS, earlier.get(id)!)) {
        c.fail(`${path}.datum`, `"${id}" is ${article(earlier.get(id)!)}, not a plane, axis or point`);
      } else {
        ref = { datum: id };
      }
      break;
    }
    case "face": {
      c.keys(v, path, ["face"]);
      const face = validateFaceSelector(v.face, `${path}.face`, c);
      if (face) ref = { face };
      break;
    }
    case "edge": {
      c.keys(v, path, ["edge", "at"]);
      const edge = validateEdgeSelector(v.edge, `${path}.edge`, c);
      if (v.at !== undefined && !EDGE_POINTS.includes(v.at as EdgePoint)) {
        c.fail(`${path}.at`, `must be ${EDGE_POINTS.map((p) => `"${p}"`).join(", ")} (got ${describe(v.at)})`);
      }
      if (edge && c.errors.length === before) ref = v.at === undefined ? { edge } : { edge, at: v.at as EdgePoint };
      break;
    }
    case "point": {
      c.keys(v, path, ["point"]);
      const point = c.vec3(v, "point", path);
      if (point) ref = { point };
      break;
    }
  }
  if (!ref || c.errors.length > before) return null;
  const wants = want === undefined ? undefined : typeof want === "string" ? [want as DatumKind] : (want as readonly DatumKind[]);
  if (wants) {
    const kinds = possibleKinds(ref, earlier);
    if (!kinds.some((k) => wants.includes(k))) {
      c.fail(path, `${refName(ref)} is ${aKinds(kinds)}, but ${aKinds(wants)} is needed here`);
      return null;
    }
  }
  return ref;
}

const EDGE_POINTS: readonly EdgePoint[] = ["start", "end", "mid", "center"];

/** A reference as the messages name it: "Top", "plane_1", "a face", "the start of an edge", "[1, 2, 3]". */
function refName(ref: DatumRef): string {
  if ("datum" in ref) return ref.datum;
  if ("face" in ref) return "a face";
  if ("edge" in ref) return ref.at ? `the ${ref.at === "mid" ? "middle" : ref.at} of an edge` : "an edge";
  return `the point ${describe(ref.point)}`;
}

/** "an extrude", "a sketch". */
function article(word: string): string {
  return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
}

/** A pattern or mirror can repeat it: a built-in seed op, or a registry op that says so. */
function patternable(op: string | undefined): boolean {
  return PATTERNABLE_OPS.includes(op as never) || !!defOf(op)?.patternable;
}

/** The registry op's validation helpers, bound to this feature's checker. */
function validateKit(c: Checker, earlier: ReadonlyMap<string, string>, ctx: FeatureContext): ValidateKit {
  const where = (path: string, key: string) => (path ? `${path}.${key}` : key);
  const feature = (v: unknown, path: string, ops: readonly string[], what: string): string | undefined => {
    if (typeof v !== "string") c.fail(path, `must be the id of ${what} before this one (got ${describe(v)})`);
    else if (!earlier.has(v)) c.fail(path, `"${v}" is not a feature before this one`);
    else if (!ops.includes(earlier.get(v)!)) c.fail(path, `"${v}" is ${article(earlier.get(v)!)}, not ${what}`);
    else return v;
    return undefined;
  };
  return {
    earlier,
    ctx,
    isObject,
    describe,
    bool(obj, key, path) {
      const v = obj[key];
      if (v === undefined || typeof v === "boolean") return v;
      c.fail(where(path, key), `must be true or false (got ${describe(v)})`);
      return undefined;
    },
    oneOf(obj, key, path, values) {
      const v = obj[key];
      if (values.includes(v as never)) return v as (typeof values)[number];
      c.fail(where(path, key), `must be ${values.map((x) => `"${x}"`).join(", ")} (got ${describe(v)})`);
      return undefined;
    },
    bodyName: (v, path) => bodyName(v, path, c),
    bodyList: (v, path) => bodyList(v, path, c),
    newBody: (raw) => optionalNewBody(raw, c),
    faceSelector: (v, path) => validateFaceSelector(v, path, c),
    faceSelectors(v, path, opts = {}) {
      if (!Array.isArray(v) || (v.length === 0 && !opts.allowEmpty)) {
        c.fail(path, `must be a list of face selectors${opts.allowEmpty ? "" : " (at least one)"} (got ${describe(v)})`);
        return null;
      }
      const list = v.map((s, i) => validateFaceSelector(s, `${path}[${i}]`, c));
      return list.every((s) => s !== null) ? (list as FaceSelector[]) : null;
    },
    edgeSelector: (v, path) => validateEdgeSelector(v, path, c),
    edgeSelectors: (v, path) => edgeSelectors(v, path, c),
    datumRef: (v, path, want) => validateDatumRef(v, path, c, earlier, want),
    plane: (v, path) => validatePlane(v, path, c, earlier),
    feature,
    sketch: (v, path) => feature(v, path, ["sketch"], "a sketch"),
    direction: (obj, key, path) => c.unitVec(obj, key, path),
  };
}

function optionalNewBody(raw: Record<string, unknown>, c: Checker): string | undefined {
  return raw.newBody === undefined ? undefined : bodyName(raw.newBody, "newBody", c);
}

function validateMirror(raw: Record<string, unknown>, c: Checker, earlier: Map<string, string>): MirrorFeature | null {
  c.keys(raw, "", ["id", "op", "plane", "feature", "bodies", "merge", "newBody"]);
  const plane = validatePlane(raw.plane, "plane", c, earlier);
  const byFeature = raw.feature !== undefined;
  if (byFeature === (raw.bodies !== undefined)) c.fail("", 'mirrors either one "feature" or a list of "bodies"');
  let bodies: string[] | undefined;
  if (byFeature) {
    if (typeof raw.feature !== "string" || !earlier.has(raw.feature)) c.fail("feature", `${describe(raw.feature)} is not a feature before this one`);
    else if (!patternable(earlier.get(raw.feature))) c.fail("feature", `"${raw.feature}" is a ${earlier.get(raw.feature)}; a mirror repeats an extrude, cut, hole or member`);
    if (raw.merge !== undefined) c.fail("merge", "merges a mirrored body into itself: it goes with \"bodies\"");
  } else if (raw.bodies !== undefined) {
    bodies = bodyList(raw.bodies, "bodies", c);
  }
  if (raw.merge !== undefined && typeof raw.merge !== "boolean") c.fail("merge", `must be true or false (got ${describe(raw.merge)})`);
  const newBody = optionalNewBody(raw, c);
  if (newBody !== undefined && raw.merge === true) c.fail("newBody", "a merged mirror makes no new body");
  if (newBody !== undefined && bodies && bodies.length > 1) c.fail("newBody", "names one new body; with several, each is <name>_mirror");
  if (c.errors.length > 0 || !plane) return null;
  return {
    id: raw.id as string,
    op: "mirror",
    plane,
    ...(byFeature ? { feature: raw.feature as string } : { bodies }),
    ...(raw.merge === true ? { merge: true } : {}),
    ...(newBody ? { newBody } : {}),
  };
}

function validateSplit(raw: Record<string, unknown>, c: Checker, earlier: Map<string, string>): SplitFeature | null {
  c.keys(raw, "", ["id", "op", "body", "plane", "newBody"]);
  const body = bodyName(raw.body, "body", c);
  const plane = validatePlane(raw.plane, "plane", c, earlier);
  const newBody = optionalNewBody(raw, c);
  if (newBody && newBody === body) c.fail("newBody", "must differ from the body it is split from");
  if (c.errors.length > 0 || !body || !plane) return null;
  return { id: raw.id as string, op: "split", body, plane, ...(newBody ? { newBody } : {}) };
}

function validateMove(raw: Record<string, unknown>, c: Checker): MoveFeature | null {
  c.keys(raw, "", ["id", "op", "bodies", "translate", "rotate", "copy", "newBody"]);
  const bodies = bodyList(raw.bodies, "bodies", c);
  const translate = raw.translate === undefined ? undefined : c.vec3(raw, "translate", "");
  let rotate: MoveFeature["rotate"];
  if (raw.rotate !== undefined) {
    if (!isObject(raw.rotate)) c.fail("rotate", `must be { "axis": { "origin", "direction" }, "angle" } (got ${describe(raw.rotate)})`);
    else {
      c.keys(raw.rotate, "rotate", ["axis", "angle"]);
      const angle = c.num(raw.rotate, "angle", "rotate", {});
      let axis: { origin: Vec3; direction: Vec3 } | undefined;
      if (!isObject(raw.rotate.axis)) c.fail("rotate.axis", `must be { "origin": [x, y, z], "direction": [x, y, z] } (got ${describe(raw.rotate.axis)})`);
      else {
        c.keys(raw.rotate.axis, "rotate.axis", ["origin", "direction"]);
        const origin = c.vec3(raw.rotate.axis, "origin", "rotate.axis");
        const direction = c.unitVec(raw.rotate.axis, "direction", "rotate.axis");
        if (origin && direction) axis = { origin, direction };
      }
      if (axis && angle !== undefined) rotate = { axis, angle };
    }
  }
  if (raw.translate === undefined && raw.rotate === undefined) c.fail("", 'needs "translate", "rotate" or both');
  if (raw.copy !== undefined && typeof raw.copy !== "boolean") c.fail("copy", `must be true or false (got ${describe(raw.copy)})`);
  const newBody = optionalNewBody(raw, c);
  if (newBody !== undefined && raw.copy !== true) c.fail("newBody", "names a copy: it goes with \"copy\": true");
  if (newBody !== undefined && bodies && bodies.length > 1) c.fail("newBody", "names one copy; with several, each is <name>_copy");
  if (c.errors.length > 0 || !bodies) return null;
  return {
    id: raw.id as string,
    op: "move",
    bodies,
    ...(translate ? { translate } : {}),
    ...(rotate ? { rotate } : {}),
    ...(raw.copy === true ? { copy: true } : {}),
    ...(newBody ? { newBody } : {}),
  };
}

function validateDeleteBody(raw: Record<string, unknown>, c: Checker): DeleteBodyFeature | null {
  c.keys(raw, "", ["id", "op", "bodies", "keep"]);
  if ((raw.bodies === undefined) === (raw.keep === undefined)) {
    c.fail("", 'names the bodies to delete ("bodies") or the ones to keep ("keep")');
    return null;
  }
  const list = raw.bodies !== undefined ? bodyList(raw.bodies, "bodies", c) : bodyList(raw.keep, "keep", c);
  if (c.errors.length > 0 || !list) return null;
  return { id: raw.id as string, op: "deleteBody", ...(raw.bodies !== undefined ? { bodies: list } : { keep: list }) };
}

function checkMaterial(v: unknown, path: string, c: Checker): Material | null {
  if (!isObject(v)) {
    c.fail(path, `must be { "name": ..., "densityKgPerM3": ... } (got ${describe(v)})`);
    return null;
  }
  const before = c.errors.length;
  c.keys(v, path, ["name", "densityKgPerM3"]);
  if (v.name !== undefined && typeof v.name !== "string") c.fail(`${path}.name`, `must be text (got ${describe(v.name)})`);
  const density = c.num(v, "densityKgPerM3", path, { positive: true });
  if (c.errors.length > before || density === undefined) return null;
  return { ...(typeof v.name === "string" ? { name: v.name } : {}), densityKgPerM3: density };
}

// ---------------------------------------------------------------- combine

function validateCombine(raw: Record<string, unknown>, c: Checker): CombineFeature | null {
  c.keys(raw, "", ["id", "op", "operation", "target", "tools"]);
  if (!COMBINE_OPERATIONS.includes(raw.operation as never)) {
    c.fail("operation", `must be one of ${COMBINE_OPERATIONS.map((o) => `"${o}"`).join(", ")} (got ${describe(raw.operation)})`);
  }
  const target = bodyName(raw.target, "target", c);
  const tools = bodyList(raw.tools, "tools", c);
  if (target && tools?.includes(target)) c.fail("tools", `must not include the target "${target}"`);
  if (c.errors.length > 0 || !target || !tools) return null;
  return { id: raw.id as string, op: "combine", operation: raw.operation as CombineFeature["operation"], target, tools };
}

// ----------------------------------------------------------------- bodies

function bodyName(v: unknown, path: string, c: Checker): string | undefined {
  if (typeof v === "string" && BODY_NAME.test(v)) return v;
  c.fail(path, `must be a body name like "base" (letters, digits, _ and -) (got ${describe(v)})`);
  return undefined;
}

function bodyList(v: unknown, path: string, c: Checker): string[] | undefined {
  if (!Array.isArray(v) || v.length === 0) {
    c.fail(path, `must be a list of body names (got ${describe(v)})`);
    return undefined;
  }
  const names = v.map((x, i) => bodyName(x, `${path}[${i}]`, c));
  if (names.some((n) => n === undefined)) return undefined;
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) {
    c.fail(path, `lists "${dup}" twice`);
    return undefined;
  }
  return names as string[];
}

/**
 * The body names the features so far make, in order: a name a feature uses
 * must be made before it. Whether the body really exists (its feature may
 * have failed) is the rebuild's to say.
 */
class BodyNames {
  private readonly names = new Set<string>();
  /** Every name made, in order, deleted ones too. */
  private readonly ever: string[] = [];
  /** newBody names by the feature that starts them, for patterns of it. */
  private readonly made = new Map<string, string>();

  private add(name: string) {
    this.names.add(name);
    if (!this.ever.includes(name)) this.ever.push(name);
  }

  /** New names a feature makes, refused if any is taken. */
  private fresh(names: string[], path: string, c: Checker): boolean {
    const taken = names.filter((n) => this.names.has(n));
    const twice = names.find((n, i) => names.indexOf(n) !== i);
    if (taken.length) c.fail(path, `would make body ${taken.map((n) => `"${n}"`).join(", ")}, which ${taken.length === 1 ? "is" : "are"} already a body${path === "newBody" ? "" : "; name the new body with newBody"}`);
    else if (twice) c.fail(path, `would make body "${twice}" twice`);
    return !taken.length && !twice;
  }



  check(f: Feature, c: Checker): void {
    const need = (name: string, path: string) => {
      if (!this.names.has(name)) c.fail(path, `no body "${name}" before this feature (${this.list()})`);
    };
    switch (f.op) {
      case "extrude":
        if (f.body) need(f.body, "body");
        if (f.newBody && this.names.has(f.newBody)) c.fail("newBody", `a body "${f.newBody}" already exists; use "body" to add to it`);
        break;
      case "cut":
      case "hole":
        f.bodies?.forEach((b, i) => need(b, `bodies[${i}]`));
        break;
      case "combine":
        need(f.target, "target");
        f.tools.forEach((b, i) => need(b, `tools[${i}]`));
        break;
      case "member":
      case "endCap":
      case "gusset": {
        const name = f.newBody ?? f.id;
        if (this.names.has(name)) c.fail(f.newBody ? "newBody" : "id", `a body "${name}" already exists; ${f.op === "member" ? "a member" : f.op === "endCap" ? "an end cap" : "a gusset"} is a body of its own`);
        break;
      }
    }
    // The multibody tools: what they need, and the names they make.
    let makes: string[] = [];
    switch (f.op) {
      case "mirror":
        if (f.bodies) {
          f.bodies.forEach((b, i) => need(b, `bodies[${i}]`));
          if (!f.merge) makes = f.newBody ? [f.newBody] : f.bodies.map((b) => `${b}${DERIVED_SUFFIX.mirror}`);
        } else if (f.feature && this.made.has(f.feature)) makes = [f.newBody ?? `${this.made.get(f.feature)}${DERIVED_SUFFIX.mirror}`];
        else if (f.newBody) c.fail("newBody", `${f.feature} makes no body of its own, so its mirror makes none`);
        break;
      case "split":
        need(f.body, "body");
        makes = [f.newBody ?? `${f.body}${DERIVED_SUFFIX.split}`];
        break;
      case "move":
        f.bodies.forEach((b, i) => need(b, `bodies[${i}]`));
        if (f.copy) makes = f.newBody ? [f.newBody] : f.bodies.map((b) => `${b}${DERIVED_SUFFIX.move}`);
        break;
      case "deleteBody": {
        const list = f.bodies ?? f.keep!;
        list.forEach((b, i) => need(b, `${f.bodies ? "bodies" : "keep"}[${i}]`));
        const gone = f.bodies ?? [...this.names].filter((n) => !f.keep!.includes(n));
        if (c.errors.length === 0 && gone.length >= this.names.size) c.fail(f.bodies ? "bodies" : "keep", "would delete every body: nothing of the part would be left");
        if (c.errors.length === 0 && f.keep && gone.length === 0) c.fail("keep", "keeps every body: there is nothing to delete");
        break;
      }
    }
    // A registry op says what it needs and makes through its def's body hooks.
    const d: FeatureDef | undefined = defOf(f.op);
    let makesPath: string | undefined;
    if (d?.bodies) {
      for (const [path, name] of d.bodies.needs?.(f) ?? []) need(name, path);
      const state = { names: this.names, made: this.made };
      for (const [path, message] of d.bodies.problems?.(f, state) ?? []) c.fail(path, message);
      const m = d.bodies.makes?.(f, state);
      if (m) {
        makes = m.names;
        makesPath = m.path;
      }
    }
    if (makes.length && c.errors.length === 0) {
      const named = (f.op === "mirror" || f.op === "split" || f.op === "move") && f.newBody !== undefined;
      this.fresh(makes, makesPath ?? (named ? "newBody" : f.op === "split" ? "body" : f.op === "mirror" && !f.bodies ? "feature" : "bodies"), c);
    }
    for (const [path, name] of selectorBodies(f)) need(name, path);
    if (c.errors.length > 0) return;
    if (d?.bodies) {
      for (const n of d.bodies.consumes?.(f, [...this.names]) ?? []) this.names.delete(n);
      // A seed that starts a body: its pattern and mirror copies are named after it.
      const seed = d.bodies.seedBody?.(f as unknown as Record<string, unknown>) ?? (d.patternable && makes.length === 1 ? makes[0] : undefined);
      if (seed) this.made.set(f.id, seed);
    }
    for (const n of makes) this.add(n);
    if (f.op === "mirror" && f.feature && makes.length) this.made.set(f.id, makes[0]);
    if (f.op === "deleteBody") for (const n of f.bodies ?? [...this.names].filter((x) => !f.keep!.includes(x))) this.names.delete(n);
    // What this feature makes, for the features after it.
    if (f.op === "extrude") {
      const name = f.newBody ?? f.body ?? DEFAULT_BODY;
      this.add(name);
      if (f.newBody) this.made.set(f.id, f.newBody);
    } else if ((f.op === "linearPattern" || f.op === "circularPattern") && this.made.has(f.feature)) {
      const seed = this.made.get(f.feature)!;
      const total = f.count * (f.op === "linearPattern" ? (f.count2 ?? 1) : 1);
      const copies = Array.from({ length: total - 1 }, (_, i) => `${seed}_${i + 2}`);
      const taken = copies.filter((n) => this.names.has(n));
      if (taken.length) c.fail("feature", `its copies of body "${seed}" would be named ${taken.join(", ")}, which ${taken.length === 1 ? "is" : "are"} already a body`);
      else for (const n of copies) this.add(n);
    } else if (f.op === "combine") {
      for (const t of f.tools) this.names.delete(t);
    } else if (f.op === "member" || f.op === "endCap" || f.op === "gusset") {
      const name = f.newBody ?? f.id;
      this.add(name);
      if (f.op === "member") this.made.set(f.id, name);
    }
  }

  all(): string[] {
    return [...this.names];
  }

  everMade(): string[] {
    return [...this.ever];
  }

  private list(): string {
    return this.names.size ? `bodies so far: ${[...this.names].join(", ")}` : "no bodies yet";
  }
}

/** Every selector in a feature that names a body, with its path. */
export function selectorBodies(f: Feature): [string, string][] {
  const out: [string, string][] = [];
  const face = (s: FaceSelector | undefined, path: string) => s?.body && out.push([`${path}.body`, s.body]);
  const edge = (s: EdgeSelector, path: string) => {
    if (s.body) out.push([`${path}.body`, s.body]);
    face(s.onFace, `${path}.onFace`);
    s.between?.forEach((b, i) => face(b, `${path}.between[${i}]`));
  };
  if (f.op === "hole") face(f.face, "face");
  if (f.op === "fillet" || f.op === "chamfer") {
    if (Array.isArray(f.edges)) f.edges.forEach((e, i) => edge(e, `edges[${i}]`));
    else edge(f.edges, "edges");
  }
  // The selectors of a registry op, and those inside any reference (a sketch on a face, a plane by reference).
  const d = defOf(f.op);
  const raw = f as unknown as Record<string, unknown>;
  for (const s of [...(d?.selectors?.(f) ?? []), ...datumSelectors(featureDatumRefs(raw, d?.datumRefs))]) {
    if (s.face) face(s.face, s.path);
    else if (s.edge) edge(s.edge, s.path);
  }
  return out;
}

// ------------------------------------------------------------- utilities

/** The photo underlay: its pixels, its scale, and which parameters are estimates. */
function checkPhoto(p: unknown, parameters: Parameters, c: Checker): void {
  if (!isObject(p)) {
    c.fail("photo", `must be an object (got ${describe(p)})`);
    return;
  }
  c.keys(p, "photo", [...PHOTO_KEYS]);
  for (const k of ["image", "sha256"] as const) {
    if (typeof p[k] !== "string" || p[k] === "") c.fail(`photo.${k}`, `must be a non-empty string (got ${describe(p[k])})`);
  }
  c.num(p, "width", "photo", { positive: true });
  c.num(p, "height", "photo", { positive: true });
  c.vec2(p, "origin", "photo");
  const s = p.scale;
  if (!isObject(s)) {
    c.fail("photo.scale", `must be an object (got ${describe(s)})`);
  } else {
    c.keys(s, "photo.scale", [...PHOTO_SCALE_KEYS]);
    const from = c.vec2(s, "from", "photo.scale");
    const to = c.vec2(s, "to", "photo.scale");
    if (from && to && Math.hypot(to[0] - from[0], to[1] - from[1]) < 1) c.fail("photo.scale", "the two points must be at least a pixel apart");
    c.num(s, "length", "photo.scale", { positive: true });
    if (typeof s.what !== "string") c.fail("photo.scale.what", `must be a string (got ${describe(s.what)})`);
    if (!PHOTO_SCALE_SOURCES.includes(s.source as never)) c.fail("photo.scale.source", `must be one of ${PHOTO_SCALE_SOURCES.join(", ")} (got ${describe(s.source)})`);
    if (s.parameter !== undefined && !(typeof s.parameter === "string" && s.parameter in parameters)) {
      c.fail("photo.scale.parameter", `must name a parameter (got ${describe(s.parameter)})`);
    }
    if (typeof s.confirmed !== "boolean") c.fail("photo.scale.confirmed", `must be true or false (got ${describe(s.confirmed)})`);
  }
  if (!isObject(p.estimated)) {
    c.fail("photo.estimated", `must be an object of parameter: pixels or null (got ${describe(p.estimated)})`);
  } else {
    for (const [k, v] of Object.entries(p.estimated)) {
      if (!(k in parameters)) c.fail(`photo.estimated.${k}`, "is not a parameter");
      else if (v !== null && !(typeof v === "number" && Number.isFinite(v))) {
        c.fail(`photo.estimated.${k}`, `must be pixels on the photo, or null for a guess (got ${describe(v)})`);
      }
    }
  }
}

export class Checker {
  readonly errors: string[] = [];
  constructor(private readonly prefix: string) {}

  fail(path: string, message: string): void {
    this.errors.push(`${this.prefix}: ${path ? `${path}: ` : ""}${message}`);
  }

  keys(obj: Record<string, unknown>, path: string, allowed: string[]): void {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) {
        this.fail(path, `unknown field "${key}" (allowed: ${allowed.join(", ")})`);
      }
    }
  }

  num(
    obj: Record<string, unknown>,
    key: string,
    path: string,
    opts: { positive?: boolean; nonNegative?: boolean },
  ): number | undefined {
    const v = obj[key];
    const where = path ? `${path}.${key}` : key;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      this.fail(where, `must be a number (got ${describe(v)})`);
      return undefined;
    }
    if (opts.positive && v <= 0) {
      this.fail(where, `must be greater than 0 (got ${v})`);
      return undefined;
    }
    if (opts.nonNegative && v < 0) {
      this.fail(where, `must not be negative (got ${v})`);
      return undefined;
    }
    return v;
  }

  vec2(obj: Record<string, unknown>, key: string, path: string): Vec2 | undefined {
    return this.vec(obj, key, path, 2) as Vec2 | undefined;
  }

  vec3(obj: Record<string, unknown>, key: string, path: string): Vec3 | undefined {
    return this.vec(obj, key, path, 3) as Vec3 | undefined;
  }

  /** A direction: three numbers, not all zero. Stored as written, normalised by the kernel. */
  unitVec(obj: Record<string, unknown>, key: string, path: string): Vec3 | undefined {
    const v = this.vec3(obj, key, path);
    if (v && Math.hypot(...v) < 1e-12) {
      this.fail(path ? `${path}.${key}` : key, "must not be the zero vector");
      return undefined;
    }
    return v;
  }

  private vec(obj: Record<string, unknown>, key: string, path: string, n: number): number[] | undefined {
    const v = obj[key];
    const where = path ? `${path}.${key}` : key;
    if (!Array.isArray(v) || v.length !== n || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
      this.fail(where, `must be an array of ${n} numbers (got ${describe(v)})`);
      return undefined;
    }
    return [...v];
  }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function describe(v: unknown): string {
  if (v === undefined) return "nothing";
  const s = JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize3(a: Vec3): Vec3 {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
}

function round(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

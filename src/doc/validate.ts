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
  PATTERNABLE_OPS,
  PHOTO_KEYS,
  PHOTO_SCALE_KEYS,
  PHOTO_SCALE_SOURCES,
  PICKS,
  SOURCE_KEYS,
  type ChamferFeature,
  type CircularPatternFeature,
  type CombineFeature,
  type CocaideDocument,
  type Constraint,
  type EdgeSelector,
  type ExtrudeFeature,
  type FaceSelector,
  type Feature,
  type FilletFeature,
  type HoleFeature,
  type LinearPatternFeature,
  type Material,
  type MemberFeature,
  PROFILE_KEYS,
  type ProfileDef,
  type SketchEntity,
  type SketchFeature,
  type Vec2,
  type Vec3,
} from "./types";
import { PARAMETER_NAME, resolveExpressions, type Parameters } from "./parameters";

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
  /** The body names the features make, in order of first use. */
  bodies: string[];
  /** The weldment profiles that validated, by name. */
  profiles: Record<string, ProfileDef>;
}

const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Every error in the document, flattened, in feature order. */
export function allErrors(v: ValidationResult): string[] {
  return [...v.headerErrors, ...v.features.flatMap((f) => f.errors)];
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
  const result: ValidationResult = { headerErrors: [], name: "", parameters: {}, material: undefined, features: [], bodies: [], profiles: {} };
  const header = new Checker("document");
  if (!isObject(input)) {
    header.fail("", `must be a JSON object (got ${describe(input)})`);
    result.headerErrors = header.errors;
    return result;
  }
  header.keys(input, "", ["version", "units", "name", "parameters", "material", "source", "photo", "profiles", "features"]);
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
  if (!Array.isArray(input.features)) {
    header.fail("features", `must be an array (got ${describe(input.features)})`);
    result.headerErrors = header.errors;
    return result;
  }
  result.headerErrors = header.errors;
  /** Every profile the part lists, valid or not: a member of a broken one points at its errors. */
  const listed = isObject(input.profiles) ? Object.keys(input.profiles) : [];

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
      } else if (seen.has(raw.id)) {
        c.fail("id", `duplicate id "${raw.id}"`);
      }
      // A bad expression already says what is wrong with that field.
      if (exprErrors.length === 0) feature = validateFeature(raw, c, seen, result.profiles, listed);
      if (feature) bodies.check(feature, c);
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
  return result;
}

function validateFeature(
  input: Record<string, unknown>,
  c: Checker,
  earlier: Map<string, string>,
  profiles: Record<string, ProfileDef> = {},
  listed: string[] = Object.keys(profiles),
): Feature | null {
  // `suppressed` is common to every op; check it here and validate the rest per op.
  const { suppressed, ...raw } = input;
  if (suppressed !== undefined && typeof suppressed !== "boolean") {
    c.fail("suppressed", `must be true or false (got ${describe(suppressed)})`);
  }
  let feature: Feature | null;
  switch (raw.op) {
    case "sketch":
      feature = validateSketch(raw, c);
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
      feature = validateMember(raw, c, profiles, listed);
      break;
    default:
      c.fail("op", `unknown op ${describe(raw.op)} (supported: ${FEATURE_OPS.join(", ")})`);
      return null;
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
};

const POINT_NAMES: Record<SketchEntity["type"], string[]> = {
  line: ["start", "end"],
  circle: ["center"],
  arc: ["start", "end", "center"],
  rect: ["center"],
  slot: ["center1", "center2"],
};

function validateSketch(raw: Record<string, unknown>, c: Checker): SketchFeature | null {
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
  let plane: SketchFeature["plane"] | undefined;
  if (!isObject(raw.plane)) {
    c.fail("plane", `must be an object (got ${describe(raw.plane)})`);
  } else {
    const p = raw.plane;
    c.keys(p, "plane", ["type", "normal", "origin", "xDir"]);
    if (p.type !== "datum") c.fail("plane.type", `must be "datum" (got ${describe(p.type)})`);
    const normal = c.unitVec(p, "normal", "plane");
    const origin = c.vec3(p, "origin", "plane");
    const xDir = p.xDir === undefined ? undefined : c.unitVec(p, "xDir", "plane");
    if (normal && xDir && Math.abs(dot3(normalize3(normal), normalize3(xDir))) > 1 - 1e-9) {
      c.fail("plane.xDir", "must not be parallel to the plane normal");
    }
    if (normal && origin) {
      plane = { type: "datum", normal, origin };
      if (xDir) plane.xDir = xDir;
    }
  }

  const entities: SketchEntity[] = [];
  const entityTypes = new Map<string, SketchEntity["type"]>();
  if (!Array.isArray(raw.entities)) {
    c.fail("entities", `must be an array (got ${describe(raw.entities)})`);
  } else {
    raw.entities.forEach((e, i) => {
      const entity = validateEntity(e, `entities[${i}]`, c, entityTypes);
      if (entity) {
        entities.push(entity);
        entityTypes.set(entity.id, entity.type);
      }
    });
  }

  const constraints: Constraint[] = [];
  if (raw.constraints !== undefined) {
    if (!Array.isArray(raw.constraints)) {
      c.fail("constraints", `must be an array (got ${describe(raw.constraints)})`);
    } else {
      raw.constraints.forEach((k, i) => {
        const constraint = validateConstraint(k, `constraints[${i}]`, c, entityTypes);
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
): SketchEntity | null {
  if (!isObject(e)) {
    c.fail(path, `must be an object (got ${describe(e)})`);
    return null;
  }
  const label = typeof e.id === "string" ? `${path} "${e.id}"` : path;
  const before = c.errors.length;
  if (typeof e.id !== "string" || !ID_PATTERN.test(e.id)) {
    c.fail(label, `id must be an identifier like "r1" (got ${describe(e.id)})`);
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
  c.keys(e, label, ["id", "type", "construction", ...ENTITY_FIELDS[type]]);
  const base = { id: e.id as string, ...(e.construction === undefined ? {} : { construction: e.construction as boolean }) };
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
  }
  return c.errors.length === before ? entity : null;
}

function validateConstraint(
  k: unknown,
  path: string,
  c: Checker,
  entities: Map<string, SketchEntity["type"]>,
): Constraint | null {
  if (!isObject(k)) {
    c.fail(path, `must be an object (got ${describe(k)})`);
    return null;
  }
  const label = typeof k.type === "string" ? `${path} ${k.type}` : path;
  const before = c.errors.length;
  const entityRef = (key: string, value: unknown, allowed: SketchEntity["type"][]): string | undefined => {
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

  switch (k.type) {
    case "coincident": {
      c.keys(k, label, ["type", "points"]);
      const points = pointPair(k.points);
      return points && c.errors.length === before ? { type: "coincident", points } : null;
    }
    case "horizontal":
    case "vertical": {
      c.keys(k, label, ["type", "entity"]);
      const entity = entityRef("entity", k.entity, ["line"]);
      return entity && c.errors.length === before ? { type: k.type, entity } : null;
    }
    case "distance":
    case "distanceX":
    case "distanceY": {
      c.keys(k, label, ["type", "entity", "points", "value"]);
      const value = c.num(k, "value", label, { nonNegative: true });
      const hasEntity = k.entity !== undefined;
      const hasPoints = k.points !== undefined;
      if (hasEntity === hasPoints) {
        c.fail(label, "needs exactly one of entity or points");
        return null;
      }
      const allowed: SketchEntity["type"][] = k.type === "distance" ? ["line", "slot"] : ["line", "rect", "slot"];
      const entity = hasEntity ? entityRef("entity", k.entity, allowed) : undefined;
      const points = hasPoints ? pointPair(k.points) : undefined;
      if (value === undefined || c.errors.length > before) return null;
      return entity ? { type: k.type, entity, value } : { type: k.type, points: points!, value };
    }
    case "radius": {
      c.keys(k, label, ["type", "entity", "value"]);
      const entity = entityRef("entity", k.entity, ["circle", "arc"]);
      const value = c.num(k, "value", label, { positive: true });
      return entity && value !== undefined && c.errors.length === before ? { type: "radius", entity, value } : null;
    }
    case "equal": {
      c.keys(k, label, ["type", "entities"]);
      if (!Array.isArray(k.entities) || k.entities.length !== 2) {
        c.fail(label, `entities must be an array of two entity ids (got ${describe(k.entities)})`);
        return null;
      }
      const a = entityRef("entities[0]", k.entities[0], ["line", "circle", "arc"]);
      const b = entityRef("entities[1]", k.entities[1], ["line", "circle", "arc"]);
      if (!a || !b) return null;
      const kind = (id: string) => (entities.get(id) === "line" ? "line" : "round");
      if (kind(a) !== kind(b)) {
        c.fail(label, `cannot make a line equal to a circle or arc ("${a}", "${b}")`);
        return null;
      }
      return c.errors.length === before ? { type: "equal", entities: [a, b] } : null;
    }
    default:
      c.fail(
        path,
        `unknown constraint type ${describe(k.type)} (supported: coincident, horizontal, vertical, distance, distanceX, distanceY, radius, equal)`,
      );
      return null;
  }
}

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
  let edges: EdgeSelector | EdgeSelector[] | null = null;
  if (Array.isArray(raw.edges)) {
    if (raw.edges.length === 0) c.fail("edges", "must list at least one edge selector");
    const list = raw.edges.map((e, i) => validateEdgeSelector(e, `edges[${i}]`, c));
    if (list.every((e) => e !== null)) edges = list as EdgeSelector[];
  } else {
    edges = validateEdgeSelector(raw.edges, "edges", c);
  }
  if (c.errors.length > 0 || !edges || value === undefined) return null;
  return raw.op === "fillet"
    ? { id: raw.id as string, op: "fillet", edges, radius: value }
    : { id: raw.id as string, op: "chamfer", edges, distance: value };
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
  } else if (!PATTERNABLE_OPS.includes(earlier.get(raw.feature) as never)) {
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
  if (!exprErrors.length) validateSketch(sketchRaw, inner);
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

function validateMember(raw: Record<string, unknown>, c: Checker, profiles: Record<string, ProfileDef>, listed: string[]): MemberFeature | null {
  c.keys(raw, "", ["id", "op", "profile", "size", "from", "to", "rotation", "newBody"]);
  const profile = typeof raw.profile === "string" ? profiles[raw.profile] : undefined;
  if (typeof raw.profile !== "string") c.fail("profile", `must name a profile in the part's profiles (got ${describe(raw.profile)})`);
  else if (!profile && listed.includes(raw.profile)) c.fail("profile", `the part's profile "${raw.profile}" has errors (see profiles.${raw.profile})`);
  else if (!profile) c.fail("profile", `no profile "${raw.profile}" in the part (${listed.length ? `profiles: ${listed.join(", ")}` : "it has none: add one from the section library"})`);
  if (typeof raw.size !== "string") c.fail("size", `must be one of the profile's designations (got ${describe(raw.size)})`);
  else if (profile && !profile.sizes.some((s) => s.designation === raw.size)) {
    c.fail("size", `"${raw.size}" is not a size of ${profile.name} (sizes: ${profile.sizes.map((s) => s.designation).join(", ")})`);
  }
  const from = c.vec3(raw, "from", "");
  const to = c.vec3(raw, "to", "");
  if (from && to && Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) < 1e-6) c.fail("to", "must not be the same point as from");
  const rotation = raw.rotation === undefined ? undefined : c.num(raw, "rotation", "", {});
  const newBody = raw.newBody === undefined ? undefined : bodyName(raw.newBody, "newBody", c);
  if (c.errors.length > 0 || !from || !to) return null;
  const f: MemberFeature = { id: raw.id as string, op: "member", profile: raw.profile as string, size: raw.size as string, from, to };
  if (rotation !== undefined) f.rotation = rotation;
  if (newBody) f.newBody = newBody;
  return f;
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
  /** newBody names by the feature that starts them, for patterns of it. */
  private readonly made = new Map<string, string>();

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
      case "member": {
        const name = f.newBody ?? f.id;
        if (this.names.has(name)) c.fail(f.newBody ? "newBody" : "id", `a body "${name}" already exists; a member is a body of its own`);
        break;
      }
    }
    for (const [path, name] of selectorBodies(f)) need(name, path);
    if (c.errors.length > 0) return;
    // What this feature makes, for the features after it.
    if (f.op === "extrude") {
      const name = f.newBody ?? f.body ?? DEFAULT_BODY;
      this.names.add(name);
      if (f.newBody) this.made.set(f.id, f.newBody);
    } else if ((f.op === "linearPattern" || f.op === "circularPattern") && this.made.has(f.feature)) {
      const seed = this.made.get(f.feature)!;
      const total = f.count * (f.op === "linearPattern" ? (f.count2 ?? 1) : 1);
      const copies = Array.from({ length: total - 1 }, (_, i) => `${seed}_${i + 2}`);
      const taken = copies.filter((n) => this.names.has(n));
      if (taken.length) c.fail("feature", `its copies of body "${seed}" would be named ${taken.join(", ")}, which ${taken.length === 1 ? "is" : "are"} already a body`);
      else for (const n of copies) this.names.add(n);
    } else if (f.op === "combine") {
      for (const t of f.tools) this.names.delete(t);
    } else if (f.op === "member") {
      const name = f.newBody ?? f.id;
      this.names.add(name);
      this.made.set(f.id, name);
    }
  }

  all(): string[] {
    return [...this.names];
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

// Strict schema validation for .cocaide.json. Unknown fields are errors: a
// typo such as "diamter" must fail loudly instead of being ignored.
//
// Header problems (version, units, features not an array) make the whole
// document unusable. Feature problems are reported per feature so the rest of
// the part can still rebuild.

import {
  FEATURE_OPS,
  PICKS,
  type CocaideDocument,
  type Constraint,
  type ExtrudeFeature,
  type FaceSelector,
  type Feature,
  type HoleFeature,
  type Material,
  type SketchEntity,
  type SketchFeature,
  type Vec2,
  type Vec3,
} from "./types";

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
  material: Material | undefined;
  features: ValidatedFeature[];
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
  if (v.material) doc.material = v.material;
  return doc;
}

export function validateDocument(input: unknown): ValidationResult {
  const result: ValidationResult = { headerErrors: [], name: "", material: undefined, features: [] };
  const header = new Checker("document");
  if (!isObject(input)) {
    header.fail("", `must be a JSON object (got ${describe(input)})`);
    result.headerErrors = header.errors;
    return result;
  }
  header.keys(input, "", ["version", "units", "name", "material", "features"]);
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
  if (!Array.isArray(input.features)) {
    header.fail("features", `must be an array (got ${describe(input.features)})`);
    result.headerErrors = header.errors;
    return result;
  }
  result.headerErrors = header.errors;

  const seen = new Map<string, string>(); // id -> op, for features before the current one
  input.features.forEach((raw, index) => {
    const rawId = isObject(raw) && typeof raw.id === "string" && raw.id !== "" ? raw.id : `features[${index}]`;
    const c = new Checker(rawId);
    let feature: Feature | null = null;
    if (!isObject(raw)) {
      c.fail("", `must be an object (got ${describe(raw)})`);
    } else {
      if (typeof raw.id !== "string" || !ID_PATTERN.test(raw.id)) {
        c.fail("id", `must be an identifier like "hole_1" (got ${describe(raw.id)})`);
      } else if (seen.has(raw.id)) {
        c.fail("id", `duplicate id "${raw.id}"`);
      }
      feature = validateFeature(raw, c, seen);
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
  return result;
}

function validateFeature(raw: Record<string, unknown>, c: Checker, earlier: Map<string, string>): Feature | null {
  switch (raw.op) {
    case "sketch":
      return validateSketch(raw, c);
    case "extrude":
    case "cut":
      return validateExtrude(raw, c, earlier);
    case "hole":
      return validateHole(raw, c);
    default:
      c.fail("op", `unknown op ${describe(raw.op)} (supported: ${FEATURE_OPS.join(", ")})`);
      return null;
  }
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
  c.keys(raw, "", ["id", "op", "plane", "entities", "constraints"]);
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
    const [id, point, ...rest] = value.split(".");
    const type = entities.get(id);
    if (!type || point === undefined || rest.length > 0) {
      c.fail(label, `point ref "${value}" must be "<entity>.<point>" for an entity in this sketch`);
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
  c.keys(raw, "", ["id", "op", "sketch", "extent", "distance", "direction"]);
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
  if (c.errors.length > 0) return null;
  const feature: ExtrudeFeature = { id: raw.id as string, op: raw.op as "extrude" | "cut", sketch: raw.sketch as string };
  if (raw.extent !== undefined) feature.extent = extent as ExtrudeFeature["extent"];
  if (distance !== undefined) feature.distance = distance;
  if (direction) feature.direction = direction;
  return feature;
}

// ------------------------------------------------------------------ hole

function validateHole(raw: Record<string, unknown>, c: Checker): HoleFeature | null {
  c.keys(raw, "", ["id", "op", "face", "center", "diameter", "depth", "counterbore", "countersink"]);
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
  return hole;
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
      c.keys(raw, path, ["type", "normal", "pick", "offset"]);
      const normal = c.unitVec(raw, "normal", path);
      const offset = raw.offset === undefined ? undefined : c.num(raw, "offset", path, {});
      if (!normal || c.errors.length > before) return null;
      const s: FaceSelector = { type: "planar", normal, pick: pick as FaceSelector["pick"] };
      if (offset !== undefined) s.offset = offset;
      return s;
    }
    case "cylindrical": {
      c.keys(raw, path, ["type", "radius", "axis", "pick"]);
      const radius = raw.radius === undefined ? undefined : c.num(raw, "radius", path, { positive: true });
      const axis = raw.axis === undefined ? undefined : c.unitVec(raw, "axis", path);
      if (c.errors.length > before) return null;
      const s: FaceSelector = { type: "cylindrical", pick: pick as FaceSelector["pick"] };
      if (radius !== undefined) s.radius = radius;
      if (axis) s.axis = axis;
      return s;
    }
    default:
      c.fail(`${path}.type`, `must be "planar" or "cylindrical" (got ${describe(raw.type)})`);
      return null;
  }
}

// ------------------------------------------------------------- utilities

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

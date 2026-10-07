// Reading a photo (spec 5.3, Phase G). A photo has no scale and is never a
// dimension source: the model reports what the part is and where its edges
// and holes are, in the photo's pixels. Code turns pixels into millimetres
// through one dimension: what the user typed in their note, a reference read
// in the photo (a rule), or, failing both, a guess. Every size is an estimate,
// kept in the document with its size in pixels so the user can rescale the
// whole part by setting the scale on the photo. A size the photo doesn't show
// (the thickness, in a photo from above) is a guess.
//
// v1: one part, flat plates and discs (one outline, holes through it).
// Freeform parts are refused.

import { z } from "zod";
import { estimate } from "../doc/photo";
import type { PhotoScaleSource, PhotoUnderlay, Vec2 } from "../doc/types";
import { allErrors, validateDocument } from "../doc/validate";
import { planPart, type Plan } from "./plan";
import { numbersIn } from "./review";
import { emptyHoleGroup, emptyIntent, type Intent, type NumberField } from "./schema";

const Point = z.object({ x: z.number(), y: z.number() });
const UNITS = z.enum(["mm", "in"]);

export const PHOTO_CATEGORIES = ["prismatic", "turned", "freeform", "not-a-part"] as const;

export const PhotoReading = z.object({
  /** Prismatic (flat faces, straight cuts), turned (round, made on a lathe), freeform (organic curves), or not a part. */
  category: z.object({ value: z.enum(PHOTO_CATEGORIES), evidence: z.string(), confidence: z.number() }),
  description: z.string(),
  name: z.string(),
  /** Face-on: the camera looks straight at the face with the outline. */
  view: z.enum(["face-on", "oblique"]),
  kind: z.enum(["plate", "disc", "other"]),
  /** The face with the outline, as a box in the photo's pixels (x right, y down). For a disc, the box around its circle. */
  outline: z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() }).nullable(),
  /** Holes through that face: centre and diameter in pixels. */
  holes: z.array(z.object({ x: z.number(), y: z.number(), diameter: z.number() })),
  /** Two points across the thickness, where the photo shows an edge side-on. Null when it doesn't. */
  thickness: z.object({ from: Point, to: Point }).nullable(),
  /** The thickness as the user typed it in their note, if they did. */
  typedThickness: z.object({ value: z.number().nullable(), units: UNITS, evidence: z.string() }),
  /** The one known dimension: a line on the photo and its real length. */
  scale: z.object({
    what: z.string(),
    /** The size of the part the line measures, if it is one. */
    dimension: z.enum(["width", "height", "diameter", "none"]),
    from: Point,
    to: Point,
    length: z.number().nullable(),
    units: UNITS,
    evidence: z.string(),
    source: z.enum(["typed", "reference", "guess"]),
  }),
  notes: z.array(z.string()),
});
export type PhotoReading = z.infer<typeof PhotoReading>;

export interface PhotoFile {
  name: string;
  sha256: string;
  width: number;
  height: number;
}

export type PhotoPlan =
  | {
      ok: true;
      intent: Intent;
      plan: Extract<Plan, { ok: true }>;
      photo: PhotoUnderlay;
      /** Parameters that are guesses: sizes the photo doesn't show. */
      guesses: string[];
      notes: string[];
    }
  | { ok: false; problems: string[] };

const SCALE_PARAMETER: Record<string, string> = { width: "plate_w", height: "plate_h", diameter: "disc_d" };
/** A guessed thickness, when the photo doesn't show one: a tenth of the short side. Only ever a placeholder. */
const GUESS_THICKNESS = 0.1;

/** The photo's reading, as a plan: features, and the underlay that says which sizes are estimates. */
export function planPhoto(reading: PhotoReading, note: string, file: PhotoFile): PhotoPlan {
  const problems: string[] = [];
  const category = reading.category.value;
  if (category === "freeform") {
    problems.push(`This looks freeform (${reading.category.evidence || reading.description}). Cocaide builds prismatic and turned parts; model this one by hand, with the photo for reference.`);
  } else if (category === "not-a-part") {
    problems.push(`The photo doesn't show a part to build: ${reading.category.evidence || reading.description}.`);
  } else if (reading.kind === "other") {
    problems.push(`From a photo, v1 builds flat plates and discs: one outline with holes through it. This is ${reading.description || "something else"}; describe it, or build it by hand with the photo for reference.`);
  }
  const o = reading.outline && {
    left: clamp(reading.outline.left, 0, file.width),
    right: clamp(reading.outline.right, 0, file.width),
    top: clamp(reading.outline.top, 0, file.height),
    bottom: clamp(reading.outline.bottom, 0, file.height),
  };
  if (!problems.length && (!o || o.right - o.left < 8 || o.bottom - o.top < 8)) problems.push("The part's outline isn't clear enough in the photo to measure.");
  if (problems.length || !o) return { ok: false, problems };

  const disc = reading.kind === "disc";
  const notes: string[] = [];
  const w = o.right - o.left;
  const h = o.bottom - o.top;
  const cx = (o.left + o.right) / 2;
  const cy = (o.top + o.bottom) / 2;
  if (reading.view === "oblique") notes.push("The photo is taken at an angle, so its sizes are rougher and it won't line up exactly with the part.");

  // The scale: a size of the part runs edge to edge across the outline; anything else is the line the model gave.
  let dimension = reading.scale.dimension;
  if (disc && dimension !== "none") dimension = "diameter";
  if (!disc && dimension === "diameter") dimension = "width";
  const from: Vec2 = dimension === "height" ? [cx, o.bottom] : dimension !== "none" ? [o.left, cy] : [reading.scale.from.x, reading.scale.from.y];
  const to: Vec2 = dimension === "height" ? [cx, o.top] : dimension !== "none" ? [o.right, cy] : [reading.scale.to.x, reading.scale.to.y];
  const span = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (span < 8) return { ok: false, problems: ["The scale line is too short to measure from."] };

  let source: PhotoScaleSource = reading.scale.source;
  let length = reading.scale.length;
  if (source === "typed" && (length === null || !typedIn(length, note))) {
    if (length !== null) notes.push(`${length} is not in your note, so the scale is a guess.`);
    source = "guess";
  }
  if (length === null || !(length > 0)) {
    source = "guess";
    length = Math.round((100 * span) / Math.max(w, h)); // the part's long side about 100 mm
  }
  let lengthMm = length;
  if (reading.scale.units === "in") {
    lengthMm = Math.round(length * 25.4 * 1e6) / 1e6;
    notes.push(`Converted the scale from inches once: ${length} in → ${lengthMm} mm.`);
  }
  const k = lengthMm / span;

  // Pixel sizes, by the intent path the planner reports for each parameter.
  const pixels: Record<string, number | null> = disc ? { diameter: (w + h) / 2 } : { width: w, height: h };
  const mm = (px: number) => estimate(px, k);
  const intent = emptyIntent();
  intent.kind = disc ? "disc" : "plate";
  intent.name = reading.name.trim() || intent.kind;
  intent.description = reading.description;
  if (disc) intent.diameter = measured(mm(pixels.diameter!));
  else {
    intent.width = measured(mm(w));
    intent.height = measured(mm(h));
  }

  // Thickness: typed in the note is the user's number; shown side-on is an estimate; otherwise a guess.
  const typedT = reading.typedThickness;
  const shortMm = Math.min(...(disc ? [mm(pixels.diameter!)] : [mm(w), mm(h)]));
  if (typedT.value !== null && typedT.value > 0 && typedIn(typedT.value, note)) {
    const t = typedT.units === "in" ? Math.round(typedT.value * 25.4 * 1e6) / 1e6 : typedT.value;
    intent.thickness = { value: t, evidence: typedT.evidence, source: "stated", confidence: 1 };
  } else if (reading.thickness) {
    const px = Math.hypot(reading.thickness.to.x - reading.thickness.from.x, reading.thickness.to.y - reading.thickness.from.y);
    pixels.thickness = px;
    intent.thickness = measured(mm(px));
  } else {
    pixels.thickness = null;
    intent.thickness = { value: Math.max(1, Math.round(shortMm * GUESS_THICKNESS * 2) / 2), evidence: "a guess: the photo doesn't show the thickness", source: "inferred", confidence: 0 };
  }

  // Holes through the outline, grouped by size; each position from the lower-left corner (a disc: its centre).
  const inside = reading.holes.filter((hole) => hole.diameter > 0 && hole.x > o.left && hole.x < o.right && hole.y > o.top && hole.y < o.bottom);
  if (inside.length < reading.holes.length) notes.push(`${reading.holes.length - inside.length} hole${reading.holes.length - inside.length === 1 ? " was" : "s were"} outside the outline and left out.`);
  const groups: (typeof inside)[] = [];
  for (const hole of [...inside].sort((a, b) => a.diameter - b.diameter)) {
    const g = groups.find((x) => Math.abs(hole.diameter - x[0].diameter) <= 0.1 * x[0].diameter);
    if (g) g.push(hole);
    else groups.push([hole]);
  }
  groups.forEach((g, gi) => {
    const d = g.reduce((s, hole) => s + hole.diameter, 0) / g.length;
    pixels[`holes[${gi}].diameter`] = d;
    const points = g
      .sort((a, b) => a.x - b.x || b.y - a.y)
      .map((hole, n) => {
        const [x, y] = disc ? [hole.x - cx, cy - hole.y] : [hole.x - o.left, o.bottom - hole.y];
        pixels[`holes[${gi}].points[${n}].x`] = x;
        pixels[`holes[${gi}].points[${n}].y`] = y;
        return { x: mm(x), y: mm(y) };
      });
    intent.holes.push({
      ...emptyHoleGroup(),
      diameter: measured(mm(d)),
      count: measured(g.length),
      placement: "points",
      points: { value: points, evidence: "measured on the photo", source: "stated", confidence: 1 },
    });
  });

  const plan = planPart(intent, { name: intent.name, pointParams: true });
  if (!plan.ok) return { ok: false, problems: [`Could not plan the part: ${plan.error}`] };
  const estimated: Record<string, number | null> = {};
  for (const [param, path] of Object.entries(plan.paths)) if (path in pixels) estimated[param] = pixels[path];
  const parameter = SCALE_PARAMETER[dimension];
  const photo: PhotoUnderlay = {
    image: file.name,
    sha256: file.sha256,
    width: file.width,
    height: file.height,
    origin: [cx, cy],
    scale: {
      from,
      to,
      length: lengthMm,
      what: reading.scale.what.trim() || (parameter ? `the part's ${dimension}` : "the scale line"),
      source,
      ...(parameter && parameter in estimated ? { parameter } : {}),
      confirmed: false,
    },
    estimated,
  };
  const doc = { ...plan.doc, photo };
  const errors = allErrors(validateDocument(doc));
  if (errors.length) return { ok: false, problems: [`The plan does not validate: ${errors.join("; ")}`] };
  const guesses = Object.entries(estimated)
    .filter(([, px]) => px === null)
    .map(([name]) => name);
  return { ok: true, intent, plan: { ...plan, doc }, photo, guesses, notes: [...notes, ...plan.notes] };
}

/** A number the user typed in their note. */
function typedIn(v: number, note: string): boolean {
  return numbersIn(note).some((x) => Math.abs(x - v) <= 1e-9 * Math.max(1, Math.abs(x)));
}

function measured(value: number): NumberField {
  return { value, evidence: "measured on the photo", source: "stated", confidence: 1 };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

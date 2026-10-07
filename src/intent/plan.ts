// The planner: a confirmed intent becomes a feature document. Deterministic,
// and parametric: the sizes the user gave become document parameters, so the
// human keeps editing the same part in the tree. Inches are converted to mm
// here, once, and the conversion is reported.

import type { RawDocument } from "../doc/commands";
import { allErrors, validateDocument } from "../doc/validate";
import type { HoleGroup, Intent, NumberField } from "./schema";

export interface ExpectedHole {
  diameter: number;
  /** Centre in the XY plane (holes are drilled down Z through the top face). */
  center: [number, number];
  /** Depth, or the thickness for a through hole. */
  depth: number;
}

/** What the part must measure if the plan did what was asked. The critic checks it. */
export interface Expectation {
  size: [number, number, number];
  holes: ExpectedHole[];
}

export type Plan = { ok: true; doc: RawDocument; expect: Expectation; notes: string[] } | { ok: false; error: string };

const TOP = { type: "planar", normal: [0, 0, 1], pick: "largest" };

export function planPart(intent: Intent): Plan {
  if (intent.kind === "other") return { ok: false, error: "only plates and discs have a planner; other parts are built by the agent" };
  const k = intent.units === "in" ? 25.4 : 1;
  const notes: string[] = [];
  const conversions: string[] = [];
  /** A value in mm, converted once if the request was in inches. */
  const mm = (f: NumberField, label: string): number => {
    const v = f.value!;
    if (k === 1) return v;
    const out = Math.round(v * k * 1e9) / 1e9;
    conversions.push(`${label} ${v} in → ${out} mm`);
    return out;
  };

  const params: Record<string, number> = {};
  const features: Record<string, unknown>[] = [];
  const disc = intent.kind === "disc";
  let size: [number, number, number];
  const t = mm(intent.thickness, "thickness");

  if (disc) {
    const d = mm(intent.diameter, "diameter");
    Object.assign(params, { disc_d: d, part_t: t });
    size = [d, d, t];
    features.push({
      id: "sketch_1",
      op: "sketch",
      plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] },
      entities: [{ id: "c1", type: "circle", center: [0, 0], radius: "=disc_d / 2" }],
      constraints: [
        { type: "radius", entity: "c1", value: "=disc_d / 2" },
        { type: "coincident", points: ["c1.center", "origin"] },
      ],
    });
  } else {
    const w = mm(intent.width, "width");
    const h = mm(intent.height, "height");
    Object.assign(params, { plate_w: w, plate_h: h, part_t: t });
    size = [w, h, t];
    features.push({
      id: "sketch_1",
      op: "sketch",
      plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] },
      entities: [{ id: "r1", type: "rect", center: [0, 0], w: "=plate_w", h: "=plate_h" }],
      constraints: [
        { type: "distanceX", entity: "r1", value: "=plate_w" },
        { type: "distanceY", entity: "r1", value: "=plate_h" },
        { type: "coincident", points: ["r1.center", "origin"] },
      ],
    });
  }
  features.push({ id: "ext_1", op: "extrude", sketch: "sketch_1", distance: "=part_t", direction: [0, 0, 1] });

  if (!disc && intent.cornerRadius.value !== null && intent.cornerRadius.value > 0) {
    params.corner_r = mm(intent.cornerRadius, "corner radius");
    features.push({ id: "fillet_1", op: "fillet", edges: { type: "edge", kind: "line", direction: [0, 0, 1], pick: "all" }, radius: "=corner_r" });
  }

  const holes: ExpectedHole[] = [];
  let holeN = 0;
  let patternN = 0;
  intent.holes.forEach((g, gi) => {
    const p = gi === 0 ? "hole" : `hole${gi + 1}`;
    const d = mm(g.diameter, `hole diameter`);
    params[`${p}_d`] = d;
    const depth = g.depth.value !== null ? mm(g.depth, "hole depth") : null;
    if (depth !== null) params[`${p}_depth`] = depth;
    const hole = (center: unknown[], _at: [number, number]) => {
      const id = `hole_${++holeN}`;
      features.push({ id, op: "hole", face: TOP, center, diameter: `=${p}_d`, depth: depth === null ? "through" : `=${p}_depth` });
      return id;
    };
    const expectAt = (pts: [number, number][]) => pts.forEach((c) => holes.push({ diameter: d, center: c, depth: depth ?? t }));
    const [W, H] = [params.plate_w, params.plate_h];

    switch (g.placement) {
      case "center":
        hole([0, 0], [0, 0]);
        expectAt([[0, 0]]);
        break;
      case "corners": {
        const inset = mm(g.inset, "hole inset");
        params[`${p}_inset`] = inset;
        const x = W / 2 - inset;
        const y = H / 2 - inset;
        const seed = hole([`=plate_w / 2 - ${p}_inset`, `=plate_h / 2 - ${p}_inset`], [x, y]);
        features.push({
          id: `pattern_${++patternN}`,
          op: "linearPattern",
          feature: seed,
          direction: [-1, 0, 0],
          spacing: `=plate_w - 2 * ${p}_inset`,
          count: 2,
          direction2: [0, -1, 0],
          spacing2: `=plate_h - 2 * ${p}_inset`,
          count2: 2,
        });
        expectAt([
          [x, y],
          [-x, y],
          [x, -y],
          [-x, -y],
        ]);
        if (inset < d / 2) notes.push(`The holes are ${inset} mm from the edges but ${d / 2} mm in radius, so they break out of the edges.`);
        break;
      }
      case "grid": {
        const rows = g.rows.value!;
        const cols = g.columns.value!;
        const px = cols > 1 ? mm(g.pitchX, "grid pitch X") : 0;
        const py = rows > 1 ? mm(g.pitchY, "grid pitch Y") : 0;
        if (cols > 1) params[`${p}_px`] = px;
        if (rows > 1) params[`${p}_py`] = py;
        const x0 = (-(cols - 1) / 2) * px;
        const y0 = (-(rows - 1) / 2) * py;
        const seed = hole([cols > 1 ? `=-${p}_px * ${(cols - 1) / 2}` : 0, rows > 1 ? `=-${p}_py * ${(rows - 1) / 2}` : 0], [x0, y0]);
        const pattern: Record<string, unknown> = { id: `pattern_${++patternN}`, op: "linearPattern", feature: seed };
        if (cols > 1 && rows > 1) Object.assign(pattern, { direction: [1, 0, 0], spacing: `=${p}_px`, count: cols, direction2: [0, 1, 0], spacing2: `=${p}_py`, count2: rows });
        else if (cols > 1) Object.assign(pattern, { direction: [1, 0, 0], spacing: `=${p}_px`, count: cols });
        else if (rows > 1) Object.assign(pattern, { direction: [0, 1, 0], spacing: `=${p}_py`, count: rows });
        if (cols > 1 || rows > 1) features.push(pattern);
        else patternN--;
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) expectAt([[x0 + c * px, y0 + r * py]]);
        break;
      }
      case "points": {
        for (const pt of g.points.value!) {
          const x = mm({ ...g.diameter, value: pt.x }, "hole x");
          const y = mm({ ...g.diameter, value: pt.y }, "hole y");
          if (disc) {
            hole([x, y], [x, y]);
            expectAt([[x, y]]);
          } else {
            // Measured from the lower-left corner, so the hole stays put when the plate grows to the right or up.
            hole([`=${x} - plate_w / 2`, `=${y} - plate_h / 2`], [x - W / 2, y - H / 2]);
            expectAt([[x - W / 2, y - H / 2]]);
          }
        }
        break;
      }
      case "circle": {
        const bc = mm(g.circleDiameter, "hole circle diameter");
        params[`${p}_circle`] = bc;
        const n = g.count.value!;
        const seed = hole([`=${p}_circle / 2`, 0], [bc / 2, 0]);
        if (n > 1) {
          features.push({ id: `pattern_${++patternN}`, op: "circularPattern", feature: seed, axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, count: n });
        }
        for (let i = 0; i < n; i++) {
          const a = (2 * Math.PI * i) / n;
          expectAt([[(bc / 2) * Math.cos(a), (bc / 2) * Math.sin(a)]]);
        }
        break;
      }
      default:
        return planError(g);
    }
  });

  if (conversions.length) notes.unshift(`Converted from inches once (× 25.4): ${conversions.join("; ")}.`);
  const doc: RawDocument = { version: 1, units: "mm", name: intent.name.trim() || (disc ? "disc" : "plate"), parameters: params, features };
  const errors = allErrors(validateDocument(doc));
  if (errors.length) return { ok: false, error: `the plan does not validate: ${errors.join("; ")}` };
  return { ok: true, doc, expect: { size, holes }, notes };
}

function planError(g: HoleGroup): never {
  throw new Error(`cannot place holes "${g.placement}"`);
}

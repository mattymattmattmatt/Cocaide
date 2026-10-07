// The frame planner (Phase K): a confirmed frame intent becomes a feature
// document, the way a person builds one in Phase J. Its size becomes
// parameters, its nodes are the outside corners, members run along paths with
// the nodes on the outside, and the corners are mitred or butted. The part
// gets its own copy of the library profile. Deterministic.

import type { RawDocument } from "../doc/commands";
import type { ProfileDef, Vec3 } from "../doc/types";
import { allErrors, validateDocument } from "../doc/validate";
import { sectionAt } from "../geom/section";
import { addFramePath } from "../weldment/frame";
import type { FrameIntent, Intent, NumberField } from "./schema";

/** One line of the cut list the plan expects. */
export interface ExpectedCut {
  designation: string;
  length: number;
  /** Degrees from square, the larger first. */
  angles: [number, number];
  quantity: number;
}

export interface FrameExpectation {
  size: Vec3;
  members: number;
  cutList: ExpectedCut[];
}

export type FramePlan =
  | { ok: true; doc: RawDocument; expect: FrameExpectation; notes: string[] }
  | { ok: false; error: string };

/** The section to build from: the part's copy of a profile, and one of its sizes. */
export interface FrameSection {
  def: ProfileDef;
  designation: string;
}

export function planFrame(intent: Intent, section: FrameSection): FramePlan {
  const fr = intent.frame;
  if (intent.kind !== "frame" || !fr) return { ok: false, error: "not a frame" };
  if (fr.corners === "unspecified") return { ok: false, error: "say how the corners are joined" };
  const k = intent.units === "in" ? 25.4 : 1;
  const conversions: string[] = [];
  const mm = (f: NumberField, label: string): number => {
    const v = f.value!;
    if (k === 1) return v;
    const out = Math.round(v * k * 1e9) / 1e9;
    conversions.push(`${label} ${v} in → ${out} mm`);
    return out;
  };
  const table = fr.type === "table";
  const L = mm(fr.length, "length");
  const W = mm(fr.width, "width");
  const H = table ? mm(fr.height, "height") : 0;
  const size = sectionAt(section.def, section.designation);
  if (!size.ok) return { ok: false, error: `${section.designation}: ${size.error}` };
  const [ex, ey] = size.props.envelope;
  if (table && H <= ey) return { ok: false, error: `a ${H} mm high table can't stand under ${ey} mm deep rails` };
  if (Math.min(L, W) <= 2 * Math.max(ex, ey)) return { ok: false, error: `${L} × ${W} mm is too small for ${section.designation}` };

  const z = table ? "=frame_h" : 0;
  const parameters: Record<string, number> = { frame_w: L, frame_d: W, ...(table ? { frame_h: H } : {}) };
  const nodes: Record<string, (number | string)[]> = {
    A: [0, 0, z],
    B: ["=frame_w", 0, z],
    C: ["=frame_w", "=frame_d", z],
    D: [0, "=frame_d", z],
    ...(table ? { E: [0, 0, 0], F: ["=frame_w", 0, 0], G: ["=frame_w", "=frame_d", 0], H: [0, "=frame_d", 0] } : {}),
  };
  const name = section.def.name;
  let doc: RawDocument = {
    version: 1,
    units: "mm",
    name: intent.name.trim() || (table ? "table frame" : "frame"),
    parameters,
    profiles: { [name]: section.def },
    nodes,
    features: [],
  };
  const mitre = fr.corners === "mitre";
  const path = (p: string, mitred: boolean) => {
    const r = addFramePath(doc, { profile: name, size: section.designation, path: p, line: "outside", mitre: mitred });
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
  };
  try {
    path("A B C D A", mitre);
    if (table) path("E A, F B, G C, H D", false);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const member = (id: string) => doc.features.find((f) => f.id === id)!;
  if (!table) {
    // A flat frame sits on the floor.
    for (const id of ["AB", "BC", "CD", "DA"]) {
      const f = member(id);
      f.align = [(f.align as number[] | undefined)?.[0] ?? 0, -1];
    }
  }
  if (!mitre) {
    // Butt corners: the legs run through on a table; the long sides on a flat frame.
    const through: Record<string, string> = table ? { A: "EA", B: "FB", C: "GC", D: "HD" } : { A: "AB", B: "AB", C: "CD", D: "CD" };
    for (const [node, t] of Object.entries(through)) doc.features.push({ id: `corner_${node}`, op: "joint", node, type: "butt", through: t });
  }
  const errors = allErrors(validateDocument(doc));
  if (errors.length) return { ok: false, error: `the plan does not validate: ${errors.join("; ")}` };

  // What the cut list must say. The rails' depth is the section's height; across, its width.
  const cuts: [number, [number, number]][] = [];
  const add = (n: number, length: number, angles: [number, number]) => {
    for (let i = 0; i < n; i++) cuts.push([length, angles]);
  };
  const m45: [number, number] = [45, 45];
  const sq: [number, number] = [0, 0];
  if (mitre) {
    add(2, L, m45);
    add(2, W, m45);
    if (table) add(4, H - ey, sq);
  } else if (table) {
    // A leg's x is across X, its y across Y; the rails stop at its faces.
    add(2, L - 2 * ex, sq);
    add(2, W - 2 * ey, sq);
    add(4, H, sq);
  } else {
    // The long sides run through; the short ones stop at their inner faces (a rail's x is across the frame).
    add(2, L, sq);
    add(2, W - 2 * ex, sq);
  }
  const notes = [`Sizes are outside sizes: the nodes are the frame's outside corners, and each member's line runs along its outer edge.`];
  if (conversions.length) notes.unshift(`Converted from inches once (× 25.4): ${conversions.join("; ")}.`);
  return {
    ok: true,
    doc,
    expect: { size: [L, W, table ? H : ey], members: cuts.length, cutList: groupCuts(section.designation, cuts) },
    notes,
  };
}

function groupCuts(designation: string, cuts: [number, [number, number]][]): ExpectedCut[] {
  const lines = new Map<string, ExpectedCut>();
  for (const [length, angles] of cuts) {
    const l = Math.round(length * 10) / 10;
    const key = `${l}|${angles.join(",")}`;
    const line = lines.get(key) ?? { designation, length: l, angles, quantity: 0 };
    line.quantity++;
    lines.set(key, line);
  }
  return [...lines.values()].sort((a, b) => b.length - a.length || b.angles[0] - a.angles[0]);
}

/** "a 1200 × 600 × 900 mm table frame" */
export function frameWords(fr: FrameIntent, size: number[] | null): string {
  const s = size ? size.map((v) => Math.round(v * 1e6) / 1e6).join(" × ") : "?";
  return `${/^(8|1[18](\D|$))/.test(s) ? "An" : "A"} ${s} mm ${fr.type === "table" ? "table frame" : "frame"}`;
}

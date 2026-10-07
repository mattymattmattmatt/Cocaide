// Building a frame from its nodes (Phase J): members along a path of nodes,
// "A B C D A, A E", as one change. Pure: works on the document through apply.

import { apply, type RawDocument } from "../doc/commands";
import type { Vec2, Vec3 } from "../doc/types";
import { validateDocument } from "../doc/validate";
import { memberFrame } from "../geom/member";
import { dot3, sub3 } from "../geom/vec";

export interface PathSpec {
  /** A profile in the part's profiles, and one of its sizes. */
  profile: string;
  size: string;
  /** Node names; a comma starts another path: "A B C D A, A E". */
  path: string;
  /**
   * "centre": the profile's anchor on each line. "outside": each member on
   * the outside of the frame, so the nodes are its outside corners.
   */
  line: "centre" | "outside";
  /** Mitre each corner where two members of one path meet. */
  mitre: boolean;
}

/** The paths in a path string: lists of node names. */
export function parsePaths(text: string): string[][] {
  return text
    .split(/[,;\n]/)
    .map((p) => p.split(/[\s>→-]+/).filter(Boolean))
    .filter((p) => p.length > 0);
}

/**
 * Where a member's line runs through its section to keep it on the outside
 * of the frame: on the envelope's side away from the middle of all the nodes.
 */
export function outsideAlign(from: Vec3, to: Vec3, middle: Vec3): Vec2 | undefined {
  const f = memberFrame(from, to);
  const c = sub3(middle, from);
  const side = (k: number): number => (k > 1e-6 ? -1 : k < -1e-6 ? 1 : 0);
  const align: Vec2 = [side(dot3(c, f.x)), side(dot3(c, f.y))];
  return align[0] === 0 && align[1] === 0 ? undefined : align;
}

export function addFramePath(doc: RawDocument, spec: PathSpec): { ok: true; doc: RawDocument; members: string[]; joints: string[] } | { ok: false; error: string } {
  const v = validateDocument(doc);
  const nodes = v.nodes;
  const paths = parsePaths(spec.path);
  if (!paths.length) return { ok: false, error: "type a path of nodes, like A B C D A" };
  for (const p of paths) {
    if (p.length < 2) return { ok: false, error: `"${p.join(" ")}" needs two nodes or more` };
    const unknown = p.filter((n) => !(n in nodes));
    if (unknown.length) return { ok: false, error: `no node ${unknown.join(", ")} (nodes: ${Object.keys(nodes).join(", ") || "none yet"})` };
  }
  const all = Object.values(nodes);
  const middle: Vec3 = [0, 1, 2].map((k) => all.reduce((t, n) => t + n[k], 0) / all.length) as Vec3;
  const jointAt = new Set(doc.features.filter((f) => f.op === "joint").map((f) => String(f.node)));
  let next = doc;
  const members: string[] = [];
  const joints: string[] = [];
  const add = (feature: Record<string, unknown>): string | null => {
    const r = apply(next, { type: "addFeature", feature });
    if (!r.ok) return r.error;
    next = r.doc;
    return null;
  };
  for (const p of paths) {
    const made: string[] = [];
    for (let i = 0; i + 1 < p.length; i++) {
      const [a, b] = [p[i], p[i + 1]];
      if (a === b) return { ok: false, error: `${a} follows itself in "${p.join(" ")}"` };
      const id = memberId(next, `${a}${b}`);
      const align = spec.line === "outside" ? outsideAlign(nodes[a], nodes[b], middle) : undefined;
      const problem = add({ id, op: "member", profile: spec.profile, size: spec.size, from: a, to: b, ...(align ? { align } : {}) });
      if (problem) return { ok: false, error: problem };
      made.push(id);
    }
    members.push(...made);
    if (!spec.mitre) continue;
    // Corners: where one member of the path ends and the next begins; a closed path's first node too.
    const closed = p.length > 2 && p[0] === p[p.length - 1];
    const corners = made.slice(1).map((m, i) => [p[i + 1], made[i], m]);
    if (closed) corners.push([p[0], made[made.length - 1], made[0]]);
    for (const [node, m1, m2] of corners) {
      if (jointAt.has(node)) continue;
      const id = memberId(next, `corner_${node}`);
      const problem = add({ id, op: "joint", node, type: "mitre", members: [m1, m2] });
      if (problem) return { ok: false, error: problem };
      jointAt.add(node);
      joints.push(id);
    }
  }
  return { ok: true, doc: next, members, joints };
}

/** The id itself if it is free, else id_2, id_3, ... */
function memberId(doc: RawDocument, id: string): string {
  const taken = new Set(doc.features.map((f) => f.id));
  if (!taken.has(id)) return id;
  for (let k = 2; ; k++) if (!taken.has(`${id}_${k}`)) return `${id}_${k}`;
}

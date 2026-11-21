// Members on a layout sketch's lines, the way a frame is usually modelled:
// draw the layout, pick a size, pick the lines. Each line becomes a member
// between two nodes that follow its ends (src/weldment/sketchNodes.ts), so
// editing the sketch moves the frame; ends that meet share a node, and each
// corner gets its joint: two members meeting at an angle are mitred (or
// butted), a member ending on another's side butts against it. One change,
// pure: works on the document through apply.

import { apply, type Command, type RawDocument } from "../doc/commands";
import type { MemberFeature, NodeLink, Vec3 } from "../doc/types";
import { memberAtNode, validateDocument } from "../doc/validate";
import { documentParameters } from "../doc/parameters";
import { dot3, sub3 } from "../geom/vec";
import { outsideAlign } from "./frame";
import { isNodeLink, resolveNodeLink, type SketchFrames } from "./sketchNodes";

/** A line of a sketch, picked. */
export interface SketchLine {
  sketch: string;
  entity: string;
  /** The member's id (its body's name too); default by how it runs: post_1, rail_1, brace_1 ... */
  id?: string;
}

export interface SketchMembersSpec {
  /** A profile in the part's profiles, and one of its sizes. */
  profile: string;
  size: string;
  lines: readonly SketchLine[];
  /** "centre": the profile's anchor on each line. "outside": each member on the outside of the frame, the lines its outside edges. */
  line: "centre" | "outside";
  /** What each corner gets: two members meeting at an angle mitred or butted; "none" leaves the corners to be joined by hand. */
  corners: "mitre" | "butt" | "none";
  /** Where sketches on faces are (the last rebuild's frames, by sketch id). */
  frames?: SketchFrames;
}

export type SketchMembersResult =
  | {
      ok: true;
      doc: RawDocument;
      members: string[];
      joints: string[];
      nodes: string[];
      skipped: string[];
      commands: Command[];
      /** Ends that nearly meet a member or another end but don't, so get no joint: what to fix in the sketch. */
      warnings: string[];
    }
  | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const near = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6;
const linkKey = (l: NodeLink) => `${l.sketch}:${l.point}`;

/** A sketch's (or 3D sketch's) own lines: not construction, not references to the model. */
export function ownLines(f: Record<string, unknown>): string[] {
  const list = f.op === "sketch3d" ? f.lines : f.entities;
  return (Array.isArray(list) ? list : [])
    .filter((e) => isObject(e) && (f.op === "sketch3d" || e.type === "line") && e.construction !== true && !e.ref)
    .map((e) => String((e as { id: unknown }).id));
}

/** The next free node name: A, B, ... Z, then N1, N2, ... */
export function freeNodeName(taken: ReadonlySet<string>): string {
  for (let i = 0; i < 26; i++) {
    const n = String.fromCharCode(65 + i);
    if (!taken.has(n)) return n;
  }
  for (let k = 1; ; k++) if (!taken.has(`N${k}`)) return `N${k}`;
}

/**
 * The id itself if it is free, else id_2, id_3, ... `numbered`: the id ends
 * in _1 and the next free number replaces it (post_1, post_2, ...).
 */
function freeId(doc: RawDocument, id: string, numbered = false): string {
  const taken = new Set(doc.features.map((f) => f.id));
  if (numbered) {
    const stem = id.replace(/_1$/, "");
    for (let k = 1; ; k++) if (!taken.has(`${stem}_${k}`)) return `${stem}_${k}`;
  }
  if (!taken.has(id)) return id;
  for (let k = 2; ; k++) if (!taken.has(`${id}_${k}`)) return `${id}_${k}`;
}

/** How far a point is from a member's line, and where along it (0 its from end, 1 its to end). */
function offLine(m: MemberFeature, p: Vec3): { d: number; t: number } {
  const d = sub3(m.to, m.from);
  const l2 = dot3(d, d);
  const t = l2 ? dot3(sub3(p, m.from), d) / l2 : 0;
  const c = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(p[0] - (m.from[0] + c * d[0]), p[1] - (m.from[1] + c * d[1]), p[2] - (m.from[2] + c * d[2])), t };
}

/** How far a member's section reaches from its line: half its two largest sizes' diagonal (as validation's butt check). */
function reachOf(doc: RawDocument, m: MemberFeature): number {
  const def = (isObject(doc.profiles) ? (doc.profiles as Record<string, { sizes?: { designation: string; values: Record<string, unknown> }[]; parameters?: Record<string, unknown> }>) : {})[m.profile];
  const values = def?.sizes?.find((x) => x.designation === m.size)?.values ?? def?.parameters ?? {};
  const sizes = Object.values(values).filter((x): x is number => typeof x === "number").sort((a, b) => b - a);
  return 0.5 * Math.hypot(sizes[0] ?? 0, sizes[1] ?? 0);
}

/** What a member is, by how it runs: within 10° of upright a post, of level a rail, else a brace. */
export function memberKind(a: Vec3, b: Vec3): "post" | "rail" | "brace" {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const up = Math.abs(d[2]) / Math.hypot(d[0], d[1], d[2]);
  return up >= Math.cos((10 * Math.PI) / 180) ? "post" : up <= Math.sin((10 * Math.PI) / 180) ? "rail" : "brace";
}

export function addSketchMembers(doc: RawDocument, spec: SketchMembersSpec): SketchMembersResult {
  if (!spec.lines.length) return { ok: false, error: "pick one or more sketch lines" };
  const params = documentParameters(doc);
  const v = validateDocument(doc, { sketchFrames: spec.frames });
  // Each line's two ends, in 3D.
  const lines: { line: SketchLine; ends: [Vec3, Vec3]; refs: [string, string] }[] = [];
  const seen = new Set<string>();
  for (const l of spec.lines) {
    const key = `${l.sketch}:${l.entity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sketch = doc.features.find((f) => f.id === l.sketch);
    if (!sketch || (sketch.op !== "sketch" && sketch.op !== "sketch3d")) return { ok: false, error: `there is no sketch "${l.sketch}"` };
    const list = sketch.op === "sketch3d" ? sketch.lines : sketch.entities;
    const e = (Array.isArray(list) ? list : []).find((x) => isObject(x) && x.id === l.entity) as Record<string, unknown> | undefined;
    if (!e) return { ok: false, error: `${l.sketch} has no ${sketch.op === "sketch3d" ? "line " : ""}${l.entity}` };
    if (sketch.op === "sketch" && e.type !== "line") return { ok: false, error: `${l.sketch}'s ${l.entity} is a ${String(e.type)}: a member runs along a straight line` };
    if (e.construction === true) return { ok: false, error: `${l.sketch}'s ${l.entity} is a construction line; pick the frame's own lines` };
    // A 3D sketch's line ends are its points: the nodes follow those (p2.at), shared by every line on them.
    const refs: [string, string] = sketch.op === "sketch3d" ? [`${String(e.start)}.at`, `${String(e.end)}.at`] : [`${l.entity}.start`, `${l.entity}.end`];
    const a = resolveNodeLink(doc.features, { sketch: l.sketch, point: refs[0] }, params, spec.frames);
    const b = resolveNodeLink(doc.features, { sketch: l.sketch, point: refs[1] }, params, spec.frames);
    if (!a.ok) return { ok: false, error: `${l.entity} ${a.error}` };
    if (!b.ok) return { ok: false, error: `${l.entity} ${b.error}` };
    if (near(a.at, b.at)) return { ok: false, error: `${l.sketch}'s ${l.entity} has no length` };
    lines.push({ line: l, ends: [a.at, b.at], refs });
  }

  // A node for each end: one already following that point, else one already there, else a new one following it.
  const rawNodes = isObject(doc.nodes) ? doc.nodes : {};
  const byLink = new Map<string, string>();
  for (const [n, val] of Object.entries(rawNodes)) if (isNodeLink(val)) byLink.set(linkKey(val), n);
  const placed: { name: string; at: Vec3; linked: boolean }[] = Object.entries(v.nodes).map(([name, at]) => ({ name, at, linked: isNodeLink(rawNodes[name]) }));
  const taken = new Set(Object.keys(rawNodes));
  const made: string[] = [];
  let next = doc;
  const commands: Command[] = [];
  const run = (cmd: Command): string | null => {
    const r = apply(next, cmd, { sketchFrames: spec.frames });
    if (!r.ok) return r.error;
    next = r.doc;
    commands.push(cmd);
    return null;
  };
  const nodeFor = (link: NodeLink, at: Vec3): string | { error: string } => {
    const linked = byLink.get(linkKey(link));
    if (linked) return linked;
    // Another node at the point: the linked ones first, so the member follows a sketch where it can.
    const there = placed.filter((p) => near(p.at, at)).sort((p, q) => Number(q.linked) - Number(p.linked))[0];
    if (there) return there.name;
    const name = freeNodeName(taken);
    const problem = run({ type: "setNode", name, at: link });
    if (problem) return { error: problem };
    taken.add(name);
    byLink.set(linkKey(link), name);
    placed.push({ name, at, linked: true });
    made.push(name);
    return name;
  };

  const all = lines.flatMap((l) => l.ends);
  const middle = [0, 1, 2].map((k) => all.reduce((t, p) => t + p[k], 0) / all.length) as Vec3;
  const members: string[] = [];
  const skipped: string[] = [];
  const existing = v.features.flatMap((vf) => (vf.feature?.op === "member" ? [vf.feature as MemberFeature] : []));
  const touched = new Set<string>();
  for (const { line, ends, refs } of lines) {
    const a = nodeFor({ sketch: line.sketch, point: refs[0] }, ends[0]);
    if (typeof a !== "string") return { ok: false, error: a.error };
    const b = nodeFor({ sketch: line.sketch, point: refs[1] }, ends[1]);
    if (typeof b !== "string") return { ok: false, error: b.error };
    const dup = existing.find((m) => (m.fromNode === a && m.toNode === b) || (m.fromNode === b && m.toNode === a));
    if (dup) {
      skipped.push(line.entity);
      continue;
    }
    if (line.id !== undefined && (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(line.id) || next.features.some((f) => f.id === line.id))) {
      return { ok: false, error: `${line.entity}: "${line.id}" ${next.features.some((f) => f.id === line.id) ? "is taken by another feature" : "is not an id (letters, digits, _ and -)"}` };
    }
    const id = line.id ?? freeId(next, `${memberKind(ends[0], ends[1])}_1`, true);
    const align = spec.line === "outside" ? outsideAlign(ends[0], ends[1], middle) : undefined;
    const problem = run({ type: "addFeature", feature: { id, op: "member", profile: spec.profile, size: spec.size, from: a, to: b, ...(align ? { align } : {}) } });
    if (problem) return { ok: false, error: problem };
    members.push(id);
    touched.add(a).add(b);
  }

  // The corners: each node a new member ends at that has no joint yet.
  const joints: string[] = [];
  const warnings: string[] = [];
  if (spec.corners !== "none" && members.length) {
    const after = validateDocument(next, { sketchFrames: spec.frames });
    const all = after.features.flatMap((vf) => (vf.feature?.op === "member" ? [vf.feature as MemberFeature] : []));
    const jointed = new Set(next.features.filter((f) => f.op === "joint").map((f) => String(f.node)));
    const length = (m: MemberFeature) => Math.hypot(...sub3(m.to, m.from));
    const dir = (m: MemberFeature, node: string): Vec3 => {
      const d = m.fromNode === node ? sub3(m.to, m.from) : sub3(m.from, m.to);
      const l = Math.hypot(...d);
      return [d[0] / l, d[1] / l, d[2] / l];
    };
    for (const node of touched) {
      if (jointed.has(node)) continue;
      const at = after.nodes[node];
      if (!at) continue;
      const ending = all.filter((m) => memberAtNode(m, node, at) === "ends");
      // Through the node, or near enough that the node is inside its section (a post stopped at a rail's underside).
      const passing = all
        .filter((m) => !ending.includes(m))
        .map((m) => ({ m, ...offLine(m, at) }))
        .filter((x) => x.t >= -1e-9 && x.t <= 1 + 1e-9 && x.d <= Math.max(0.01, reachOf(next, x.m)))
        .sort((p, q) => p.d - q.d)
        .map((x) => x.m);
      if (ending.length === 1 && !passing.length) {
        // A lone end: if it nearly meets a member, say so (it gets no joint as it is).
        const near = all
          .filter((m) => m !== ending[0])
          .map((m) => ({ m, ...offLine(m, at) }))
          .filter((x) => x.t >= -0.05 && x.t <= 1.05 && x.d <= 4 * reachOf(next, x.m) + 5)
          .sort((p, q) => p.d - q.d)[0];
        if (near) warnings.push(`${ending[0].id} ends ${Math.round(near.d * 10) / 10} mm from ${near.m.id}, so it isn't joined to it: take its sketch line onto ${near.m.id}'s`);
        // Or nearly meets another end.
        const other = Object.entries(after.nodes).find(([n, p]) => n !== node && Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]) <= 2 && all.some((m) => memberAtNode(m, n, p) === "ends"));
        if (!near && other) warnings.push(`${ending[0].id}'s end is ${Math.round(Math.hypot(...sub3(other[1], at)) * 100) / 100} mm from another end, so they aren't joined: make the two ends one point in the sketch`);
      }
      let feature: Record<string, unknown> | null = null;
      if (passing.length && ending.length) {
        // A member ending on another's side: it butts against it.
        feature = { op: "joint", node, type: "butt", through: passing[0].id };
      } else if (ending.length === 2) {
        const [m1, m2] = ending;
        const straight = dot3(dir(m1, node), dir(m2, node)) < -1 + 1e-6;
        if (straight) continue; // two in line: nothing to cut
        feature =
          spec.corners === "mitre"
            ? { op: "joint", node, type: "mitre", members: [m1.id, m2.id] }
            : { op: "joint", node, type: "butt", through: (length(m1) >= length(m2) ? m1 : m2).id };
      } else if (ending.length > 2) {
        // Three or more: one of two in line runs through (a run split at the node), else the longest; the others butt against it.
        const inLine = ending.filter((m) => ending.some((o) => o !== m && dot3(dir(m, node), dir(o, node)) < -1 + 1e-6));
        feature = { op: "joint", node, type: "butt", through: [...(inLine.length ? inLine : ending)].sort((p, q) => length(q) - length(p))[0].id };
      }
      if (!feature) continue;
      const id = freeId(next, `corner_${node}`);
      const problem = run({ type: "addFeature", feature: { id, ...feature } });
      if (problem) return { ok: false, error: problem };
      jointed.add(node);
      joints.push(id);
    }
  }
  if (!members.length) return { ok: false, error: skipped.length ? `every line picked has a member on it already` : "no members to add" };
  return { ok: true, doc: next, members, joints, nodes: made, skipped, commands, warnings };
}

/**
 * The tool form (the agent's membersFromSketch): { size, profile?, sketch? |
 * lines?: [{ sketch, entity }], line?, corners? }. The profile may be left out
 * when one profile of the part has the size; "sketch" takes all its own lines.
 */
export function membersFromSketch(doc: RawDocument, a: Record<string, unknown>, frames?: SketchFrames): SketchMembersResult {
  const profiles = isObject(doc.profiles) ? (doc.profiles as Record<string, { sizes?: { designation: string }[] }>) : {};
  const size = typeof a.size === "string" ? a.size : "";
  if (!size) return { ok: false, error: "size: name one of the part's profile sizes (addLibraryProfile adds a catalogue section)" };
  let profile = typeof a.profile === "string" ? a.profile : "";
  if (!profile) {
    const having = Object.entries(profiles).filter(([, p]) => p.sizes?.some((s) => s.designation === size)).map(([n]) => n);
    if (having.length !== 1) return { ok: false, error: having.length ? `size ${size} is in ${having.join(" and ")}: name the profile` : `no profile of the part has size "${size}" (add one with addLibraryProfile)` };
    profile = having[0];
  }
  let lines: SketchLine[] = [];
  if (Array.isArray(a.lines)) {
    lines = a.lines.flatMap((l) => (isObject(l) && typeof l.sketch === "string" && typeof l.entity === "string" && (l.id === undefined || typeof l.id === "string") ? [{ sketch: l.sketch, entity: l.entity, ...(typeof l.id === "string" ? { id: l.id } : {}) }] : []));
    if (lines.length !== a.lines.length) return { ok: false, error: 'lines: each is { "sketch": <sketch id>, "entity": <line id>, "id"?: <member id> }' };
  } else if (typeof a.sketch === "string") {
    const f = doc.features.find((x) => x.id === a.sketch);
    if (!f || (f.op !== "sketch" && f.op !== "sketch3d")) return { ok: false, error: `there is no sketch "${String(a.sketch)}"` };
    lines = ownLines(f).map((entity) => ({ sketch: String(a.sketch), entity }));
    if (!lines.length) return { ok: false, error: `${String(a.sketch)} has no lines of its own (construction and reference lines aren't taken)` };
  } else return { ok: false, error: 'name a "sketch" (all its lines) or "lines": [{ "sketch", "entity" }]' };
  const line = a.line === "centre" || a.line === "center" ? "centre" : "outside";
  const corners = a.corners === "butt" || a.corners === "none" ? a.corners : "mitre";
  return addSketchMembers(doc, { profile, size, lines, line, corners, frames });
}

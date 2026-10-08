// rebuild(doc) -> { ok, solid, measurements, errors[] }
//
// Features run in order against the part's bodies: named solids (Phase H).
// A part that names no body is one body, "main", as before. A feature is
// applied whole or not at all: a failed feature contributes nothing and the
// rebuild carries on, so one bad hole does not hide the rest of the part;
// every failure is reported as "<feature id>: <reason>".

import type { TopoDS_Shape } from "replicad-opencascadejs";
import { DEFAULT_BODY, DERIVED_SUFFIX, type JointFeature, type SketchFeature, type Vec3 } from "../doc/types";
import { validateDocument } from "../doc/validate";
import { checkConstraints } from "../geom/constraints";
import { planeFrame, to3D } from "../geom/frame";
import { placeSection } from "../geom/member";
import { buildProfile, entityPolylines } from "../geom/profile";
import { frameEnds, type FrameMember } from "../weldment/joints";
import { bodyRanges, compound, describePart, partShape, type BodyRange } from "./bodies";
import { memberCut } from "./cutlist";
import { interference, measure, volumeOf, type Measurements } from "./measure";
import { countSubShapes, describeFaces, faceSignature } from "./topology";
import { getOC, type OC, type Scope, scoped } from "./oc";
import {
  combineBodies,
  copyOut,
  cutMissed,
  drillTool,
  type Drilled,
  endCapTool,
  extrudeTool,
  fuseInto,
  gussetTool,
  memberTool,
  mergeMirror,
  mirrorTrsf,
  moveTrsfs,
  OpError,
  patternInstances,
  removeFrom,
  selectTreatedEdges,
  splitBody,
  transformLine,
  transformed,
  treatEdges,
  type SketchProfile,
} from "./ops";

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
  /** The part after the last successful feature: its one body, or a compound of its bodies. Owned by the result; call dispose(). */
  solid: TopoDS_Shape | null;
  /** The bodies, in the order they were made, with their face and edge ranges in `solid`. Owned by the result. */
  bodies: (BodyRange & { shape: TopoDS_Shape })[];
  measurements: Measurements | null;
  errors: string[];
  features: FeatureStatus[];
  sketches: SketchOverlay[];
  name: string;
  /** Each hole feature that built: where it was drilled, and how many copies its patterns made. */
  holes: HoleRecord[];
  /** With `provenance`: for each face of `solid` (FaceInfo.index order), the feature that first made it. */
  faceOrigins?: (string | null)[];
  dispose(): void;
}

/** A hole feature, where it was drilled: what a drawing's callout says and points at. */
export interface HoleRecord {
  feature: string;
  /** The centre where it enters the face. */
  entry: Vec3;
  /** Into the part, unit. */
  axis: Vec3;
  diameter: number;
  /** How deep it was drilled, mm (through: as far as the part goes). */
  depth: number;
  through: boolean;
  counterbore?: { diameter: number; depth: number };
  countersink?: { diameter: number; angle: number };
  /** Copies made by patterns of it. */
  copies: number;
}

export interface RebuildOptions {
  /** Record which feature first made each face (costs a face scan per feature). */
  provenance?: boolean;
}

export function rebuild(input: unknown, oc: OC = getOC(), opts: RebuildOptions = {}): RebuildResult {
  const v = validateDocument(input);
  const errors = [...v.headerErrors];
  const features: FeatureStatus[] = [];
  const sketches: SketchOverlay[] = [];
  /** The part's bodies, in the order they were first made. */
  const bodies = new Map<string, TopoDS_Shape>();

  /** Face signature -> the feature that first made a face like it. */
  const origins = new Map<string, string>();

  const result = (): RebuildResult => {
    const solid = bodies.size === 0 ? null : bodies.size === 1 ? [...bodies.values()][0] : scoped((s) => copyOut(compound(oc, s, [...bodies.values()])));
    const ranges = scoped((s) => bodyRanges(oc, s, bodies));
    const faceOrigins =
      opts.provenance && solid ? scoped((s) => describeFaces(oc, s, solid).infos.map((f) => origins.get(faceSignature(f)) ?? null)) : undefined;
    return {
      ok: errors.length === 0 && solid !== null,
      solid,
      bodies: ranges.map((r) => ({ ...r, shape: bodies.get(r.name)! })),
      measurements: solid ? scoped((s) => withMembers(s, measure(oc, s, solid, v.material, bodies, v.bodyMaterials))) : null,
      holes: drilled.filter((h) => features.find((f) => f.id === h.feature)?.ok && holeBodies.get(h)?.size !== 0),
      errors,
      features,
      sketches,
      name: v.name || "untitled",
      ...(faceOrigins ? { faceOrigins } : {}),
      dispose: () => {
        for (const b of bodies.values()) b.delete();
        if (bodies.size > 1) solid?.delete();
      },
    };
  };

  /**
   * The members: each body that is a member, or a copy or piece of one, with
   * its length and end angles read from the body along its own line, and its
   * mass.
   */
  function withMembers(s: Scope, m: Measurements): Measurements {
    for (const [name, mb] of memberBodies) {
      const body = m.bodies.find((b) => b.name === name);
      const shape = bodies.get(name);
      if (!body || !shape) continue;
      const cut = memberCut(oc, s, shape, mb.from, mb.dir);
      m.members.push({
        id: mb.id,
        body: body.name,
        profile: mb.profile,
        designation: mb.designation,
        length: r6(cut.length),
        angles: [r6(cut.angles[0]), r6(cut.angles[1])],
        perimeters: [r6(cut.perimeters[0]), r6(cut.perimeters[1])],
        ends: [cut.ends[0].map(r6) as Vec3, cut.ends[1].map(r6) as Vec3],
        massKg: body.massKg,
      });
    }
    return m;
  }

  /** Every member that can be placed, for the joints and what comes after them. */
  const frame = new Map<string, FrameMember>();
  /**
   * The bodies that are members, by body name, with the line each is measured
   * along: a member's own, or the line carried with a mirror, pattern, move or
   * copy of it. In the order they were made: the cut list's order.
   */
  const memberBodies = new Map<string, MemberLine>();
  /** A copy of a member body, its line carried by the same transforms. */
  const copyMember = (s: Scope, from: string, to: string, steps: ReturnType<typeof mirrorTrsf>[], id = to) => {
    const mb = memberBodies.get(from);
    if (mb) memberBodies.set(to, { ...mb, id, ...transformLine(oc, s, mb.from, mb.dir, steps) });
  };
  /** Where each hole feature drilled. */
  const drilled: HoleRecord[] = [];
  /** The bodies each hole is in: it goes where they go, and is gone with them. */
  const holeBodies = new Map<HoleRecord, Set<string>>();
  const holesIn = (names: string[]) => drilled.filter((h) => names.some((n) => holeBodies.get(h)?.has(n)));
  /** The bodies were copied (as `to`): each hole in them is there twice as many times. */
  const copyHoles = (to: Map<string, string>) => {
    for (const h of holesIn([...to.keys()])) {
      h.copies = 2 * h.copies + 1;
      const set = holeBodies.get(h)!;
      for (const [from, copy] of to) if (set.has(from)) set.add(copy);
    }
  };
  if (v.headerErrors.length > 0) return result();

  // The joints shape members wherever they are in the list: a member is built with the ends its joints give it.
  for (const vf of v.features) {
    const f = vf.feature;
    if (f?.op !== "member" || f.suppressed) continue;
    const def = v.profiles[f.profile];
    const r = def ? placeSection(f, def) : null;
    if (r?.ok) frame.set(f.id, { f, placed: r.placed });
  }
  const joints = v.features.flatMap((vf) => (vf.feature?.op === "joint" && !vf.feature.suppressed ? [vf.feature as JointFeature] : []));
  const shapes = frameEnds([...frame.values()], joints, v.nodes);
  /** Joints that made their cuts, to check once every member is built. */
  const checks: string[] = [];

  const profiles = new Map<string, SketchProfile | null>();
  /** The tool of each extrude, cut and hole, and where it went, for patterns. Disposed before returning. */
  const tools = new Map<string, Seed>();
  const suppressed = new Set<string>();
  const missing = (id: string, what: string) =>
    suppressed.has(id) ? `${what} "${id}" is suppressed` : `${what} "${id}" failed`;
  const need = (name: string): TopoDS_Shape => {
    const b = bodies.get(name);
    if (!b) throw new OpError(`no body "${name}" (${bodies.size ? `bodies: ${[...bodies.keys()].join(", ")}` : "no bodies yet"}); the feature that makes it failed or is suppressed`);
    return b;
  };
  /** The bodies a cut or hole works on: the ones it lists, or every body. */
  const targets = (listed: string[] | undefined | null): [string, TopoDS_Shape][] => (listed ? listed.map((n) => [n, need(n)] as [string, TopoDS_Shape]) : [...bodies]);

  /**
   * Commits a feature's changes to the bodies, all or none. Each changed body
   * must still be material. The shapes in `changed` belong to scope `s`.
   */
  const commit = (changed: Map<string, TopoDS_Shape>, removed: string[] = []) => {
    const out = new Map<string, TopoDS_Shape>();
    scoped((s) => {
      for (const [name, next] of changed) {
        if (countSubShapes(oc, s, next, "solid") === 0 || volumeOf(oc, s, next) <= 1e-9) {
          throw new OpError(bodies.size <= 1 ? "removes all the material: nothing of the part would be left" : `removes all of body "${name}"`);
        }
      }
    });
    for (const [name, next] of changed) out.set(name, copyOut(next));
    for (const [name, next] of out) {
      bodies.get(name)?.delete();
      bodies.set(name, next);
    }
    for (const name of removed) {
      bodies.get(name)?.delete();
      bodies.delete(name);
    }
    if (opts.provenance) {
      scoped((s) => {
        const shape = partShape(oc, s, bodies);
        if (!shape) return;
        for (const f of describeFaces(oc, s, shape).infos) {
          const sig = faceSignature(f);
          if (!origins.has(sig)) origins.set(sig, current);
        }
      });
    }
  };
  let current = "";

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
      current = raw.id;
      switch (raw.op) {
        case "sketch":
          profiles.set(raw.id, null);
          sketches.push(overlay(raw, false));
          profiles.set(raw.id, buildSketch(raw));
          sketches[sketches.length - 1].ok = true;
          break;
        case "extrude": {
          const profile = profiles.get(raw.sketch);
          if (!profile) throw new OpError(`${missing(raw.sketch, "sketch")}, so there is no profile to ${raw.op}`);
          const name = raw.newBody ?? raw.body ?? DEFAULT_BODY;
          if (raw.newBody && bodies.has(raw.newBody)) throw new OpError(`a body "${raw.newBody}" already exists; use "body" to add to it`);
          const into = raw.newBody ? null : raw.body ? need(raw.body) : (bodies.get(DEFAULT_BODY) ?? null);
          scoped((s) => {
            const tool = extrudeTool(oc, s, raw, profile, partShape(oc, s, bodies));
            commit(new Map([[name, fuseInto(oc, s, into, tool, "extrusion")]]));
            tools.set(raw.id, { tool: copyOut(tool), kind: "fuse", into: raw.newBody ? undefined : name, newBody: raw.newBody });
          });
          break;
        }
        case "cut": {
          const profile = profiles.get(raw.sketch);
          if (!profile) throw new OpError(`${missing(raw.sketch, "sketch")}, so there is no profile to ${raw.op}`);
          const on = targets(raw.bodies);
          scoped((s) => {
            const tool = extrudeTool(oc, s, raw, profile, partShape(oc, s, on.map(([, b]) => b)));
            commit(removeFrom(oc, s, on, tool, { listed: !!raw.bodies, what: "cut", missed: cutMissed(raw, profile) }));
            tools.set(raw.id, { tool: copyOut(tool), kind: "cut", bodies: raw.bodies ?? null });
          });
          break;
        }
        case "hole": {
          if (bodies.size === 0) throw new OpError("nothing to drill: there is no solid before this feature");
          const on = targets(raw.bodies);
          scoped((s) => {
            const at = (d: Drilled) =>
              drilled.push({
                feature: raw.id,
                entry: d.entry.map(r6) as Vec3,
                axis: d.into.map(r6) as Vec3,
                diameter: raw.diameter,
                depth: r6(d.length),
                through: raw.depth === "through",
                ...(raw.counterbore ? { counterbore: raw.counterbore } : {}),
                ...(raw.countersink ? { countersink: raw.countersink } : {}),
                copies: 0,
              });
            const start = drilled.length;
            const tool = drillTool(oc, s, raw, describePart(oc, s, bodies, false), partShape(oc, s, on.map(([, b]) => b))!, at);
            const cut = removeFrom(oc, s, on, tool, { listed: !!raw.bodies, what: "hole", missed: "" });
            commit(cut);
            for (const h of drilled.slice(start)) holeBodies.set(h, new Set(cut.keys()));
            tools.set(raw.id, { tool: copyOut(tool), kind: "cut", bodies: raw.bodies ?? null });
          });
          break;
        }
        case "fillet":
        case "chamfer": {
          if (bodies.size === 0) throw new OpError(`nothing to ${raw.op}: there is no solid before this feature`);
          scoped((s) => {
            const part = describePart(oc, s, bodies);
            const chosen = selectTreatedEdges(raw, part);
            const changed = new Map<string, TopoDS_Shape>();
            for (const r of part.ranges) {
              const mine = chosen.filter((i) => i >= r.edges[0] && i < r.edges[1]).map((i) => part.edges[i]);
              if (mine.length) changed.set(r.name, treatEdges(oc, s, raw, bodies.get(r.name)!, mine, bodies.size > 1 ? r.name : null));
            }
            commit(changed);
          });
          break;
        }
        case "linearPattern":
        case "circularPattern": {
          const seed = tools.get(raw.feature);
          if (!seed) throw new OpError(`${missing(raw.feature, "feature")}, so there is nothing to repeat`);
          if (bodies.size === 0) throw new OpError("nothing to pattern onto: there is no solid before this feature");
          scoped((s) => commit(...repeat(s, patternInstances(oc, s, raw), seed, (k) => `${seed.newBody}_${k + 2}`)));
          // A patterned hole is one callout with a count.
          for (const h of drilled.filter((x) => x.feature === raw.feature)) h.copies += raw.op === "linearPattern" ? raw.count * (raw.count2 ?? 1) - 1 : raw.count - 1;
          break;
        }
        case "member": {
          const def = v.profiles[raw.profile];
          if (!def) throw new OpError(`no profile "${raw.profile}" in the part`);
          const name = raw.newBody ?? raw.id;
          if (bodies.has(name)) throw new OpError(`a body "${name}" already exists; a member is a body of its own`);
          const line: MemberLine = { id: raw.id, profile: raw.profile, designation: raw.size, from: raw.from, dir: frame.get(raw.id)!.placed.dir };
          scoped((s) => {
            const tool = memberTool(oc, s, raw, def, shapes.ends.get(raw.id));
            commit(new Map([[name, tool]]));
            tools.set(raw.id, { tool: copyOut(tool), kind: "fuse", newBody: name, member: line });
          });
          memberBodies.set(name, line);
          break;
        }
        case "joint": {
          for (const id of [...(raw.members ?? []), ...(raw.through ? [raw.through] : [])]) {
            if (suppressed.has(id) || !frame.has(id)) throw new OpError(`${missing(id, "member")}, so there is nothing to join`);
          }
          const problem = shapes.errors.get(raw.id);
          if (problem) throw new OpError(problem);
          // Its members may come after it in the list: it checks its work once they are all built.
          checks.push(raw.id);
          break;
        }
        case "endCap": {
          const m = frame.get(raw.member);
          if (!m || !bodies.has(m.f.newBody ?? m.f.id)) throw new OpError(`${missing(raw.member, "member")}, so there is no end to cap`);
          const name = raw.newBody ?? raw.id;
          if (bodies.has(name)) throw new OpError(`a body "${name}" already exists; an end cap is a body of its own`);
          scoped((s) => commit(new Map([[name, endCapTool(oc, s, raw, m.f, m.placed, shapes.ends.get(m.f.id))]])));
          break;
        }
        case "gusset": {
          const [a, b] = raw.members.map((id) => {
            const m = frame.get(id);
            if (!m || !bodies.has(m.f.newBody ?? m.f.id)) throw new OpError(`${missing(id, "member")}, so there is no corner for the gusset`);
            return m;
          });
          const name = raw.newBody ?? raw.id;
          if (bodies.has(name)) throw new OpError(`a body "${name}" already exists; a gusset is a body of its own`);
          scoped((s) => commit(new Map([[name, gussetTool(oc, s, raw, v.nodes[raw.node], a, b)]])));
          break;
        }
        case "combine": {
          const target = need(raw.target);
          const others = raw.tools.map(need);
          scoped((s) => commit(new Map([[raw.target, combineBodies(oc, s, raw, target, others)]]), raw.tools));
          // A member combined with other material is a fabrication, not a length of stock.
          for (const n of [raw.target, ...raw.tools]) memberBodies.delete(n);
          // The tools' holes are in the target now.
          for (const h of holesIn(raw.tools)) holeBodies.get(h)!.add(raw.target);
          break;
        }
        case "mirror": {
          if (raw.bodies) {
            const listed = raw.bodies.map((n) => [n, need(n)] as const);
            scoped((s) => {
              const t = mirrorTrsf(oc, s, raw.plane);
              const changed = new Map<string, TopoDS_Shape>();
              const copies = new Map<string, string>();
              for (const [name, body] of listed) {
                const image = transformed(oc, s, body, t);
                if (raw.merge) changed.set(name, mergeMirror(oc, s, name, body, image));
                else {
                  const copy = raw.newBody ?? `${name}${DERIVED_SUFFIX.mirror}`;
                  changed.set(copy, image);
                  copies.set(name, copy);
                  copyMember(s, name, copy, [t]);
                }
              }
              commit(changed);
              if (raw.merge) for (const [name] of listed) memberBodies.delete(name);
              copyHoles(raw.merge ? new Map(listed.map(([n]) => [n, n])) : copies);
            });
          } else {
            const seed = tools.get(raw.feature!);
            if (!seed) throw new OpError(`${missing(raw.feature!, "feature")}, so there is nothing to mirror`);
            if (bodies.size === 0) throw new OpError("nothing to mirror onto: there is no solid before this feature");
            scoped((s) => commit(...repeat(s, [{ label: "the mirror", trsf: mirrorTrsf(oc, s, raw.plane) }], seed, () => raw.newBody ?? `${seed.newBody}${DERIVED_SUFFIX.mirror}`, "mirror")));
            // A mirrored hole is one more of it.
            for (const h of drilled.filter((x) => x.feature === raw.feature)) h.copies += 1;
          }
          break;
        }
        case "split": {
          const body = need(raw.body);
          const other = raw.newBody ?? `${raw.body}${DERIVED_SUFFIX.split}`;
          if (bodies.has(other)) throw new OpError(`a body "${other}" already exists; name the new piece with newBody`);
          scoped((s) => {
            const [behind, front] = splitBody(oc, s, raw.body, body, raw.plane);
            commit(new Map([[raw.body, behind], [other, front]]));
          });
          // Both pieces of a member are lengths of it, along its line.
          const mb = memberBodies.get(raw.body);
          if (mb) memberBodies.set(other, { ...mb, id: other });
          // A hole in the body may be in either piece.
          for (const h of holesIn([raw.body])) holeBodies.get(h)!.add(other);
          break;
        }
        case "move": {
          const listed = raw.bodies.map((n) => [n, need(n)] as const);
          scoped((s) => {
            const steps = moveTrsfs(oc, s, raw);
            const changed = new Map<string, TopoDS_Shape>();
            const copies = new Map<string, string>();
            for (const [name, body] of listed) {
              let moved = body;
              for (const t of steps) moved = transformed(oc, s, moved, t);
              const to = raw.copy ? (raw.newBody ?? `${name}${DERIVED_SUFFIX.move}`) : name;
              if (raw.copy && bodies.has(to)) throw new OpError(`a body "${to}" already exists; name the copy with newBody`);
              changed.set(to, moved);
              copies.set(name, to);
              copyMember(s, name, to, steps, raw.copy ? to : memberBodies.get(name)?.id);
            }
            commit(changed);
            if (raw.copy) copyHoles(copies);
            else {
              // A hole whose bodies all moved goes with them.
              const names = new Set(raw.bodies);
              for (const h of holesIn(raw.bodies)) {
                if (![...holeBodies.get(h)!].every((n) => names.has(n))) continue;
                const to = transformLine(oc, s, h.entry, h.axis, steps);
                h.entry = to.from.map(r6) as Vec3;
                h.axis = to.dir.map(r6) as Vec3;
              }
            }
          });
          break;
        }
        case "deleteBody": {
          for (const n of raw.bodies ?? raw.keep!) need(n);
          const gone = raw.bodies ?? [...bodies.keys()].filter((n) => !raw.keep!.includes(n));
          if (gone.length >= bodies.size) throw new OpError("would delete every body: nothing of the part would be left");
          commit(new Map(), gone);
          for (const n of gone) memberBodies.delete(n);
          // A hole is gone with the last body it was in.
          for (const h of holesIn(gone)) for (const n of gone) holeBodies.get(h)!.delete(n);
          break;
        }
      }
      features.push({ id: raw.id, op, ok: true });
    } catch (e) {
      const messages = e instanceof OpError ? e.message.split("\n") : [`kernel error: ${kernelMessage(oc, e)}`];
      const prefixed = messages.map((m) => `${raw.id}: ${m}`);
      // A failed feature leaves no tool behind for a pattern to repeat.
      const tool = tools.get(raw.id);
      if (tool) {
        tool.tool.delete();
        tools.delete(raw.id);
      }
      errors.push(...prefixed);
      features.push({ id: raw.id, op, ok: false, error: prefixed.join("\n") });
    }
  }
  for (const t of tools.values()) t.tool.delete();
  // Each joint checks its own work: the members it shaped must not overlap.
  for (const id of checks) {
    const built = new Map<string, TopoDS_Shape>();
    for (const m of shapes.shaped.get(id) ?? []) {
      const name = frame.get(m)!.f.newBody ?? m;
      const b = bodies.get(name);
      if (b) built.set(name, b);
    }
    const clash = scoped((s) => interference(oc, s, built));
    if (!clash.length) continue;
    const messages = clash.map((c) => `${id}: ${c.bodies[0]} and ${c.bodies[1]} still overlap by ${Math.round(c.volume * 1000) / 1000} mm³`);
    errors.push(...messages);
    const status = features.find((f) => f.id === id)!;
    status.ok = false;
    status.error = messages.join("\n");
  }
  if (bodies.size === 0 && errors.length === 0) errors.push("document: no solid; add an extrude");
  return result();

  /**
   * A pattern's copies of its seed, where the seed went: added to the same
   * body, as new bodies (seed_2, seed_3, ...), or cut from the same bodies.
   * Every copy must add or remove material.
   */
  function repeat(s: Scope, instances: { label: string; trsf: ReturnType<typeof mirrorTrsf> }[], seed: Seed, nameOf: (k: number) => string, what = "pattern"): [Map<string, TopoDS_Shape>] {
    const changed = new Map<string, TopoDS_Shape>();
    const now = (name: string) => changed.get(name) ?? need(name);
    instances.forEach((inst, k) => {
      const copy = transformed(oc, s, seed.tool, inst.trsf);
      if (seed.kind === "fuse" && seed.newBody) {
        const name = nameOf(k);
        if (bodies.has(name) || changed.has(name)) throw new OpError(`${inst.label}: a body "${name}" already exists`);
        changed.set(name, fuseInto(oc, s, null, copy, what));
        // A copy of a member is a member, along its line as it was made (the body may have moved or been combined since).
        if (seed.member) memberBodies.set(name, { ...seed.member, id: name, ...transformLine(oc, s, seed.member.from, seed.member.dir, [inst.trsf]) });
      } else if (seed.kind === "fuse") {
        const name = seed.into!;
        try {
          changed.set(name, fuseInto(oc, s, now(name), copy, what));
        } catch (e) {
          throw e instanceof OpError && e.message.startsWith("added no material") ? new OpError(`${inst.label} adds no material`) : e;
        }
      } else {
        const on = (seed.bodies ?? [...bodies.keys()]).map((n) => [n, now(n)] as [string, TopoDS_Shape]);
        let cut: Map<string, TopoDS_Shape>;
        try {
          cut = removeFrom(oc, s, on, copy, { listed: false, what, missed: "" });
        } catch (e) {
          throw e instanceof OpError && e.message.startsWith("removed no material") ? new OpError(`${inst.label} removes no material`) : e;
        }
        for (const [n, b] of cut) changed.set(n, b);
      }
    });
    return [changed];
  }
}

/** What a pattern repeats: a feature's tool, and where it went. */
interface Seed {
  tool: TopoDS_Shape;
  kind: "fuse" | "cut";
  /** fuse: the body it was added to. */
  into?: string;
  /** fuse: the body it started. */
  newBody?: string;
  /** cut: the bodies it was limited to (null: every body). */
  bodies?: string[] | null;
  /** A member's tool: its line, where it was made. */
  member?: MemberLine;
}

/** A body that is a length of stock: the member it is, and the line it is measured along. */
interface MemberLine {
  id: string;
  profile: string;
  designation: string;
  from: Vec3;
  dir: Vec3;
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

function r6(x: number): number {
  return Math.round(x * 1e6) / 1e6 + 0;
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

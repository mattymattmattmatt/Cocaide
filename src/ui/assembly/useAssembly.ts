// The assembly workspace's state and actions (the Assembly tab): its parts
// built in the kernel worker, the scene on screen, the solve, what is
// selected, and every edit as one undo step with the mates solved.

import { explodeOffsets } from "../../doc/assembly";
import { autoExplode, explodeWithout, withOffset } from "../../assembly/explode";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nextComponentId, nextMateId, SELF, validateAssembly } from "../../doc/assembly";
import type { Command, RawDocument } from "../../doc/commands";
import { geometryKey } from "../../doc/drawing";
import type { Assembly, AssemblyComponent, Mate, MateRef, MateType, Vec3 } from "../../doc/types";
import { Checker } from "../../doc/validate";
import { edgeSelectorFor, faceSelectorFor } from "../../kernel/synthesize";
import type { KernelClient } from "../../worker/client";
import type { RebuildView } from "../../worker/protocol";
import { componentStates, facesAlign, floatingGroups, motionWords, partSize, partDocument, partDocuments, partName, placed, solveAssembly, type AssemblySolve } from "../../assembly/model";
import { copiesThatHold, linedHoles, occupiedHoles, sortClashes, suggestMates, type Clash, type MateSuggestion } from "../../assembly/features";
import { stepPart } from "../files/plan";
import { mateFlips, startingWay } from "../../assembly/flip";
import { selectEdges, selectFaces } from "../../kernel/selectors";
import { measureNow, world } from "../../assembly/solve";
import { mul, transpose, written } from "../../assembly/transform";
import { measurePick } from "../evaluate/measure";
import { composeScene, type AssemblyScene, type Owner } from "../../assembly/scene";
import { asAppearance, PartAppearances } from "../../appearance";
import { BODY_COLORS } from "../Viewport";
import { PART_GREY, type LookInfo } from "../appearance/targets";
import type { Appearance } from "../../doc/types";
import { placementOf, pointTo, apply as rotate } from "../../assembly/transform";
import { pickInto, EMPTY_SELECTION, type PickTarget, type Selection } from "../model/selection";
import { pickFile, saveFile } from "../files/pick";
import type { HandleSpec } from "../evaluate/handles";

export type AssemblyItem = { kind: "component" | "mate"; id: string } | null;

export interface AssemblyOptions {
  doc: RawDocument | null;
  dispatch(cmd: Command): string | null;
  kernel: KernelClient;
  notice(text: string, kind?: "info" | "error"): void;
  /** The example parts, by name: their documents' text. */
  examples: Record<string, string>;
  active: boolean;
}

/** What a picked face or edge is, as a mate holds it, and where it is now in the assembly. */
interface Picked {
  ref: MateRef;
  kind: "plane" | "axis" | "other";
  normal?: Vec3;
  point?: Vec3;
  /** A round face's radius. */
  radius?: number;
}

export function useAssembly(o: AssemblyOptions) {
  const { doc } = o;
  const asm = useMemo((): Assembly | null => (doc?.assembly === undefined ? null : validateAssembly(doc.assembly, new Checker("document"))), [doc]);
  const [views, setViews] = useState<Map<string, RebuildView>>(new Map());
  const keys = useRef(new Map<string, string>());
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  /** Measure is on: a click adds a face or edge to what is measured (no Ctrl), a third starts again. */
  const [measuring, setMeasuring] = useState(false);
  const [item, setItem] = useState<AssemblyItem>(null);
  const [fitToken, setFitToken] = useState(0);
  const [clashes, setClashes] = useState<Clash[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** A component being dragged by its handles: where it is shown meanwhile (the document changes when the drag ends). */
  const [dragging, setDragging] = useState<{ id: string; at: Vec3; rotation: Vec3 } | null>(null);
  /** Isolate: only these components drawn (a view state, not saved); null: all. */
  const [isolated, setIsolated] = useState<string[] | null>(null);

  // Each part the assembly uses, built in the worker (again when it changes).
  const docs = useMemo(() => (doc && asm ? partDocuments(doc as Record<string, unknown>, asm) : {}), [doc, asm]);
  useEffect(() => {
    if (!o.active) return;
    let gone = false;
    for (const [key, part] of Object.entries(docs)) {
      const g = geometryKey(part);
      if (keys.current.get(key) === g) continue;
      keys.current.set(key, g);
      o.kernel
        .partView(part)
        .then((v) => {
          if (gone || keys.current.get(key) !== g) return;
          setViews((m) => new Map(m).set(key, v));
        })
        .catch((e: Error) => o.notice(`${partName(doc as Record<string, unknown>, key)} didn't build: ${e.message}`, "error"));
    }
    return () => {
      gone = true;
      // The next run asks again for what this one didn't get back.
      for (const key of Object.keys(docs)) if (!views.has(key)) keys.current.delete(key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs, o.active]);

  const solve = useMemo((): AssemblySolve | null => (asm && asm.mates?.length ? solveAssembly(asm, views) : null), [asm, views]);
  // Exploded: each component moved by its explode steps (a view state; the steps are in the file).
  const [exploded, setExploded] = useState(false);
  const offsets = useMemo(() => explodeOffsets(asm ?? undefined), [asm]);
  const scene = useMemo(
    (): AssemblyScene =>
      composeScene(
        (asm?.components ?? []).map((k) => {
          const P = placementOf(dragging?.id === k.id ? dragging : k);
          const o = exploded ? offsets.get(k.id) : undefined;
          return { id: k.id, placement: o ? { R: P.R, t: [P.t[0] + o[0], P.t[1] + o[1], P.t[2] + o[2]] as Vec3 } : P, view: views.get(k.part), hidden: k.hidden };
        }),
        typeof doc?.name === "string" ? `${doc.name} assembly` : "assembly",
      ),
    [asm, views, doc?.name, dragging, exploded, offsets],
  );
  const partOfComponent = (id: string) => {
    const c = asm?.components.find((x) => x.id === id);
    return c ? views.get(c.part) : undefined;
  };
  /** Explode on or off; the first time, the steps are worked out from the mates (one undo step). */
  const toggleExplode = () => {
    if (exploded) return setExploded(false);
    if (!asm) return;
    if (!asm.explode?.length) {
      const steps = autoExplode(asm, partOfComponent);
      if (!steps.length) return o.notice("Nothing to explode: mate the components first (each moves off the part it is mated to).", "error");
      commit({ ...asm, explode: steps }, "Explode", false);
    }
    setExploded(true);
    setFitToken((t) => t + 1);
  };
  /** The steps worked out again from the mates, `scale` times as far. */
  const reExplode = (scale = 1) => {
    if (!asm) return;
    const steps = autoExplode(asm, partOfComponent, scale);
    const next: Assembly = { ...asm };
    if (steps.length) next.explode = steps;
    else delete next.explode;
    commit(next, scale === 1 ? "Explode again" : `Explode ×${scale}`, false);
    setExploded(true);
    setFitToken((t) => t + 1);
  };
  const clearExplode = () => {
    if (!asm?.explode) return;
    const next: Assembly = { ...asm };
    delete next.explode;
    commit(next, "Collapse", false);
    setExploded(false);
  };
  const setExplodeOffset = (id: string, offset: Vec3) => {
    if (!asm) return;
    const steps = withOffset(asm, id, offset);
    const next: Assembly = { ...asm };
    if (steps.length) next.explode = steps;
    else delete next.explode;
    commit(next, `Explode ${id}`, false);
  };
  // The view fits the assembly when it first shows something, and again when a component comes in (so it is in view).
  const shownCount = scene.view.bodies.length;
  const lastCount = useRef(0);
  useEffect(() => {
    if (shownCount > lastCount.current) setFitToken((t) => t + 1);
    lastCount.current = shownCount;
  }, [shownCount]);

  /** Commits the assembly as one undo step; with `solve`, the mates move the components first. */
  const commit = useCallback(
    (next: Assembly | null, label: string, withSolve = true): string | null => {
      let out = next;
      if (out && withSolve && out.mates?.length) {
        const s = solveAssembly(out, views);
        out = placed(out, new Map([...s.placements].filter(([id]) => !out!.components.find((k) => k.id === id)?.fixed)));
      }
      const problem = o.dispatch({ type: "setAssembly", assembly: out as unknown as Record<string, unknown> | null, label });
      if (problem) o.notice(problem, "error");
      setClashes(null);
      return problem;
    },
    [o, views],
  );

  const base = (): Assembly => asm ?? { components: [] };

  /** Where a new component goes: beside what is there (+X), clear of it. */
  const beside = (): Vec3 => {
    const m = scene.view.mesh;
    if (!m || !m.positions.length) return [0, 0, 0];
    let max = -Infinity;
    for (let i = 0; i < m.positions.length; i += 3) max = Math.max(max, m.positions[i]);
    return [Math.ceil(max / 10) * 10 + 50, 0, 0];
  };

  const insert = (part: string, name: string, also?: (a: Assembly) => Assembly) => {
    const a = also ? also(base()) : base();
    const first = a.components.length === 0;
    const id = nextComponentId(a, name);
    const k: AssemblyComponent = { id, part, ...(first ? { fixed: true } : { at: beside() }) };
    const next = { ...a, components: [...a.components, k] };
    if (!commit(next, `Insert ${id}`, false)) {
      setItem({ kind: "component", id });
      o.notice(first ? `${id} is in, fixed at the origin: the next parts are mated to it.` : `${id} is in, beside the others: select a face of it and one of another, then pick a mate.`, "info");
    }
  };

  const insertSelf = () => insert(SELF, typeof doc?.name === "string" ? doc.name : "part");

  /** A part document (from a file or an example) carried in the assembly and put in. The same part again is used again. */
  const insertDocument = (part: Record<string, unknown>) => {
    if (!Array.isArray(part.features)) return o.notice("That isn't a part: it has no features.", "error");
    const name = typeof part.name === "string" && part.name.trim() ? part.name : "part";
    const { assembly: _a, drawing: _d, ...clean } = part;
    void _a;
    void _d;
    const parts = base().parts ?? {};
    const same = Object.entries(parts).find(([, d]) => geometryKey(d) === geometryKey(clean))?.[0];
    let key = same;
    if (!key) {
      const stem = name.replace(/[^\w-]+/g, "_") || "part";
      key = stem;
      for (let i = 2; key === SELF || key in parts; i++) key = `${stem}_${i}`;
    }
    const k = key;
    insert(k, name, (a) => (same ? a : { ...a, parts: { ...(a.parts ?? {}), [k]: clean } }));
  };

  const insertFile = async () => {
    const file = await pickFile(".json,.cocaide.json,application/json,.step,.stp,.STEP,.STP");
    if (!file) return;
    try {
      const text = await file.text();
      // A STEP file comes in as a part of its own (an imported solid): its faces, holes and bosses mate like any.
      if (/\.(step|stp)$/i.test(file.name)) {
        const made = stepPart(file.name, text);
        if (typeof made === "string") return o.notice(made, "error");
        insertDocument(made.doc as Record<string, unknown>);
        if (made.warning) o.notice(made.warning, "info");
        return;
      }
      insertDocument(JSON.parse(text));
    } catch (e) {
      o.notice(`${file.name} couldn't be read as a part: ${(e as Error).message}`, "error");
    }
  };

  /** A part in the file (not this one) replaced by a newer copy from a file: every component using it updates, where it is; mates find their faces again where they still exist. */
  const replacePart = async (key: string) => {
    if (key === SELF || !doc) return o.notice("That is this document's own part: change it on the Model tab.", "info");
    const file = await pickFile(".json,.cocaide.json,application/json,.step,.stp,.STEP,.STP");
    if (!file) return;
    let part: Record<string, unknown>;
    try {
      const text = await file.text();
      if (/\.(step|stp)$/i.test(file.name)) {
        const made = stepPart(file.name, text);
        if (typeof made === "string") return o.notice(made, "error");
        part = made.doc as Record<string, unknown>;
      } else part = JSON.parse(text);
    } catch (e) {
      return o.notice(`${file.name} couldn't be read as a part: ${(e as Error).message}`, "error");
    }
    const was = partName(doc as Record<string, unknown>, key);
    const users = (asm?.components ?? []).filter((k) => k.part === key).map((k) => k.id);
    const problem = o.dispatch({ type: "setAssemblyPart", key, part });
    if (problem) return o.notice(`Not replaced: ${problem}`, "error");
    o.notice(`Replaced ${was} with ${file.name}: ${users.join(", ")} ${users.length === 1 ? "updates" : "update"} where ${users.length === 1 ? "it is" : "they are"}. A mate whose face is gone shows red in the tree: pick its faces again.`);
  };

  const insertExample = (name: string) => {
    const text = o.examples[name];
    if (text) insertDocument(JSON.parse(text));
  };

  /** A face or edge of the scene, as its component's part names it. */
  const pickedRef = (kind: "face" | "edge", index: number): Picked | string => {
    const owners: Owner[] = kind === "face" ? scene.faceOwner : scene.edgeOwner;
    const owner = owners[index];
    if (!owner) return "That isn't part of a component.";
    const k = asm?.components.find((x) => x.id === owner.component);
    const v = k ? views.get(k.part) : undefined;
    if (!k || !v) return `${owner.component}'s part hasn't been built yet.`;
    const syn = kind === "face" ? faceSelectorFor(v.faces, owner.local) : edgeSelectorFor(v.edges, v.faces, owner.local);
    if (!syn.ok) return `That ${kind} of ${owner.component} can't be named so a rebuild finds it again: ${syn.error}`;
    const P = placementOf(k);
    if (kind === "face") {
      const f = v.faces.find((x) => x.index === owner.local)!;
      const ref: MateRef = { component: k.id, face: syn.selector as MateRef["face"] };
      if (f.type === "plane" && f.normal) return { ref, kind: "plane", normal: rotate(P.R, f.normal), point: pointTo(P, f.point ?? f.centroid) };
      if (f.cylinder) return { ref, kind: "axis", normal: rotate(P.R, f.cylinder.axis), point: pointTo(P, f.cylinder.origin), radius: f.cylinder.radius };
      return { ref, kind: "other" };
    }
    const e = v.edges.find((x) => x.index === owner.local)!;
    const ref: MateRef = { component: k.id, edge: syn.selector as MateRef["edge"] };
    if (e.kind === "line" && e.direction) return { ref, kind: "axis", normal: rotate(P.R, e.direction), point: pointTo(P, e.start) };
    if (e.kind === "circle" && e.axis && e.center) return { ref, kind: "axis", normal: rotate(P.R, e.axis), point: pointTo(P, e.center) };
    return { ref, kind: "other" };
  };

  /** The two things selected, as mates hold them (or why not). */
  const picks = useMemo((): Picked[] | string => {
    const list: Picked[] = [];
    for (const f of selection.faces) {
      const p = pickedRef("face", f);
      if (typeof p === "string") return p;
      list.push(p);
    }
    for (const e of selection.edges) {
      const p = pickedRef("edge", e);
      if (typeof p === "string") return p;
      list.push(p);
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, scene, asm, views]);

  /** Which mates the selection can make (all of them want two things of two components). */
  const mateChoices = useMemo((): { type: MateType; ok: boolean; why?: string }[] => {
    const types: MateType[] = ["coincident", "concentric", "distance", "parallel", "perpendicular", "angle", "tangent", "lock"];
    if (typeof picks === "string") return types.map((type) => ({ type, ok: false, why: picks }));
    if (picks.length !== 2) return types.map((type) => ({ type, ok: false, why: "Select two faces or edges, one on each of two components (Ctrl-click the second)" }));
    if (picks[0].ref.component === picks[1].ref.component) return types.map((type) => ({ type, ok: false, why: "Both are on one component: pick the second on another component" }));
    const [a, b] = picks.map((p) => p.kind);
    const planes = a === "plane" && b === "plane";
    const axes = a === "axis" && b === "axis";
    const oriented = a !== "other" && b !== "other";
    // Tangent: a round face (it has a radius) and a flat or round face.
    const [ra, rb] = [picks[0].radius !== undefined, picks[1].radius !== undefined];
    const tangent = (ra && rb) || (ra && b === "plane") || (rb && a === "plane");
    return types.map((type) => {
      // Lock takes anything of each: it holds the parts, not what was picked.
      const ok = type === "lock" ? true : type === "concentric" ? axes : type === "tangent" ? tangent : oriented;
      return { type, ok, ...(ok ? {} : { why: type === "concentric" ? "Concentric takes two round faces or edges (or axes)" : type === "tangent" ? "Tangent takes a round face and a flat or round face (faces, not edges)" : "Pick flat or round faces, or straight or round edges" }) };
    }).sort((x, y) => (planes ? 0 : 0) + Number(y.ok) - Number(x.ok) || 0);
  }, [picks]);

  /** Mates the two things selected: the value, for distance and angle, as they are now. */
  const mate = (type: MateType, value?: number) => {
    if (typeof picks === "string" || picks.length !== 2) return o.notice(typeof picks === "string" ? picks : "Select two faces or edges, one on each of two components.", "error");
    const [a, b] = picks;
    const m: Mate = { id: nextMateId(asm ?? undefined, type), type, a: a.ref, b: b.ref };
    if (type === "distance") {
      const now = a.normal && a.point && b.point ? Math.abs((b.point[0] - a.point[0]) * a.normal[0] + (b.point[1] - a.point[1]) * a.normal[1] + (b.point[2] - a.point[2]) * a.normal[2]) : 10;
      m.value = value ?? (Math.round(now * 1000) / 1000 || 10);
    }
    if (type === "angle") {
      const c = a.normal && b.normal ? Math.abs(a.normal[0] * b.normal[0] + a.normal[1] * b.normal[1] + a.normal[2] * b.normal[2]) : 1;
      m.value = value ?? (Math.round((Math.acos(Math.min(1, c)) * 180) / Math.PI * 1000) / 1000 || 45);
    }
    // Planes facing the same way stay so; otherwise they meet face to face.
    if ((type === "coincident" || type === "distance") && a.kind === "plane" && b.kind === "plane" && facesAlign(a.normal, b.normal)) m.aligned = true;
    // Directions (parallel, concentric, edges in line) the way they are now; a tangent on the side it is on.
    Object.assign(m, startingWay(type, a, b));
    // A lock: the second part where it is now from the first.
    if (type === "lock") m.relative = relativeNow(a.ref.component, b.ref.component);
    const next = { ...base(), mates: [...(base().mates ?? []), m] };
    if (!commit(next, `Mate ${m.id}`)) {
      setSelection(EMPTY_SELECTION);
      setItem({ kind: "mate", id: m.id });
    }
  };

  const editComponent = (id: string, patch: Partial<AssemblyComponent>, label: string, withSolve = true) => {
    const a = base();
    const next = { ...a, components: a.components.map((k) => (k.id === id ? clean({ ...k, ...patch }) : k)) };
    commit(next, label, withSolve);
  };

  /** Where component b is now from a (b's place in a's frame): what a lock keeps. */
  const relativeNow = (ida: string, idb: string): { at: Vec3; rotation: Vec3 } => {
    const P = (id: string) => placementOf(base().components.find((k) => k.id === id) ?? {});
    const pa = P(ida);
    const pb = P(idb);
    const Rt = transpose(pa.R);
    const w = written({ R: mul(Rt, pb.R), t: rotate(Rt, [pb.t[0] - pa.t[0], pb.t[1] - pa.t[1], pb.t[2] - pa.t[2]]) });
    const r = (v: Vec3) => v.map((x) => Math.round(x * 1e6) / 1e6 + 0) as Vec3;
    return { at: r(w.at), rotation: r(w.rotation) };
  };
  /** A lock (or a concentric mate's locked rotation) kept as the parts are now. */
  const lockHere = (id: string) => {
    const m = base().mates?.find((x) => x.id === id);
    if (m) editMate(id, { relative: relativeNow(m.a.component, m.b.component) }, `Lock ${id} here`);
  };
  /** A distance or angle mate's value as the parts are now (what a limit mate shows). */
  const mateNow = (m: Mate): number | null => {
    const h = solve?.held.find((x) => x.id === m.id);
    const pa = h && solve?.placements.get(h.a.component);
    const pb = h && solve?.placements.get(h.b.component);
    return h && pa && pb ? measureNow(h, world(h.a.geom, pa), world(h.b.geom, pb)) : null;
  };
  /** What a mate holds, lit up in the view: its two faces or edges (a lock: both parts). */
  const mateTargets = (m: Mate): PickTarget[] => {
    const v = scene.view;
    const out: PickTarget[] = [];
    const whole = (id: string) => {
      const b = v.bodies.find((x) => x.name === id);
      if (b) for (const f of v.faces.slice(b.faces[0], b.faces[1])) out.push({ kind: "face", index: f.index, point: f.centroid });
    };
    if (m.type === "lock") {
      whole(m.a.component);
      whole(m.b.component);
      return out;
    }
    for (const ref of [m.a, m.b]) {
      const k = asm?.components.find((x) => x.id === ref.component);
      const part = k ? views.get(k.part) : undefined;
      if (!k || !part) continue;
      if (ref.face) {
        const local = selectFaces(part.faces, ref.face).matches.map((f) => f.index);
        scene.faceOwner.forEach((o, i) => {
          if (o?.component === k.id && local.includes(o.local)) out.push({ kind: "face", index: i, point: v.faces[i].centroid });
        });
      } else if (ref.edge) {
        const r = selectEdges(part.edges, part.faces, ref.edge);
        const local = r.error ? [] : r.matches.map((e) => e.index);
        scene.edgeOwner.forEach((o, i) => {
          const e = v.edges[i];
          if (o?.component === k.id && local.includes(o.local) && e) out.push({ kind: "edge", index: i, point: e.mid ?? e.start });
        });
      } else whole(k.id);
    }
    return out;
  };
  /** A component lit up in the view: all its faces. */
  const componentTargets = (id: string): PickTarget[] => {
    const v = scene.view;
    const b = v.bodies.find((x) => x.name === id);
    return b ? v.faces.slice(b.faces[0], b.faces[1]).map((f) => ({ kind: "face" as const, index: f.index, point: f.centroid })) : [];
  };
  /** A mate's flips (see src/assembly/flip), from how the solver holds it and where its components are. */
  const flipsOf = (m: Mate) => mateFlips(m, solve?.held.find((h) => h.id === m.id), solve?.placements);

  const editMate = (id: string, patch: Partial<Mate>, label: string) => {
    const a = base();
    const next = { ...a, mates: (a.mates ?? []).map((m) => (m.id === id ? clean({ ...m, ...patch }) : m)) };
    commit(next, label);
  };

  const remove = (it: NonNullable<AssemblyItem>) => {
    const a = base();
    if (it.kind === "mate") commit({ ...a, mates: (a.mates ?? []).filter((m) => m.id !== it.id) }, `Delete ${it.id}`, false);
    else {
      const left = a.components.filter((k) => k.id !== it.id);
      const mates = (a.mates ?? []).filter((m) => m.a.component !== it.id && m.b.component !== it.id);
      // A part no component uses any more goes from the file too.
      const used = new Set(left.map((k) => k.part));
      const parts = Object.fromEntries(Object.entries(a.parts ?? {}).filter(([key]) => used.has(key)));
      const explode = explodeWithout(a.explode, it.id);
      const next: Assembly = { components: left, ...(mates.length ? { mates } : {}), ...(Object.keys(parts).length ? { parts } : {}), ...(explode.length ? { explode } : {}) };
      commit(left.length ? next : null, `Delete ${it.id}`, false);
    }
    setItem(null);
    setSelection(EMPTY_SELECTION);
  };

  const resolve = () => commit(base(), "Solve the mates");

  /** The mates the selected component most likely wants with each other component, best first (from their holes, bosses and faces). */
  const suggestions = useMemo((): (MateSuggestion & { other: string })[] => {
    const k = item?.kind === "component" ? asm?.components.find((x) => x.id === item.id) : undefined;
    const tk = k ? views.get(k.part) : undefined;
    if (!k || !tk || !asm) return [];
    const out: (MateSuggestion & { other: string })[] = [];
    for (const other of asm.components) {
      if (other.id === k.id) continue;
      const to = views.get(other.part);
      if (!to) continue;
      // The other component first, so a new mate reads "fixed part ↔ this one".
      const taken = occupiedHoles(asm, (id) => {
        const c = asm.components.find((x) => x.id === id);
        return c ? views.get(c.part) : undefined;
      });
      for (const sg of suggestMates(other, to, k, tk, { taken, lined: linedHoles(asm, other.id, k.id) })) out.push({ ...sg, other: other.id });
    }
    // Leave out what is mated already: a suggestion whose concentric pair is in the mates.
    const have = new Set((asm.mates ?? []).map((m) => JSON.stringify([m.type, m.a, m.b])));
    return out.filter((sg) => !sg.mates.every((m) => have.has(JSON.stringify([m.type, m.a, m.b])))).sort((a, b) => b.score - a.score).slice(0, 5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, asm, views]);

  /** Adds a suggestion's mates as one step, solved; refused when they don't then hold. */
  const applySuggestion = (sg: MateSuggestion) => {
    let a = base();
    const ids: string[] = [];
    for (const m of sg.mates) {
      const id = nextMateId(a, m.type);
      ids.push(id);
      a = { ...a, mates: [...(a.mates ?? []), { id, ...m } as Mate] };
    }
    const s = solveAssembly(a, views);
    const bad = s.mates.filter((m) => ids.includes(m.id) && !m.ok);
    if (bad.length) return o.notice(`That doesn't go together as suggested (${bad.map((m) => m.id).join(", ")} wouldn't hold): mate it by hand.`, "error");
    if (!commit(a, sg.what.length > 60 ? `Mate ${ids.join(", ")}` : `Mate: ${sg.what}`)) setItem({ kind: "mate", id: ids[0] });
  };

  /** The assembly checked: mates that don't hold, components held by nothing, what each can still do, and (when asked) overlaps. */
  const [checked, setChecked] = useState<{ issues: string[]; freedom: { id: string; fixed: boolean; motions: string[] }[] } | null>(null);
  const check = async () => {
    if (!asm) return;
    const s = solveAssembly(asm, views);
    const states = componentStates(asm, s, new Map([...views].map(([key, t]) => [key, partSize(t)])));
    const issues: string[] = [];
    for (const g of floatingGroups(asm)) issues.push(`${g.join(", ")} are mated to each other but to nothing fixed: they float together (mate one of them to the rest, or fix one)`);
    for (const m of s.mates) if (!m.ok) issues.push(`${m.id} ${m.problem ?? "doesn't hold"}`);
    for (const st of states) if (!st.fixed && st.motions.length === 6) issues.push(`${st.id} is held by nothing: mate it, or fix it`);
    setChecked({ issues, freedom: states.map((st) => ({ id: st.id, fixed: st.fixed, motions: st.motions.map(motionWords) })) });
    if (asm.components.length > 1) await interference();
  };

  /** The assembly's components as the kernel places them. */
  const placedForKernel = () => (asm?.components ?? []).map((k) => ({ id: k.id, part: k.part, ...placementOf(k), ...(k.appearance ? { appearance: k.appearance } : {}) }));

  const interference = async () => {
    if (!asm || !doc) return;
    setBusy("Checking interference…");
    try {
      const r = await o.kernel.assembly("interference", "assembly", docs, placedForKernel());
      if (!r.ok) return o.notice(`Interference: ${r.error}`, "error");
      const sorted = sortClashes(asm, r.interference ?? [], (id) => {
        const c = asm.components.find((x) => x.id === id);
        return c ? views.get(c.part) : undefined;
      });
      setClashes(sorted);
      const real = sorted.filter((c) => !c.expected).length;
      o.notice(real ? `${real} pair${real === 1 ? "" : "s"} of components overlap: see the list in Properties.` : sorted.length ? "No components clash (the overlaps listed are expected: bolts in tapped holes)." : "No components overlap.", real ? "error" : "info");
    } finally {
      setBusy(null);
    }
  };

  const exportStep = async () => {
    if (!asm || !doc) return;
    const name = `${typeof doc.name === "string" ? doc.name : "part"}-assembly`;
    setBusy("Writing STEP…");
    try {
      const r = await o.kernel.assembly("step", name, docs, placedForKernel());
      if (!r.ok || r.text === undefined) return o.notice(`STEP export: ${r.ok ? "nothing written" : r.error}`, "error");
      saveFile(`${name}.step`, r.text, "application/step");
      o.notice(`Exported ${name}.step: ${asm.components.length} component${asm.components.length === 1 ? "" : "s"}, each a named solid where it sits.`, "info");
    } finally {
      setBusy(null);
    }
  };

  /** The parts list: each part and how many components use it. */
  const bom = useMemo(() => {
    const rows = new Map<string, { part: string; name: string; qty: number }>();
    for (const k of asm?.components ?? []) {
      const r = rows.get(k.part) ?? { part: k.part, name: doc ? partName(doc as Record<string, unknown>, k.part) : k.part, qty: 0 };
      r.qty++;
      rows.set(k.part, r);
    }
    return [...rows.values()];
  }, [asm, doc]);

  const pick = (t: PickTarget | null, additive: boolean) => {
    // Faces and edges only: what mates hold.
    if (t && t.kind !== "face" && t.kind !== "edge") return;
    setSelection((s) => (measuring ? measurePick(s, t) : pickInto(s, t, additive)));
    if (measuring) return;
    const owner = t ? (t.kind === "face" ? scene.faceOwner[t.index] : scene.edgeOwner[t.index]) : null;
    if (owner && !additive) setItem({ kind: "component", id: owner.component });
  };

  /** The selected component's drag handles: an arrow along each axis, and a turn about Z, at its middle. */
  const handles = useMemo((): HandleSpec[] => {
    const k = item?.kind === "component" ? asm?.components.find((x) => x.id === item.id) : undefined;
    if (!k || k.fixed || k.hidden || exploded) return [];
    const body = scene.view.bodies.find((b) => b.name === k.id);
    if (!body || body.faces[1] <= body.faces[0]) return [];
    // Its middle: the mean of its faces' centres, as the drag started (the handles stay put while it moves).
    const fs = scene.view.faces.slice(body.faces[0], body.faces[1]);
    const mid = [0, 1, 2].map((i) => fs.reduce((sum, f) => sum + f.centroid[i], 0) / fs.length) as Vec3;
    const now = dragging?.id === k.id ? dragging : { at: (k.at ?? [0, 0, 0]) as Vec3, rotation: (k.rotation ?? [0, 0, 0]) as Vec3 };
    const base = (now.at as Vec3).slice() as Vec3;
    const start = dragging?.id === k.id ? [mid[0] - (now.at[0] - (k.at?.[0] ?? 0)), mid[1] - (now.at[1] - (k.at?.[1] ?? 0)), mid[2] - (now.at[2] - (k.at?.[2] ?? 0))] as Vec3 : mid;
    const arrow = (axis: 0 | 1 | 2): HandleSpec => ({
      id: `${k.id}:move:${"xyz"[axis]}`,
      feature: k.id,
      key: `at.${axis}`,
      label: `Move ${"XYZ"[axis]}`,
      value: base[axis],
      origin: start,
      dir: [0, 1, 2].map((i) => (i === axis ? 1 : 0)) as Vec3,
      scale: 1,
      offset: k.at?.[axis] ?? 0,
      min: null,
    });
    const turn: HandleSpec = {
      id: `${k.id}:turn:z`,
      feature: k.id,
      key: "rotation.2",
      label: "Turn about Z",
      value: now.rotation[2],
      kind: "angle",
      snap: "angle",
      origin: start,
      dir: [0, 0, 1],
      axis: [0, 0, 1],
      zero: [1, 0, 0],
      radius: 40,
      scale: 1,
      offset: k.rotation?.[2] ?? 0,
      min: null,
    };
    return [arrow(0), arrow(1), arrow(2), turn];
  }, [item, asm, scene, dragging, exploded]);

  /** A handle dragged: shown live, written (with the mates solved) when let go. */
  const onHandle = (h: HandleSpec, phase: "start" | "move" | "end" | "cancel", value: number | [number, number]) => {
    const k = asm?.components.find((x) => x.id === h.feature);
    if (!k || typeof value !== "number") return;
    const cur = dragging?.id === k.id ? dragging : { id: k.id, at: ((k.at ?? [0, 0, 0]) as Vec3).slice() as Vec3, rotation: ((k.rotation ?? [0, 0, 0]) as Vec3).slice() as Vec3 };
    const [what, i] = h.key.split(".");
    const next = { id: k.id, at: cur.at.slice() as Vec3, rotation: cur.rotation.slice() as Vec3 };
    (what === "at" ? next.at : next.rotation)[Number(i)] = Math.round(value * 1000) / 1000;
    if (phase === "cancel") return setDragging(null);
    if (phase === "end") {
      setDragging(null);
      editComponent(k.id, { at: next.at, rotation: next.rotation }, what === "at" ? `Move ${k.id}` : `Turn ${k.id}`);
      return;
    }
    setDragging(next);
  };

  // The view's see-through components, and what isolate hides (components gone from the assembly drop out).
  const clearBodies = useMemo(() => new Set((asm?.components ?? []).filter((k) => k.transparent).map((k) => k.id)), [asm]);
  // A colour being tried on a component in the picker (shown, not kept).
  const [lookTry, setLookTry] = useState<{ id: string; look: Appearance | null } | null>(null);
  // How each face of the scene looks: its component's own appearance, else its part's (null: the default colour).
  const appearances = useMemo((): (Appearance | null)[] | null => {
    if (!asm) return null;
    const looks = new Map<string, PartAppearances>();
    const lookOf = (part: string) => {
      let p = looks.get(part);
      if (!p) looks.set(part, (p = new PartAppearances(docs[part])));
      return p;
    };
    const byId = new Map(asm.components.map((k) => [k.id, k]));
    let any = false;
    const out = scene.faceOwner.map((o) => {
      const k = byId.get(o.component);
      if (!k) return null;
      const own = lookTry?.id === k.id ? lookTry.look : asAppearance(k.appearance);
      const face = own ? null : views.get(k.part)?.faces[o.local];
      const look = own ?? (face ? (lookOf(k.part).face(face)?.appearance ?? null) : null);
      if (look) any = true;
      return look;
    });
    return any ? out : null;
  }, [asm, scene, views, docs, lookTry]);
  /** How a component looks: its own colour, what its part shows, and its default colour in the view. */
  const componentLook = (id: string): LookInfo => {
    const i = asm?.components.findIndex((k) => k.id === id) ?? -1;
    const k = i >= 0 ? asm!.components[i] : undefined;
    const shown = (asm?.components ?? []).filter((x) => !x.hidden);
    const at = shown.findIndex((x) => x.id === id);
    return {
      title: `Component ${id}`,
      own: asAppearance(k?.appearance),
      inherited: k ? new PartAppearances(docs[k.part]).partLook() : null,
      fallback: shown.length > 1 && at >= 0 ? BODY_COLORS[at % BODY_COLORS.length] : PART_GREY,
    };
  };
  const isolateHides = useMemo(() => (isolated ? new Set((asm?.components ?? []).filter((k) => !isolated.includes(k.id)).map((k) => k.id)) : new Set<string>()), [asm, isolated]);

  // The selected component copied into the other holes of its size (when it sits in a hole): what the button offers.
  const holeCopyPlan = useMemo(() => {
    if (!asm || item?.kind !== "component") return null;
    const partOf = (id: string) => {
      const c = asm.components.find((x) => x.id === id);
      return c ? views.get(c.part) : undefined;
    };
    const plan = copiesThatHold(asm, item.id, partOf, views);
    return typeof plan === "string" ? null : plan;
  }, [asm, item, views]);
  const copyToHoles = () => {
    if (!holeCopyPlan || item?.kind !== "component") return;
    const why = commit(holeCopyPlan.next, `Copy ${item.id} to ${holeCopyPlan.copies.length} hole${holeCopyPlan.copies.length === 1 ? "" : "s"}`);
    if (why) o.notice(why, "error");
    else o.notice(`${item.id} copied into ${holeCopyPlan.copies.length} more hole${holeCopyPlan.copies.length === 1 ? "" : "s"}: ${holeCopyPlan.copies.join(", ")}${holeCopyPlan.skipped ? ` (${holeCopyPlan.skipped} left out: their mates wouldn't hold)` : ""}.`, "info");
  };

  /** The components of the faces and edges picked. */
  const selectedComponents = () => [...new Set([...selection.faces.map((i) => scene.faceOwner[i]?.component), ...selection.edges.map((i) => scene.edgeOwner[i]?.component)].filter((x): x is string => !!x))];

  return {
    doc,
    asm,
    exploded,
    offsets,
    toggleExplode,
    reExplode,
    clearExplode,
    setExplodeOffset,
    selectedComponents,
    holeCopyPlan,
    copyToHoles,
    isolated,
    setIsolated,
    clearBodies,
    appearances,
    componentLook,
    setLookTry,
    isolateHides,
    suggestions,
    applySuggestion,
    checked,
    check,
    handles,
    onHandle,
    views,
    scene,
    solve,
    selection,
    setSelection,
    measuring,
    setMeasuring,
    item,
    setItem,
    fitToken,
    fit: () => setFitToken((t) => t + 1),
    clashes,
    busy,
    /** The parts built so far, of those the assembly uses (they come back one by one). */
    built: { done: Object.keys(docs).filter((k) => views.has(k)).length, total: Object.keys(docs).length },
    bom,
    mateChoices,
    pick,
    insertSelf,
    insertFile,
    insertExample,
    replacePart,
    mate,
    editComponent,
    editMate,
    flipsOf,
    lockHere,
    relativeNow,
    mateNow,
    mateTargets,
    componentTargets,
    remove,
    resolve,
    interference,
    exportStep,
    partName: (key: string) => (doc ? partName(doc as Record<string, unknown>, key) : key),
    partDocument: (key: string) => (doc ? partDocument(doc as Record<string, unknown>, key) : undefined),
    examples: Object.keys(o.examples),
  };
}

export type AssemblyWorkspace = ReturnType<typeof useAssembly>;

/** An object without its undefined and false-default keys. */
function clean<T extends object>(x: T): T {
  const out = { ...x } as Record<string, unknown>;
  for (const [k, v] of Object.entries(out)) if (v === undefined || v === false || v === null) delete out[k];
  return out as T;
}

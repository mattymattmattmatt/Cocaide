// A single-cylinder engine with an intake manifold, assembled with every kind of mate (tests/engine-parts.ts): the
// parts go in out of place and the mates bring each one home, which for a part drawn where it sits in the engine is
// its own origin, so the test can check the assembly exactly. Coincident (face to face and aligned, and on default
// planes), distance (aligned, flipped, and a limit), parallel, perpendicular, angle, concentric (aligned and opposed,
// and with its rotation locked), tangent and lock. Then the crank is turned by its angle mate and the piston follows,
// as the slider-crank formula says it must.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/session";
import { loadOC, rebuild } from "../src/kernel";
import { selectFaces } from "../src/kernel/selectors";
import { topologyOf } from "../src/kernel/inspect";
import { ENGINE, engineParts, flat, round } from "./engine-parts";

type R = Record<string, any>;
const parts = engineParts();
let dir: string;
let oc: Awaited<ReturnType<typeof loadOC>>;
beforeAll(async () => {
  oc = await loadOC();
  dir = mkdtempSync(join(tmpdir(), "cocaide-engine-"));
  for (const [key, d] of Object.entries(parts)) writeFileSync(join(dir, `${key}.cocaide.json`), JSON.stringify(d));
}, 120_000);

/** A round face's axis direction on its part as built (to say whether two holes' axes run the same way). */
function axisOf(doc: unknown, sel: ReturnType<typeof round>): number[] {
  const b = rebuild(doc, oc);
  try {
    const topo = topologyOf(oc, b.solid!, b.bodies);
    const m = selectFaces(topo.faces, sel as never).matches;
    if (m.length !== 1 || !m[0].cylinder) throw new Error(`round face ${JSON.stringify(sel)}: ${m.length} matches`);
    return m[0].cylinder.axis;
  } finally {
    b.dispose();
  }
}
/** Aligned or opposed, as two round faces' axes run with the parts where they are drawn (both at their origins, or turned). */
function way(da: unknown, sa: ReturnType<typeof round>, db: unknown, sb: ReturnType<typeof round>, turnB = false): { aligned: true } | { opposed: true } {
  const u = axisOf(da, sa);
  const v = axisOf(db, sb).map((x, i) => (turnB && i > 0 ? -x : x));
  return u[0] * v[0] + u[1] * v[1] + u[2] * v[2] > 0 ? { aligned: true } : { opposed: true };
}
export const WAYS: string[] = [];

/** Builds the engine; returns the session and a caller. */
export async function buildEngine(outDir: string) {
  const s = await AgentSession.open({ doc: parts.block, docPath: join(outDir, "block.cocaide.json"), outDir });
  const call = async (tool: string, a: Record<string, unknown> = {}) => (await s.call(tool, a)).result as R;
  /** A concentric mate, held the way its two round faces run as drawn (each part key, its face). */
  const concentric = async (ca: string, ka: keyof typeof parts, fa: ReturnType<typeof round>, cb: string, kb: keyof typeof parts, fb: ReturnType<typeof round>, extra: R = {}) => {
    const w = way(parts[ka], fa, parts[kb], fb);
    WAYS.push(Object.keys(w)[0]);
    return mate({ type: "concentric", a: { component: ca, face: fa }, b: { component: cb, face: fb }, ...w, ...extra });
  };
  const mate = async (m: R) => {
    const r = await call("addMate", m);
    if (!r.ok) throw new Error(`${m.type} ${JSON.stringify(m.a)} – ${JSON.stringify(m.b)}: ${JSON.stringify(r)}`);
    return r;
  };
  const ins = (file: string, at: number[], rotation?: number[]) => call("insertComponent", { part: { file: `${file}.cocaide.json` }, at, ...(rotation ? { rotation } : {}) });
  const ref = (component: string, face: unknown) => ({ component, face });
  await call("insertComponent", { part: "self" });

  // The cylinder: on the crankcase (face to face), on its middle plane (default planes, aligned), 57 forward of its front
  // (aligned faces), square to it (parallel sides).
  await ins("cylinder", [20, 30, 40], [0, 0, 8]);
  await mate({ type: "coincident", a: ref("crankcase-1", flat([0, 0, 1], [0, 0, 80])), b: ref("cylinder-1", flat([0, 0, -1], [0, -62, 80])) });
  await mate({ type: "coincident", a: { component: "crankcase-1", datum: "Right" }, b: { component: "cylinder-1", datum: "Right" }, aligned: true });
  await mate({ type: "distance", a: ref("crankcase-1", flat([0, -1, 0], [0, -40, 40])), b: ref("cylinder-1", flat([0, -1, 0], [0, -97, 140])), value: 57, aligned: true });
  await mate({ type: "parallel", a: ref("crankcase-1", flat([1, 0, 0], [60, 0, 40])), b: ref("cylinder-1", flat([1, 0, 0], [35, -62, 140])), aligned: true });

  // The crank: its journal in the bearing (concentric), its web 5 off the crankcase's front, turned by an angle mate
  // (the web's side square to the crankcase's top: 90°, top dead centre).
  await ins("crank", [0, -30, 20]);
  await concentric("crankcase-1", "block", round(10, [0, 0, ENGINE.crankZ]), "crankshaft-1", "crank", round(10, [0, 0, ENGINE.crankZ]));
  await mate({ type: "distance", a: ref("crankcase-1", flat([0, -1, 0], [0, -40, 40])), b: ref("crankshaft-1", flat([0, 1, 0], [0, -45, 50])), value: 5 });
  await mate({ type: "angle", a: ref("crankcase-1", flat([0, 0, 1], [0, 0, 80])), b: ref("crankshaft-1", flat([1, 0, 0], [15, -50, 50])), value: 90 });

  // The head: on the cylinder (face to face), its bolt holes on the cylinder's (two concentrics).
  await ins("head", [10, 0, 60]);
  await mate({ type: "coincident", a: ref("cylinder-1", flat([0, 0, 1], [0, -62, 200])), b: ref("cylinder_head-1", flat([0, 0, -1], [0, -62, 200])) });
  await concentric("cylinder-1", "cylinder", round(4, [27, -89, 140]), "cylinder_head-1", "head", round(4, [27, -89, 207]));
  await concentric("cylinder-1", "cylinder", round(4, [-27, -35, 140]), "cylinder_head-1", "head", round(4, [-27, -35, 207]));

  // Two bolts, each in a head hole, its head on the head's top (face to face); the second goes in upside down and is
  // turned over by its mates.
  await ins("bolt", [27, -89, 260]);
  await ins("bolt", [-27, -35, 260], [180, 0, 0]);
  await concentric("cylinder_head-1", "head", round(4, [27, -89, 207]), "head_bolt-1", "bolt", round(4, [0, 0, -15]));
  await mate({ type: "coincident", a: ref("cylinder_head-1", flat([0, 0, 1], [0, -62, 215])), b: ref("head_bolt-1", flat([0, 0, -1], [5.5, 0, 0])) });
  await concentric("cylinder_head-1", "head", round(4, [-27, -35, 207]), "head_bolt-2", "bolt", round(4, [0, 0, -15]));
  await mate({ type: "coincident", a: ref("cylinder_head-1", flat([0, 0, 1], [0, -62, 215])), b: ref("head_bolt-2", flat([0, 0, -1], [5.5, 0, 0])) });

  // The piston and its wrist pin go in together and are locked as one; the piston in the bore (concentric, its rotation
  // locked); the rod on the crankpin (concentric), 3 off the web, its small end on the wrist pin.
  await ins("piston", [0, 0, 30]);
  await ins("wristPin", [0, 0, 30]);
  await mate({ type: "lock", a: ref("piston-1", round(25, [0, -62, 175])), b: ref("wrist_pin-1", round(6, [0, -62, ENGINE.pinZ])) });
  await concentric("cylinder-1", "cylinder", round(26, [0, -62, 140]), "piston-1", "piston", round(25, [0, -62, 175]), { lockRotation: true });
  await ins("rod", [0, 20, 10]);
  await concentric("crankshaft-1", "crank", round(10, [0, -63, ENGINE.crankZ + ENGINE.throw]), "con_rod-1", "rod", round(10, [0, -62, ENGINE.crankZ + ENGINE.throw]));
  await mate({ type: "distance", a: ref("crankshaft-1", flat([0, -1, 0], [0, -55, 50])), b: ref("con_rod-1", flat([0, 1, 0], [0, -58, 120])), value: 3 });
  await concentric("wrist_pin-1", "wristPin", round(6, [0, -62, ENGINE.pinZ]), "con_rod-1", "rod", round(6, [0, -62, ENGINE.pinZ]));
  // Its stroke: the piston's top 0–60 below the cylinder's (a limit; flipped: below, not above).
  await mate({ type: "distance", a: ref("cylinder-1", flat([0, 0, 1], [0, -62, 200])), b: ref("piston-1", flat([0, 0, 1], [0, -62, 195])), value: 5, aligned: true, flip: true, min: 0, max: 60 });

  // The manifold: its flange on the cylinder's side (face to face), 30 below the top and 10 back from the front (both
  // flipped), its front square to the cylinder's top (perpendicular).
  await ins("manifold", [80, 10, -20]);
  await mate({ type: "coincident", a: ref("cylinder-1", flat([1, 0, 0], [35, -62, 140])), b: ref("intake_manifold-1", flat([-1, 0, 0], [35, -62, 160])) });
  await mate({ type: "distance", a: ref("cylinder-1", flat([0, 0, 1], [0, -62, 200])), b: ref("intake_manifold-1", flat([0, 0, 1], [40, -62, 170])), value: 30, aligned: true, flip: true });
  await mate({ type: "distance", a: ref("cylinder-1", flat([0, -1, 0], [0, -97, 140])), b: ref("intake_manifold-1", flat([0, -1, 0], [40, -87, 145])), value: 10, aligned: true, flip: true });
  await mate({ type: "perpendicular", a: ref("cylinder-1", flat([0, 0, 1], [0, -62, 200])), b: ref("intake_manifold-1", flat([0, -1, 0], [40, -87, 145])) });

  // The stand: on the floor with the crankcase (bottoms aligned), 20 off its side (face to face), 40 forward of its
  // front (aligned), and the manifold's pipe resting on its top (tangent).
  await ins("stand", [0, -20, 30]);
  await mate({ type: "coincident", a: ref("crankcase-1", flat([0, 0, -1], [0, 0, 0])), b: ref("pipe_stand-1", flat([0, 0, -1], [90, -62, 0])), aligned: true });
  await mate({ type: "distance", a: ref("crankcase-1", flat([1, 0, 0], [60, 0, 40])), b: ref("pipe_stand-1", flat([-1, 0, 0], [80, -62, 65])), value: 20 });
  await mate({ type: "distance", a: ref("crankcase-1", flat([0, -1, 0], [0, -40, 40])), b: ref("pipe_stand-1", flat([0, -1, 0], [90, -80, 65])), value: 40, aligned: true });
  await mate({ type: "tangent", a: ref("pipe_stand-1", flat([0, 0, 1], [90, -62, 130])), b: ref("intake_manifold-1", round(15, [75, -62, 145])) });
  return { s, call };
}

describe("a single-cylinder engine and its intake manifold, assembled with every kind of mate", () => {
  it("brings every part home: each at its own origin (the bolts in their holes), every mate holding", async () => {
    // The parts build, and each round face the mates name is found once.
    for (const [key, d] of Object.entries(parts)) {
      const b = rebuild(d, oc);
      expect(b.errors, key).toEqual([]);
      b.dispose();
    }
    const { call } = await buildEngine(dir);
    const asm = await call("assembly");
    const at = (id: string) => (asm.components as R[]).find((k) => k.id === id)!;
    const near = (a: number[], b: number[], tol = 0.01) => a.every((v, i) => Math.abs(v - b[i]) < tol);
    for (const id of ["cylinder-1", "crankshaft-1", "cylinder_head-1", "piston-1", "wrist_pin-1", "con_rod-1", "intake_manifold-1", "pipe_stand-1"]) {
      const k = at(id);
      expect(near(k.at ?? [0, 0, 0], [0, 0, 0]), `${id} at ${JSON.stringify(k.at)}`).toBe(true);
      // Square (a turn of a full 360° about any axis reads as no turn).
      expect((k.rotation ?? [0, 0, 0]).every((v: number) => Math.abs(Math.sin((v * Math.PI) / 360)) < 1e-3 || Math.abs(Math.abs(v) - 360) < 0.01), `${id} turned ${JSON.stringify(k.rotation)}`).toBe(true);
    }
    expect(near(at("head_bolt-1").at, [27, -89, 215])).toBe(true);
    expect(near(at("head_bolt-2").at, [-27, -35, 215])).toBe(true);
    const check = await call("checkAssembly");
    expect(check.mates.every((m: R) => m.holds), JSON.stringify(check.mates.filter((m: R) => !m.holds))).toBe(true);
    // Every kind of mate is in it.
    const types = new Set(((await call("assembly")).mates as R[]).map((m) => m.type));
    expect([...types].sort()).toEqual(["angle", "coincident", "concentric", "distance", "lock", "parallel", "perpendicular", "tangent"]);
    // Concentric both ways round: held aligned and opposed (the wrist pin is drawn the other way round from the rod's eye).
    expect(new Set(WAYS)).toEqual(new Set(["aligned", "opposed"]));
  }, 600_000);

  it("turns the crank by its angle mate and the piston follows as the slider-crank says", async () => {
    const { call } = await buildEngine(dir);
    const angle = ((await call("assembly")).mates as R[]).find((m) => m.type === "angle")!;
    for (const deg of [60, 30]) {
      // The web's side at `deg` to the top: the crank turned 90 − deg from top dead centre.
      expect(await call("editMate", { id: angle.id, patch: { value: deg } })).toMatchObject({ ok: true });
      const asm = await call("assembly");
      const piston = (asm.components as R[]).find((k) => k.id === "piston-1")!;
      const t = ((90 - deg) * Math.PI) / 180;
      const pin = ENGINE.crankZ + ENGINE.throw * Math.cos(t) + Math.sqrt(ENGINE.rod ** 2 - (ENGINE.throw * Math.sin(t)) ** 2);
      expect(piston.at[2]).toBeCloseTo(pin - ENGINE.pinZ, 2);
      // On its axis still (the bore's), and not turned in it.
      expect(Math.abs(piston.at[0])).toBeLessThan(0.01);
      expect(Math.abs(piston.at[1])).toBeLessThan(0.01);
    }
  }, 600_000);
});

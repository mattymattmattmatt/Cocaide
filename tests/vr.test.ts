// The VR walkthrough: its start point in the document, and where the rig puts the model so you stand there.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { apply } from "../src/doc/commands";
import { vrProblems, vrStartOf } from "../src/doc/vr";
import { allErrors, validateDocument } from "../src/doc/validate";
import { defaultStart, rigFor, toXr } from "../src/ui/vr/xrWalk";

const base = { version: 1, units: "mm", name: "p", features: [] };

describe("the start point in the file", () => {
  it("is checked, set and cleared by setVr", () => {
    expect(vrProblems({ start: { at: [1, 2, 3], heading: 90 } })).toEqual([]);
    expect(vrProblems({ start: { at: [1, 2], heading: "north" }, extra: 1 }).map(([p]) => p)).toEqual(["vr", "vr.start.at", "vr.start.heading"]);
    expect(allErrors(validateDocument({ ...base, vr: { start: { at: [0, 0, 0], heading: 0 } } }))).toEqual([]);
    expect(allErrors(validateDocument({ ...base, vr: { start: { at: [0, 0] } } })).join("\n")).toMatch(/vr\.start\.at/);
    const set = apply(base as never, { type: "setVr", vr: { start: { at: [5000, 2000, 0], heading: 45 } } });
    expect(set.ok && vrStartOf(set.doc)).toEqual({ at: [5000, 2000, 0], heading: 45 });
    const cleared = set.ok ? apply(set.doc, { type: "setVr", vr: null }) : set;
    expect(cleared.ok && "vr" in cleared.doc).toBe(false);
    expect(apply(base as never, { type: "setVr", vr: { start: { at: [1], heading: 0 } } } as never).ok).toBe(false);
  });
});

describe("standing at the start", () => {
  /** A model point (mm, Z up) where the rig puts it in VR (m, Y up; you at the origin facing -Z). */
  const world = (start: { at: [number, number, number]; heading: number }, p: [number, number, number]) => {
    const { rotY, position } = rigFor(start);
    return toXr(p).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY).add(position);
  };
  const close = (v: THREE.Vector3, e: [number, number, number]) => v.toArray().forEach((x, i) => expect(x).toBeCloseTo(e[i], 9));
  it("the start under your feet, the heading straight ahead, up up", () => {
    const s = { at: [2000, 3000, 450] as [number, number, number], heading: 90 };
    close(world(s, s.at), [0, 0, 0]);
    close(world(s, [2000, 4000, 450]), [0, 0, -1]); // a metre north, facing north: a metre ahead
    close(world(s, [3000, 3000, 450]), [1, 0, 0]); // a metre east: on your right
    close(world(s, [2000, 3000, 2450]), [0, 2, 0]); // 2 m above the floor: 2 m up
    const e = { at: [0, 0, 0] as [number, number, number], heading: 0 };
    close(world(e, [1000, 0, 0]), [0, 0, -1]); // facing east
    close(world({ at: [0, 0, 0], heading: 225 }, [-1000, -1000, 0]), [0, 0, -Math.SQRT2]);
  });
  it("with no start: 3 m in front of the model, on its lowest level, facing it", () => {
    expect(defaultStart(new THREE.Box3(new THREE.Vector3(0, 0, -100), new THREE.Vector3(12000, 10000, 6000)))).toEqual({ at: [6000, -3000, -100], heading: 90 });
  });
});

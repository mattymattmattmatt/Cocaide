// Export bodies as STEP: only the bodies chosen, and re-placed so the frame
// asked for becomes the file's axes (a new origin; which way is up and which
// way the front faces; Z up or Y up). Checked by reading the file back.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import type { Vec3 } from "../src/doc/types";
import { boxPoints, exportFrame, isIdentity, toFile, type ExportFrame } from "../src/geom/exportFrame";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { boundingBoxOf } from "../src/kernel/measure";
import { scoped } from "../src/kernel/oc";
import { importSTEP } from "../src/kernel/step";
import { exportPartSTEP, frameProblem } from "../src/kernel/stepPart";

const stand: RawDocument = JSON.parse(readFileSync(new URL("../examples/stand.cocaide.json", import.meta.url), "utf8"));
const close = (a: readonly number[], b: readonly number[], digits = 4) => a.forEach((x, i) => expect(x, `[${i}] of [${a.join(", ")}]`).toBeCloseTo(b[i], digits));

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

/** The file's solids' box, read back. */
function fileBox(text: string): { min: Vec3; max: Vec3 } {
  return scoped((s) => boundingBoxOf(oc, s, s.track(importSTEP(oc, text)))!);
}

describe("the frame from origin, up and front", () => {
  it("up +Z, front −Y, Z-up, at the origin: changes nothing", () => {
    const f = exportFrame([0, 0, 0], [0, 0, 1], [0, -1, 0], "zUp") as ExportFrame;
    expect(isIdentity(f)).toBe(true);
  });

  it("up +Y (a part modelled lying down) and front +Z, Z-up: model +Y becomes +Z, model +Z faces the front (−Y)", () => {
    const f = exportFrame([0, 0, 0], [0, 1, 0], [0, 0, 1], "zUp") as ExportFrame;
    close(toFile(f, [0, 10, 0]), [0, 0, 10]);
    close(toFile(f, [0, 0, 10]), [0, -10, 0]);
    expect(frameProblem(f)).toBeNull();
  });

  it("Y-up: model +Z becomes +Y, the front (−Y) faces +Z", () => {
    const f = exportFrame([0, 0, 0], [0, 0, 1], [0, -1, 0], "yUp") as ExportFrame;
    close(toFile(f, [0, 0, 10]), [0, 10, 0]);
    close(toFile(f, [0, -10, 0]), [0, 0, 10]);
    expect(frameProblem(f)).toBeNull();
  });

  it("refuses a front along up, and finds the box's centre and bottom middle", () => {
    expect(exportFrame([0, 0, 0], [0, 0, 1], [0, 0, -1])).toMatch(/Front must not run along Up/);
    const p = boxPoints({ min: [0, 0, 0], max: [10, 20, 30] }, [0, 0, 1]);
    close(p.centre, [5, 10, 15]);
    close(p.bottom, [5, 10, 0]);
    close(boxPoints({ min: [0, 0, 0], max: [10, 20, 30] }, [0, -1, 0]).bottom, [5, 20, 15]);
  });
});

describe("exporting the stand's bodies", () => {
  it("one body, as modelled; then on its own bottom middle; then turned so model +X is up", () => {
    const built = rebuild(stand, oc);
    try {
      expect(built.errors).toEqual([]);
      const names = built.bodies.map((b) => b.name);
      expect(names.length).toBeGreaterThan(1);
      const body = names[1];
      const own = built.measurements!.bodies.find((b) => b.name === body)!.boundingBox!;
      // Only that body, where it is.
      const plain = exportPartSTEP(oc, built, stand, { bodies: [body] });
      const a = fileBox(plain);
      close(a.min, own.min, 2);
      close(a.max, own.max, 2);
      // Its bottom middle on the origin: x and y centred on 0, z from 0.
      const bottom = boxPoints(own, [0, 0, 1]).bottom;
      const moved = fileBox(exportPartSTEP(oc, built, stand, { bodies: [body], frame: exportFrame(bottom, [0, 0, 1], [0, -1, 0]) as ExportFrame }));
      const size = [0, 1, 2].map((i) => own.max[i] - own.min[i]);
      close(moved.min, [-size[0] / 2, -size[1] / 2, 0], 2);
      close(moved.max, [size[0] / 2, size[1] / 2, size[2]], 2);
      // Model +X up: the file's height is the body's length in X.
      const turned = fileBox(exportPartSTEP(oc, built, stand, { bodies: [body], frame: exportFrame([0, 0, 0], [1, 0, 0], [0, -1, 0]) as ExportFrame }));
      expect(turned.max[2] - turned.min[2]).toBeCloseTo(size[0], 2);
      // Two bodies: a file of both (each its own product).
      const both = exportPartSTEP(oc, built, stand, { bodies: names.slice(0, 2), name: "two" });
      for (const n of names.slice(0, 2)) expect(both).toContain(`'${n}'`);
      expect(() => exportPartSTEP(oc, built, stand, { bodies: ["nope"] })).toThrow(/no body "nope"/);
    } finally {
      built.dispose();
    }
  }, 120_000);
});

describe("the Export body feature", () => {
  const withExport = (f: Record<string, unknown>): RawDocument => ({ ...stand, features: [...stand.features, { id: "export_1", op: "exportBody", ...f }] });

  it("works out the file's frame on the part: by default the model's axes", () => {
    const r = rebuild(withExport({}), oc);
    try {
      expect(r.errors).toEqual([]);
      const d = r.datums.export_1;
      expect(d?.kind).toBe("frame");
      if (d?.kind === "frame") expect(isIdentity({ origin: d.origin, x: d.x, y: d.y, z: d.z })).toBe(true);
    } finally {
      r.dispose();
    }
  }, 60_000);

  it("one body's bottom middle, model +X up (an axis), front from the Front plane: the frame the export uses", () => {
    const r = rebuild(withExport({ bodies: ["upright"], origin: "bottom", up: { datum: "X" } }), oc);
    try {
      expect(r.errors).toEqual([]);
      const d = r.datums.export_1;
      if (d?.kind !== "frame") throw new Error("no frame");
      close(d.z, [1, 0, 0], 6);
      close(d.y, [0, 1, 0], 6);
      const box = r.measurements!.bodies.find((b) => b.name === "upright")!.boundingBox!;
      close(d.origin, boxPoints(box, [1, 0, 0]).bottom, 4);
      // The file written with it: the upright's X length is its height.
      const text = exportPartSTEP(oc, r, withExport({}), { bodies: ["upright"], frame: { origin: d.origin, x: d.x, y: d.y, z: d.z } });
      const b = fileBox(text);
      expect(b.max[2] - b.min[2]).toBeCloseTo(box.max[0] - box.min[0], 2);
      expect(b.min[2]).toBeCloseTo(0, 3);
    } finally {
      r.dispose();
    }
  }, 60_000);

  it("says what is wrong: a body it doesn't have, a front along up, a point without origin \"point\"", () => {
    const err = (f: Record<string, unknown>) => {
      const r = rebuild(withExport(f), oc);
      try {
        return r.errors.join(" ");
      } finally {
        r.dispose();
      }
    };
    expect(err({ bodies: ["nope"] })).toMatch(/no body "nope"|nope/);
    expect(err({ up: { datum: "Y" }, front: { datum: "Front" } })).toMatch(/Front must not run along Up/);
    expect(err({ point: { datum: "Origin" } })).toMatch(/only origin "point" uses it/);
  }, 60_000);
});

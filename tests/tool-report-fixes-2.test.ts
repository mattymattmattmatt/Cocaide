// More fixes from a tool-issue report (a vice and a planetary gearbox built by the AI):
// - a sketch added with numbers a hair off its constraints is solved onto them, not refused
// - an extrude takes "operation" as revolve and sweep do ("new", "intersect"; "remove" says use cut)
// - a bare [x, y, z] where a reference goes is that point
// - a selector with "near" may leave "pick" out
// - the through-all, sweep and combine messages say what to do

import { beforeAll, describe, expect, it } from "vitest";
import { apply, type RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { loadOC, rebuild, type OC } from "../src/kernel";

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
}, 120_000);

const TOP = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };
const empty = (): RawDocument => ({ version: 1, units: "mm", name: "p", features: [] }) as unknown as RawDocument;
const run = (doc: RawDocument) => {
  const r = rebuild(doc, oc);
  try {
    return { errors: r.errors, bodies: r.bodies.map((b) => b.name), datums: r.datums, volume: r.measurements?.volume ?? 0 };
  } finally {
    r.dispose();
  }
};

describe("a sketch a hair off its constraints", () => {
  it("is solved onto them when added (45.106 drawn, 45.105246 asked)", () => {
    const sketch = { id: "s", op: "sketch", plane: TOP, entities: [{ id: "c", type: "circle", center: [0, 0], radius: 22.553 }], constraints: [{ type: "diameter", entity: "c", value: 45.105246 }] };
    const r = apply(empty(), { type: "addFeature", feature: sketch });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const radius = ((r.doc.features[0] as { entities: { radius: number }[] }).entities[0]).radius;
    expect(radius).toBeCloseTo(45.105246 / 2, 6);
    expect(run(r.doc).errors.filter((e) => !/no solid/.test(e))).toEqual([]);
  });
});

describe("extrude operation", () => {
  const doc = (extra: Record<string, unknown>) =>
    ({
      ...empty(),
      features: [
        { id: "s", op: "sketch", plane: TOP, entities: [{ id: "r", type: "rect", center: [0, 0], w: 20, h: 20 }] },
        { id: "base", op: "extrude", sketch: "s", distance: 5 },
        { id: "s2", op: "sketch", plane: TOP, entities: [{ id: "r2", type: "rect", center: [30, 0], w: 10, h: 10 }] },
        { id: "blank", op: "extrude", sketch: "s2", distance: 5, ...extra },
      ],
    }) as unknown as RawDocument;
  it('"new" starts a body named after the feature; "add" is the default; "remove" points to cut', () => {
    expect(run(doc({ operation: "new" })).bodies).toEqual(expect.arrayContaining(["blank"]));
    expect(allErrors(validateDocument(doc({ operation: "add" })))).toEqual([]);
    expect(allErrors(validateDocument(doc({ operation: "remove" }))).join(" ")).toMatch(/use op "cut"/);
  });
});

describe("references and selectors written loosely", () => {
  it("a bare [x, y, z] is a point; near without pick is the nearest", () => {
    const axis = { ...empty(), features: [{ id: "ax", op: "axis", mode: "twoPoints", refs: [[48, 0, 0], [48, 0, 10]] }] } as unknown as RawDocument;
    const real = (list: string[]) => list.filter((e) => !/no solid/.test(e));
    expect(real(allErrors(validateDocument(axis)))).toEqual([]);
    const r = run(axis);
    expect(real(r.errors)).toEqual([]);
    expect(r.datums.ax).toMatchObject({ kind: "axis", origin: [48, 0, 0] });
    const sk = (face: Record<string, unknown>) => ({ ...empty(), features: [{ id: "s", op: "sketch", plane: { type: "ref", ref: { face } }, entities: [] }] });
    expect(allErrors(validateDocument(sk({ type: "planar", normal: [0, 0, 1], near: [0, 0, 5] }))).join(" ")).not.toMatch(/pick/);
    expect(allErrors(validateDocument(sk({ type: "planar", normal: [0, 0, 1] }))).join(" ")).toMatch(/or give "near"/);
  });
});

describe("messages that say what to do", () => {
  it("through all the wrong way says to reverse it", () => {
    const doc = {
      ...empty(),
      features: [
        { id: "s", op: "sketch", plane: TOP, entities: [{ id: "r", type: "rect", center: [0, 0], w: 20, h: 20 }] },
        { id: "base", op: "extrude", sketch: "s", distance: 5 },
        { id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 10] }, entities: [{ id: "c", type: "circle", center: [0, 0], radius: 2 }] },
        { id: "cut", op: "cut", sketch: "s2", extent: "throughAll", direction: [0, 0, 1] },
      ],
    } as unknown as RawDocument;
    expect(run(doc).errors.join(" ")).toMatch(/reverse the direction \(-Z\)/);
  });
});

// Another sketch's entity picked in the 3D view for a feature session's
// reference field (src/ui/model/sketchPick.ts, with wave 2A's
// { sketch, entity, at? } references): hits on screen through a plain
// projection (Top seen from above, 10 px per mm, the origin at 500, 500),
// the reference each kind of field takes, and how the reference reads.

import { describe, expect, it } from "vitest";
import type { SketchEntity, Vec3 } from "../src/doc/types";
import type { Frame } from "../src/geom/frame";
import { sketchEntityAt, sketchRefFor, type PickableSketch, type SketchEntityHit } from "../src/ui/model/sketchPick";
import { pickFieldFor, DEFAULT_EDGE_OPTIONS } from "../src/ui/props/pickFields";
import { describeRef } from "../src/ui/props/datumRef";
import { activeField, summaryOf } from "../src/ui/props/picking";
import { EMPTY_SELECTION } from "../src/ui/model/selection";

const TOP: Frame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const project = (p: Vec3): [number, number] => [500 + p[0] * 10, 500 - p[1] * 10];
const entities: SketchEntity[] = [
  { id: "l1", type: "line", start: [0, 0], end: [20, 0] },
  { id: "c1", type: "circle", center: [0, 20], radius: 5 },
  { id: "a1", type: "arc", center: [40, 0], start: [45, 0], end: [35, 0] },
  { id: "p1", type: "point", at: [-20, -20] },
  { id: "r1", type: "rect", center: [-40, 20], w: 4, h: 4 },
] as SketchEntity[];
const sketches: PickableSketch[] = [{ id: "sketch_1", ok: true, entities, frame: TOP }];
const at = (x: number, y: number) => sketchEntityAt(sketches, project, ...project([x, y, 0]));

describe("another sketch's entity under the pointer", () => {
  it("a line's body, its ends and middle; a circle's outline and centre; an arc; a point", () => {
    expect(at(13, 0.3)).toMatchObject({ sketch: "sketch_1", entity: "l1", type: "line" });
    expect(at(13, 0.3)?.at).toBeUndefined();
    expect(at(0.2, 0.2)).toMatchObject({ entity: "l1", at: "start" });
    expect(at(20, 0)).toMatchObject({ entity: "l1", at: "end" });
    expect(at(10, 0.1)).toMatchObject({ entity: "l1", at: "mid" });
    expect(at(5, 20)).toMatchObject({ entity: "c1" });
    expect(at(5, 20)?.at).toBeUndefined();
    expect(at(0, 20)).toMatchObject({ entity: "c1", at: "center" });
    expect(at(40, 5)).toMatchObject({ entity: "a1" });
    expect(at(-20, -20)).toMatchObject({ entity: "p1", type: "point" });
    // Far from everything, or on an entity that can't be a reference (a rectangle): nothing.
    expect(at(-10, -40)).toBeNull();
    expect(at(-38, 20)).toBeNull();
    // A sketch that failed to build is not picked.
    expect(sketchEntityAt([{ ...sketches[0], ok: false }], project, ...project([13, 0, 0]))).toBeNull();
  });
});

describe("the reference a field takes", () => {
  const hit = (h: Partial<SketchEntityHit>): SketchEntityHit => ({ sketch: "sketch_1", entity: "l1", type: "line", point: [0, 0, 0], px: 0, ...h });
  it("a line is an axis; its end, a point; a circle its axis or its centre; refusals say why", () => {
    expect(sketchRefFor(hit({}), ["axis"])).toEqual({ sketch: "sketch_1", entity: "l1" });
    expect(sketchRefFor(hit({ at: "start" }), ["point"])).toEqual({ sketch: "sketch_1", entity: "l1", at: "start" });
    // An end clicked where an axis is wanted: the line itself.
    expect(sketchRefFor(hit({ at: "end" }), ["axis"])).toEqual({ sketch: "sketch_1", entity: "l1" });
    // A line's body where only a point will do: its middle.
    expect(sketchRefFor(hit({}), ["point"])).toEqual({ sketch: "sketch_1", entity: "l1", at: "mid" });
    expect(sketchRefFor(hit({ entity: "c1", type: "circle" }), ["axis"])).toEqual({ sketch: "sketch_1", entity: "c1" });
    expect(sketchRefFor(hit({ entity: "c1", type: "circle", at: "center" }), ["point"])).toEqual({ sketch: "sketch_1", entity: "c1", at: "center" });
    expect(sketchRefFor(hit({}), ["plane"])).toBe("sketch_1's l1 is an axis, but a plane is needed here");
    expect(sketchRefFor(hit({ entity: "p1", type: "point" }), ["axis"])).toBe("sketch_1's p1 is a point, but an axis is needed here");
  });

  it("a session's reference field takes it (a second click on the same one clears an optional field), and the field says so in its summary", () => {
    let value: unknown;
    const spec = { kind: "datumRef" as const, key: "along", label: "Direction from", accepts: ["axis" as const], optional: true };
    const c = { f: {}, resolved: {}, before: [], bodies: [], doc: { version: 1, units: "mm", name: "p", features: [] }, view: null, selection: EMPTY_SELECTION };
    const env = { view: null, before: [], bodies: [], edge: DEFAULT_EDGE_OPTIONS, chainOf: (e: number) => [e], passes: () => true };
    const field = pickFieldFor(spec, {}, c, 0, env, (v) => void (value = v))!;
    expect(summaryOf(field).sketches).toBe(true);
    expect(field.takeSketch!(hit({}))).toBeNull();
    expect(value).toEqual({ sketch: "sketch_1", entity: "l1" });
    const filled = pickFieldFor(spec, { along: value }, c, 0, env, (v) => void (value = v))!;
    expect(filled.takeSketch!(hit({}))).toBeNull();
    expect(value).toBeNull();
    // A field that makes its reference its own way (up to a face) takes no sketch entity.
    const own = pickFieldFor({ ...spec, pick: () => ({ datum: "Top" }) }, {}, c, 0, env, () => undefined)!;
    expect(own.takeSketch).toBeUndefined();
    expect(activeField([field], undefined)!.key).toBe("along");
  });
});

describe("the feature's own sketch, clicked in the view", () => {
  const hit = (h: Partial<SketchEntityHit>): SketchEntityHit => ({ sketch: "sketch_1", entity: "l1", type: "line", point: [0, 0, 0], px: 0, ...h });
  const before = [
    { id: "sketch_1", op: "sketch", entities },
    { id: "sketch_2", op: "sketch", entities: [{ id: "l7", type: "line", start: [0, 0], end: [0, 9] }] },
  ];
  const c = { f: {}, resolved: {}, before, bodies: [], doc: { version: 1, units: "mm", name: "p", features: [] }, view: null, selection: EMPTY_SELECTION };
  const env = { view: null, before, bodies: [], edge: DEFAULT_EDGE_OPTIONS, chainOf: (e: number) => [e], passes: () => true };

  it("a revolve's axis line: a line of its sketch takes it; another sketch's line or a circle says why not", () => {
    let value: unknown;
    const spec = { kind: "sketchLine" as const, key: "axis.line", label: "Axis line" };
    const f = { sketch: "sketch_1", axis: { line: "l9" } };
    const field = pickFieldFor(spec, f, c, 0, env, (v) => void (value = v))!;
    expect(field.takes).toEqual([]);
    expect(summaryOf(field).sketches).toBe(true);
    expect(field.takeSketch!(hit({}))).toBeNull();
    expect(value).toBe("l1");
    expect(field.takeSketch!(hit({ sketch: "sketch_2", entity: "l7" }))).toMatch(/is a line of sketch_1/);
    expect(field.takeSketch!(hit({ entity: "c1", type: "circle" }))).toMatch(/c1 is not a line/);
  });

  it("a sketch field (an extrude's): a click on one of a sketch's lines picks that sketch", () => {
    let value: unknown;
    const spec = { kind: "sketch" as const, key: "sketch", label: "Sketch" };
    const field = pickFieldFor(spec, { sketch: "sketch_1" }, c, 0, env, (v) => void (value = v))!;
    expect(field.takeSketch!(hit({ sketch: "sketch_2", entity: "l7" }))).toBeNull();
    expect(value).toBe("sketch_2");
    value = undefined;
    expect(field.takeSketch!(hit({}))).toBeNull();
    expect(value).toBeUndefined();
    expect(field.takeSketch!(hit({ sketch: "later" }))).toMatch(/later can't go in sketch here/);
  });
});

describe("how it reads", () => {
  it("names the sketch's entity, and what it is or which point of it", () => {
    const before = [{ id: "sketch_1", op: "sketch", entities }];
    expect(describeRef({ sketch: "sketch_1", entity: "l1" }, before)).toBe("sketch_1's l1 (a line)");
    expect(describeRef({ sketch: "sketch_1", entity: "a1" }, before)).toBe("sketch_1's a1 (an arc)");
    expect(describeRef({ sketch: "sketch_1", entity: "l1", at: "start" }, before)).toBe("the start of sketch_1's l1");
    expect(describeRef({ sketch: "sketch_1", entity: "c1", at: "center" }, before)).toBe("the centre of sketch_1's c1");
    expect(describeRef({ sketch: "gone", entity: "l9" }, before)).toBe("gone's l9");
  });
});

// Annotations that keep hold of their geometry when edge keys change: a
// GeoRef whose key is gone, or now names something elsewhere while the same
// thing is still where it was, is found again from the drawing's refHints;
// refHintsFor records the places and writes re-found refs back.

import { describe, expect, it } from "vitest";
import type { Drawing } from "../src/doc/types";
import { geoInView } from "../src/drafting/georef";
import { refHintsFor, withRefHints } from "../src/drafting/refHints";

const edge = (key: string, a: [number, number], b: [number, number], visible = true) => ({ key, body: "post", type: visible ? "visible" : "hidden", visible, pts: [a, b], look: "line" });
const view = (edges: ReturnType<typeof edge>[]) => ({ id: "front", frame: {}, outline: { min: [0, 0], max: [10, 10] }, edges }) as never;
const drawing = (refHints?: Drawing["refHints"]): Drawing =>
  ({ sheets: [{ id: "s1", views: [], annotations: [{ id: "d1", type: "dimension", view: "front", from: "@left", to: "front:vpost/l1.0" }] }], ...(refHints ? { refHints } : {}) }) as never;

describe("GeoRefs that keep hold of their geometry", () => {
  const before = view([edge("post/l0", [0, 0], [10, 0]), edge("post/l1", [0, 5], [10, 5])]);
  // The faces split differently: the line at y = 5 is now post/l2, and post/l1 is a new piece at y = 0.
  const after = view([edge("post/l0", [0, 0], [4, 0]), edge("post/l1", [4, 0], [10, 0]), edge("post/l2", [0, 5], [10, 5])]);

  it("records where each GeoRef is", () => {
    const r = refHintsFor(drawing(), [{ views: [before] }]);
    expect(r?.hints).toEqual({ "front:vpost/l1.0": { body: "post", p: [0, 5] } });
  });

  it("finds a renumbered one again where it was, and writes its new key back", () => {
    const hints = { "front:vpost/l1.0": { body: "post", p: [0, 5] } };
    // Composed with the hints, it resolves where it was though its key now names another line.
    const p = geoInView(after, { view: "front", form: "v", key: "post/l1", end: 0 }, { nodes: {}, members: [], holes: new Map(), hints });
    expect(p).toMatchObject({ kind: "point", p: [0, 5] });
    const next = withRefHints(drawing(hints) as never, drawing(hints), [{ views: [after] }]) as unknown as Drawing;
    expect((next.sheets[0].annotations![0] as { to: string }).to).toBe("front:vpost/l2.0");
    expect(next.refHints).toEqual({ "front:vpost/l2.0": { body: "post", p: [0, 5] } });
  });

  it("follows the edge when the model really moved it (nothing is left where it was)", () => {
    const moved = view([edge("post/l0", [0, 0], [10, 0]), edge("post/l1", [0, 7], [10, 7])]);
    const hints = { "front:vpost/l1.0": { body: "post", p: [0, 5] } };
    const r = refHintsFor(drawing(hints), [{ views: [moved] }]);
    expect(r?.renamed.size).toBe(0);
    expect(r?.hints).toEqual({ "front:vpost/l1.0": { body: "post", p: [0, 7] } });
  });

  it("prefers the seen line's end over a hidden one's at the same place", () => {
    const hints = { "front:vpost/l1.0": { body: "post", p: [0, 5] } };
    const v = view([edge("post/l0", [0, 0], [10, 0]), edge("post/l1", [0, 5], [3, 9], false), edge("post/l3", [0, 5], [10, 5])]);
    const r = refHintsFor(drawing(hints), [{ views: [v] }]);
    expect(r?.renamed.get("front:vpost/l1.0")).toBe("front:vpost/l3.0");
  });
});

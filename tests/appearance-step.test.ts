// A part's colours go out in its STEP file (XCAF): the part's, a body's, the
// faces a feature colours, and in an assembly each component's own colour
// over its part's. A part with none goes out as before.
import { beforeAll, describe, expect, it } from "vitest";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { scoped } from "../src/kernel/oc";
import { exportPartSTEP } from "../src/kernel/stepPart";
import { assemblySTEP } from "../src/kernel/assembly";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../src/agent/session";

const XY = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };
const plate = (extra: Record<string, unknown> = {}, bore: Record<string, unknown> = {}) => ({
  version: 1,
  units: "mm",
  name: "plate",
  features: [
    { id: "sk", op: "sketch", plane: XY, entities: [{ id: "r", type: "rect", center: [0, 0], w: 100, h: 60 }] },
    { id: "base", op: "extrude", sketch: "sk", distance: 10 },
    { id: "bore", op: "hole", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, center: [0, 0], diameter: 12, depth: "through", ...bore },
  ],
  ...extra,
});
const twoBodies = (extra: Record<string, unknown> = {}) => ({
  ...plate(),
  features: [...plate().features, { id: "sk2", op: "sketch", plane: XY, entities: [{ id: "r", type: "rect", center: [100, 0], w: 30, h: 30 }] }, { id: "lug", op: "extrude", sketch: "sk2", distance: 10, newBody: "lug" }],
  ...extra,
});

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
}, 120_000);

const step = (doc: unknown) => {
  const r = rebuild(doc, oc);
  try {
    return exportPartSTEP(oc, r, doc);
  } finally {
    r.dispose();
  }
};
/** The file's colours, as "#rrggbb" (sRGB, as the writer puts them). */
const colours = (text: string) =>
  [...text.matchAll(/COLOUR_RGB\('[^']*',([\d.Ee+-]+),([\d.Ee+-]+),([\d.Ee+-]+)\)/g)]
    .map((m) => `#${m.slice(1, 4).map((v) => Math.round(Number(v) * 255).toString(16).padStart(2, "0")).join("")}`)
    .sort();

describe("a part's colours in its STEP file", () => {
  it("carries none when it says nothing, and the part's colour when it does", () => {
    expect(colours(step(plate()))).toEqual([]);
    const text = step(plate({ appearance: { color: "#2f6fd6" } }));
    expect(colours(text)).toEqual(["#2f6fd6"]);
    expect(text).toContain("PRODUCT('plate','plate'");
  });

  it("colours the faces a feature makes over the part, and keeps an opacity", () => {
    const text = step(plate({ appearance: { color: "#c4cad3", opacity: 0.6 } }, { appearance: { color: "#d64545" } }));
    expect([...new Set(colours(text))]).toEqual(["#c4cad3", "#d64545"]);
    expect(Number(/SURFACE_STYLE_TRANSPARENT\(([\d.]+)\)/.exec(text)?.[1])).toBeCloseTo(0.4, 5);
  });

  it("colours each body of a part of several", () => {
    const text = step(twoBodies({ bodyAppearances: { lug: { color: "#4f9d5d" } }, material: { name: "steel", densityKgPerM3: 7850, appearance: { color: "#8c939b", finish: "metallic" } } }));
    expect([...new Set(colours(text))]).toEqual(["#4f9d5d", "#8c939b"]);
  });
});

describe("an assembly's colours in its STEP file", () => {
  it("gives each component its own colour, else its part's", () => {
    const part = plate({ appearance: { color: "#8a919c" } });
    const id = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const text = scoped((s) =>
      assemblySTEP(oc, s, "pair", { p: part }, [
        { id: "a", part: "p", R: id, t: [0, 0, 0] },
        { id: "b", part: "p", R: id, t: [0, 0, 50], appearance: { color: "#f2c230" } },
      ]),
    );
    expect([...new Set(colours(text))]).toEqual(["#8a919c", "#f2c230"]);
  });
});

describe("over the agent session (MCP)", () => {
  it("colours a body and a feature's faces, refuses a bad colour, and the STEP file carries them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cocaide-look-"));
    const s = await AgentSession.open({ doc: twoBodies(), docPath: join(dir, "plate.cocaide.json"), outDir: dir });
    const call = async (tool: string, a: Record<string, unknown>) => (await s.call(tool, a)).result as Record<string, any>;
    expect(await call("setAppearance", { body: "lug", appearance: { color: "#4F9D5D", finish: "matte" } })).toMatchObject({ ok: true });
    expect(await call("setAppearance", { feature: "bore", appearance: { color: "#d64545" } })).toMatchObject({ ok: true });
    const bad = await call("setAppearance", { body: "lug", appearance: { color: "green" } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/must be a colour "#rrggbb"/);
    const doc = (s as unknown as { doc: Record<string, any> }).doc;
    expect(doc.bodyAppearances).toEqual({ lug: { color: "#4f9d5d", finish: "matte" } });
    const r = await call("exportSTEP", { file: "plate.step" });
    expect(r.ok).toBe(true);
    expect([...new Set(colours(readFileSync(join(dir, "plate.step"), "utf8")))]).toEqual(["#4f9d5d", "#d64545"]);
  }, 120_000);
});


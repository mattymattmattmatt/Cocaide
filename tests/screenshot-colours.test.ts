// The assistant's screenshot shows the part's colours (as the app does), and a second shot of the same revision reuses
// its mesh.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/session";
import { loadOC } from "../src/kernel";
import { decodePNG } from "../src/render/pngDecode";

beforeAll(async () => {
  await loadOC();
});

const doc = {
  version: 1, units: "mm", name: "two",
  features: [
    { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [0, 0], w: 100, h: 100 }] },
    { id: "red", op: "extrude", sketch: "s1", distance: 20, newBody: "red" },
    { id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r", type: "rect", center: [200, 0], w: 100, h: 100 }] },
    { id: "blue", op: "extrude", sketch: "s2", distance: 20, newBody: "blue" },
  ],
  bodyAppearances: { red: { color: "#d02020" }, blue: { color: "#2040d0" } },
};

describe("screenshot colours", () => {
  it("each body in its colour; the same revision shot again reuses its mesh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shot-"));
    const s = await AgentSession.open({ doc, docPath: join(dir, "two.cocaide.json"), outDir: dir });
    const shot = async () => {
      const r = await s.call("screenshot", { view: "top", width: 400, height: 200 });
      const img = await decodePNG(r.image!);
      let red = 0, blue = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        const [R, G, B] = [img.data[i], img.data[i + 1], img.data[i + 2]];
        if (R > 120 && R > 2 * G && R > 2 * B) red++;
        if (B > 120 && B > 2 * R && B > 1.5 * G) blue++;
      }
      return { red, blue };
    };
    const t0 = performance.now();
    const a = await shot();
    const first = performance.now() - t0;
    expect(a.red).toBeGreaterThan(1000);
    expect(a.blue).toBeGreaterThan(1000);
    const t1 = performance.now();
    expect(await shot()).toEqual(a);
    expect(performance.now() - t1).toBeLessThan(first + 50);
  });
});

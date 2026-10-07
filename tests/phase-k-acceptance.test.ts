// Phase K acceptance against the real model. Runs only with ANTHROPIC_API_KEY
// set (COCAIDE_ASK_MODEL picks the model; default Claude Opus 5.5). The same
// checks run without a key in tests/frame-ask.test.ts (scripted readings) and
// e2e/frame-ask.spec.ts (the browser, with the API answered by a script).

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { LocalKernel } from "../src/ask/kernel";
import { AnthropicModel, anthropicClient, DEFAULT_MODEL } from "../src/ask/model";
import { continuePartAsk, runPartAsk } from "../src/ask/part";
import { suggestProfile } from "../src/ask/profile";
import type { RawDocument } from "../src/doc/commands";
import type { ProfileDef } from "../src/doc/types";
import { getOC, loadOC } from "../src/kernel";
import { toEntry } from "../src/weldment/library";

const key = process.env.ANTHROPIC_API_KEY;
const EMPTY: RawDocument = { version: 1, units: "mm", name: "part", features: [] };
const table = JSON.parse(readFileSync(new URL("../examples/table-frame.cocaide.json", import.meta.url), "utf8")) as RawDocument;
const library = [toEntry((table.profiles as Record<string, ProfileDef>).SHS, undefined, "lib-shs")];

describe.skipIf(!key)("Phase K acceptance (live model)", () => {
  let kernel: LocalKernel;
  const model = () => new AnthropicModel(anthropicClient({ apiKey: key }), process.env.COCAIDE_ASK_MODEL ?? DEFAULT_MODEL, "low");
  beforeAll(async () => {
    await loadOC();
    kernel = new LocalKernel(getOC);
  });

  it("the table frame prompt builds after the card, from the library's profile", async () => {
    const text = "A 1200 × 600 table frame, 900 high, SHS 40×40×3";
    const card = await runPartAsk({ doc: EMPTY, text, model: model(), kernel, library });
    expect(card.outcome, card.text).toBe("questions");
    expect(card.intent?.kind).toBe("frame");
    const rows = Object.fromEntries(card.review!.rows.map((r) => [r.path, r.value]));
    expect(rows).toMatchObject({ "frame.length": 1200, "frame.width": 600, "frame.height": 900, "frame.section": "lib|lib-shs|SHS 40x40x3", "frame.corners": null });
    const r = await continuePartAsk({ doc: EMPTY, text, model: model(), kernel, library }, card, { "frame.corners": "mitre" });
    expect(r.outcome, r.text).toBe("proposal");
    expect(r.critique!.ok, r.critique!.findings.join("\n")).toBe(true);
  }, 180_000);

  it("a section the library doesn't have is asked for, not guessed", async () => {
    const card = await runPartAsk({ doc: EMPTY, text: "A 1000 × 500 table frame, 800 high, in RHS 60x40x3", model: model(), kernel, library });
    const section = card.review!.rows.find((r) => r.path === "frame.section")!;
    expect(section.blank).toBe(true);
    expect(section.note).toContain("is not in the section library");
  }, 180_000);

  it("suggests SHS names for a square hollow section", async () => {
    const s = await suggestProfile(model(), {
      parameters: ["b", "t"],
      drawn: "2 rect",
      sizes: [
        { values: { b: 40, t: 3 }, area: 444, envelope: [40, 40], centroid: [0, 0], ix: 101972, iy: 101972, hollow: true, open: false, round: false },
        { values: { b: 50, t: 3 }, area: 564, envelope: [50, 50], centroid: [0, 0], ix: 203852, iy: 203852, hollow: true, open: false, round: false },
      ],
      origin: "centre",
      taken: [],
      current: { name: "", designations: ["", ""] },
    });
    expect(s.name).toMatch(/SHS/);
    expect(s.designations.map((d) => d.replace(/\s|×/g, (c) => (c === "×" ? "x" : "")))).toEqual(["SHS40x40x3", "SHS50x50x3"]);
    expect(s.anchor).toBe("centroid");
  }, 180_000);
});

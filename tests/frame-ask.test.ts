// Phase K: the agent on weldments. A frame from a sentence through the card,
// its section matched in the library by code; the fabrication critic; member
// and joint right-clicks; the profile card's suggestions. Scripted model, real
// kernel.

import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { applyProposal, runAsk } from "../src/ask/agent";
import { LocalKernel } from "../src/ask/kernel";
import { ScriptedModel, say, use } from "../src/ask/model";
import { buildPacket, featureKind, scopeFor } from "../src/ask/packet";
import { continuePartAsk, runPartAsk, sectionOptions } from "../src/ask/part";
import { suggestProfile, type ProfileFacts } from "../src/ask/profile";
import { scopedActions } from "../src/ask/prompt";
import { apply, type RawDocument } from "../src/doc/commands";
import type { ProfileDef } from "../src/doc/types";
import { planFrame } from "../src/intent/frame";
import { EMPTY_LIBRARY, matchSection, reviewIntent, sectionKey, type SectionOption } from "../src/intent/review";
import { emptyFrame, emptyIntent, stated, type Intent } from "../src/intent/schema";
import { getOC, loadOC, rebuild } from "../src/kernel";
import { cutList } from "../src/weldment/cutlist";
import { fabricationChecks } from "../src/weldment/fabrication";
import { toEntry, type LibraryEntry } from "../src/weldment/library";

const EMPTY: RawDocument = { version: 1, units: "mm", name: "part", features: [] };
const table: RawDocument = JSON.parse(readFileSync(new URL("../examples/table-frame.cocaide.json", import.meta.url), "utf8"));
const SHS = (table.profiles as Record<string, ProfileDef>).SHS;
const library: LibraryEntry[] = [toEntry(SHS, undefined, "lib-shs", new Date("2026-10-01T00:00:00Z"))];
const TEXT = "A 1200 × 600 table frame, 900 high, SHS 40×40×3";

const section = (value: string | null, evidence = value ?? "") => ({ value, evidence, source: value === null ? "missing" : "stated", confidence: value === null ? 0 : 1 }) as Intent["frame"] extends infer F ? (F extends { section: infer S } ? S : never) : never;
const frameIntent = (o: Partial<NonNullable<Intent["frame"]>> = {}): Intent => ({
  ...emptyIntent(),
  kind: "frame",
  name: "table frame",
  frame: {
    ...emptyFrame("table"),
    length: stated(1200, "1200 × 600"),
    width: stated(600, "1200 × 600"),
    height: stated(900, "900 high"),
    section: section("SHS 40×40×3"),
    ...o,
  },
});

let kernel: LocalKernel;
beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
});

describe("a frame from a sentence", () => {
  it("reads the frame, finds SHS 40×40×3 in the library, and always shows the card", async () => {
    const model = new ScriptedModel([], [frameIntent()]);
    const r = await runPartAsk({ doc: EMPTY, text: TEXT, model, kernel, library });
    expect(r.outcome).toBe("questions");
    expect(r.text).toBe("I need one choice before I build this: corners.");
    expect(r.review!.rows.map((x) => [x.path, x.value, x.blank])).toEqual([
      ["frame.length", 1200, false],
      ["frame.width", 600, false],
      ["frame.height", 900, false],
      ["frame.section", "lib|lib-shs|SHS 40x40x3", false],
      ["frame.corners", null, true],
    ]);
    expect(r.review!.rows[3].note).toBe("SHS 40x40x3, from the section library");
    expect(r.review!.rows[3].options).toEqual([
      { value: "lib|lib-shs|SHS 40x40x3", label: "SHS 40x40x3" },
      { value: "lib|lib-shs|SHS 50x50x3", label: "SHS 50x50x3" },
    ]);
    // The model was told a frame's section is never its choice.
    expect(model.intentRequests[0].system).toContain("Never choose a section yourself");
  });

  it("builds after the card, from the library's profile, and the critic's checks pass: the Phase K acceptance", async () => {
    const model = new ScriptedModel([], [frameIntent()]);
    const card = await runPartAsk({ doc: EMPTY, text: TEXT, model, kernel, library });
    const r = await continuePartAsk({ doc: EMPTY, text: TEXT, model, kernel, library }, card, { "frame.corners": "mitre" });
    expect(r.outcome, r.text).toBe("proposal");
    expect(r.text).toBe("A 1200 × 600 × 900 mm table frame of SHS 40x40x3: 8 members, mitred corners. Checked against the request: 8 of 8 checks pass.");
    expect(r.critique!.checks.map((c) => [c.label, c.ok])).toEqual([
      ["Rebuilds without errors", true],
      ["Outside size", true],
      ["Members", true],
      ["Every member connected", true],
      ["No clashes after trimming", true],
      ["No member longer than stock bar", true],
      ["Identical members grouped", true],
      ["Cut list as planned", true],
    ]);
    expect(model.requests).toEqual([]); // the planner built it: no agent turns, no correction
    const accepted = applyProposal(EMPTY, r.proposal!);
    if (!accepted.ok) throw new Error(accepted.error);
    const doc = accepted.doc;
    // The part has its own copy of the library's profile, with the id and version.
    expect((doc.profiles as Record<string, ProfileDef>).SHS.library).toEqual({ id: "lib-shs", version: 1 });
    expect(doc.parameters).toEqual({ frame_w: 1200, frame_d: 600, frame_h: 900 });
    expect(doc.features.filter((f) => f.op === "joint").map((f) => f.node)).toEqual(["B", "C", "D", "A"]);
    const b = rebuild(doc, getOC());
    expect(b.errors).toEqual([]);
    expect(cutList(b.measurements!.members).map((i) => [i.length, i.angles, i.quantity])).toEqual([
      [1200, [45, 45], 2],
      [860, [0, 0], 4],
      [600, [45, 45], 2],
    ]);
    b.dispose();
  });

  it("builds butt corners with the legs through, and a flat rectangle on the floor", async () => {
    const butt = new ScriptedModel([], [frameIntent({ corners: "butt" })]);
    const text = `${TEXT}, butt welded corners`;
    const card = await runPartAsk({ doc: EMPTY, text, model: butt, kernel, library });
    expect(card.review!.rows.find((x) => x.path === "frame.corners")!.value).toBe("butt");
    const r = await continuePartAsk({ doc: EMPTY, text, model: butt, kernel, library }, card, {});
    expect(r.outcome, r.text).toBe("proposal");
    expect(r.critique!.ok).toBe(true);
    expect(r.critique!.checks.at(-1)!.expected).toBe("2 × SHS 40x40x3 1120 (0°/0°), 4 × SHS 40x40x3 900 (0°/0°), 2 × SHS 40x40x3 520 (0°/0°)");

    const flat = new ScriptedModel([], [frameIntent({ type: "rectangle", height: { value: null, evidence: "", source: "missing", confidence: 0 }, corners: "mitre" })]);
    const ftext = "a 1200 x 600 mitred frame in SHS 40x40x3";
    const fcard = await runPartAsk({ doc: EMPTY, text: ftext, model: flat, kernel, library });
    expect(fcard.review!.rows.map((x) => x.path)).toEqual(["frame.length", "frame.width", "frame.section", "frame.corners"]);
    const f = await continuePartAsk({ doc: EMPTY, text: ftext, model: flat, kernel, library }, fcard, {});
    expect(f.outcome, f.text).toBe("proposal");
    expect(f.text).toBe("A 1200 × 600 × 40 mm frame of SHS 40x40x3: 4 members, mitred corners. Checked against the request: 8 of 8 checks pass.");
  });

  it("never guesses a section: missing, not in the request, not in the library, or two to choose from, it asks", () => {
    const sections = sectionOptions(EMPTY, library);
    const row = (intent: Intent, text: string, s: SectionOption[] = sections) => reviewIntent(intent, { text, sections: s }).rows.find((x) => x.path === "frame.section")!;
    expect(row(frameIntent({ section: section(null) }), "A 1200 × 600 table frame, 900 high")).toMatchObject({ blank: true, note: "the request does not name a section" });
    // The model named one the user didn't.
    expect(row(frameIntent({ section: section("SHS 50x50x3") }), "A 1200 × 600 table frame, 900 high, in SHS")).toMatchObject({ blank: true, note: 'a guess: the request does not say "SHS 50x50x3"' });
    expect(row(frameIntent({ section: section("SHS 60x60x4") }), "1200 × 600 table, 900 high, SHS 60x60x4")).toMatchObject({
      blank: true,
      note: '"SHS 60x60x4" is not in the section library: choose one, or add it there first',
    });
    // Two families with the same numbers: the user picks.
    const box = toEntry({ ...SHS, name: "BOX", sizes: [{ designation: "BOX 40x40x3", values: { b: 40, t: 3 } }] }, undefined, "lib-box");
    const both = sectionOptions(EMPTY, [...library, box]);
    expect(row(frameIntent({ section: section("40x40x3") }), "a 1200 × 600 table, 900 high, 40x40x3", both)).toMatchObject({
      blank: true,
      note: '"40x40x3" could be SHS 40x40x3 or BOX 40x40x3: choose one',
    });
    // Picked in the card, it is used.
    const picked = reviewIntent(frameIntent({ section: { value: "lib-box", evidence: "", source: "stated", confidence: 1 } }), { text: "x", sections: both });
    expect(picked.rows.find((x) => x.path === "frame.section")!.blank).toBe(true);
    // An empty library stops the request: nothing in the card can fix it.
    const none = reviewIntent(frameIntent(), { text: TEXT, sections: [] });
    expect(none.problems).toEqual([EMPTY_LIBRARY]);
    expect(none.ready).toBe(false);
  });

  it("matches the user's words to library sizes, whatever the spacing and multiplication sign", () => {
    expect(sectionKey("SHS 40 × 40 × 3")).toBe("shs40x40x3");
    expect(sectionKey("SHS 40 by 40 by 3")).toBe("shs40x40x3");
    const options = sectionOptions(EMPTY, library);
    expect(matchSection("shs 50*50*3", options).map((o) => o.designation)).toEqual(["SHS 50x50x3"]);
    expect(matchSection("50x50x3 SHS", options).map((o) => o.designation)).toEqual(["SHS 50x50x3"]);
    expect(matchSection("SHS 40x40", options)).toEqual([]);
    // A part's own copy that isn't from the library is offered too.
    const own = { ...EMPTY, profiles: { FB: { ...SHS, name: "FB", library: undefined } } };
    expect(sectionOptions(own, []).map((o) => [o.value, o.from])).toEqual([
      ["part|FB|SHS 40x40x3", "part"],
      ["part|FB|SHS 50x50x3", "part"],
    ]);
  });

  it("refuses a frame its section doesn't fit, and corners nobody stated", () => {
    const plan = (o: Partial<NonNullable<Intent["frame"]>>) => planFrame(frameIntent({ corners: "mitre", ...o }), { def: SHS, designation: "SHS 40x40x3" });
    expect(plan({ height: stated(30, "30") })).toEqual({ ok: false, error: "a 30 mm high table can't stand under 40 mm deep rails" });
    expect(plan({ length: stated(70, "70") })).toEqual({ ok: false, error: "70 × 600 mm is too small for SHS 40x40x3" });
    expect(planFrame(frameIntent(), { def: SHS, designation: "SHS 40x40x3" })).toEqual({ ok: false, error: "say how the corners are joined" });
    const said = reviewIntent(frameIntent({ corners: "mitre" }), { text: TEXT, sections: sectionOptions(EMPTY, library) });
    expect(said.rows.find((x) => x.path === "frame.corners")).toMatchObject({ blank: true, note: "a guess: the request does not say mitre" });
  });
});

describe("the fabrication critic", () => {
  const checks = (doc: RawDocument) => {
    const b = rebuild(doc, getOC());
    try {
      return Object.fromEntries(fabricationChecks(doc, b.measurements).map((c) => [c.label, c.ok ? true : c.actual]));
    } finally {
      b.dispose();
    }
  };

  it("passes the table frame", () => {
    expect(checks(table)).toEqual({
      "Every member connected": true,
      "No clashes after trimming": true,
      "No member longer than stock bar": true,
      "Identical members grouped": true,
    });
    expect(fabricationChecks(EMPTY, null)).toEqual([]); // a part without members has nothing to check
  });

  it("finds a loose member, a clash, a member over stock, and alike members cut differently", () => {
    const loose = structuredClone(table);
    loose.features.push({ id: "stray", op: "member", profile: "SHS", size: "SHS 40x40x3", from: [0, 2000, 0], to: [500, 2000, 0] });
    expect(checks(loose)["Every member connected"]).toBe("2 separate groups: rail_front, rail_right, rail_back, rail_left, leg_a, leg_b, leg_c, leg_d | stray");

    const clash = { ...structuredClone(table), features: table.features.filter((f) => f.id !== "corner_a") };
    expect(checks(clash)["No clashes after trimming"]).toBe("rail_front and rail_left overlap by 10824 mm³; rail_front and leg_a overlap by 10824 mm³; rail_left and leg_a overlap by 10824 mm³");

    const short = structuredClone(table);
    (short.parameters as Record<string, number>).stock_length = 1000;
    expect(checks(short)["No member longer than stock bar"]).toBe("rail_front is 1200 mm; rail_back is 1200 mm");

    // One leg's foot 0.2 mm high: the same leg cut twice.
    const off = structuredClone(table);
    (off.nodes as Record<string, unknown[]>).E = [0, 0, 0.2];
    expect(checks(off)["Identical members grouped"]).toBe("cut differently: leg_b, leg_c, leg_d at 860 and leg_a at 859.8");
  });

  it("is in the part packet of any weldment, for the agent's answer to 'check it'", async () => {
    const p = await buildPacket(table, { kind: "part" }, kernel);
    expect((p.fabrication as { label: string; ok: boolean }[]).map((c) => [c.label, c.ok])).toEqual([
      ["Every member connected", true],
      ["No clashes after trimming", true],
      ["No member longer than stock bar", true],
      ["Identical members grouped", true],
    ]);
  });
});

describe("right-clicking a member or a joint", () => {
  /** The table frame with corner A butted, the left rail running through. */
  const butted = (): RawDocument => {
    const r = apply(table, { type: "replaceFeature", id: "corner_a", feature: { id: "corner_a", op: "joint", node: "A", type: "butt", through: "leg_a" } });
    if (!r.ok) throw new Error(r.error);
    return r.doc;
  };

  it("gives a joint its node, the members there and their cuts, and actions to mitre or butt it", async () => {
    expect(featureKind("joint")).toBe("joint");
    expect(scopedActions("joint").map((a) => a.label)).toEqual(["Mitre it", "Butt it", "Leave a gap", "Explain it"]);
    expect(scopeFor(table, { kind: "feature", id: "corner_a" })).toEqual(["corner_a"]);
    const p = await buildPacket(butted(), { kind: "feature", id: "corner_a" }, kernel);
    expect(p.target).toMatchObject({ kind: "joint", id: "corner_a" });
    expect(p.joint).toEqual({
      node: "A",
      at: [0, 0, 900],
      members: [
        { id: "rail_front", size: "SHS 40x40x3", endsHere: true, cutHere: "0° from square" },
        { id: "rail_left", size: "SHS 40x40x3", endsHere: true, cutHere: "0° from square" },
        { id: "leg_a", size: "SHS 40x40x3", endsHere: true, cutHere: "0° from square" },
      ],
    });
  });

  it('"Mitre it" on a butt joint proposes the mitre, and accepted, the rails are cut at 45°', async () => {
    const doc = butted();
    const model = new ScriptedModel([
      () => [use("updateFeature", { id: "corner_a", patch: { type: "mitre", through: null, members: ["rail_left", "rail_front"] } })],
      () => [say("Corner A is now a mitre between rail_left and rail_front; leg_a stops under them.")],
    ]);
    const r = await runAsk({ doc, target: { kind: "feature", id: "corner_a" }, text: "Make this joint a mitre.", model, kernel });
    expect(r.outcome, r.text).toBe("proposal");
    const accepted = applyProposal(doc, r.proposal!);
    if (!accepted.ok) throw new Error(accepted.error);
    const b = rebuild(accepted.doc, getOC());
    expect(b.errors).toEqual([]);
    expect(b.measurements!.members.find((m) => m.id === "rail_front")!.angles).toEqual([45, 45]);
    expect(b.measurements!.members.find((m) => m.id === "leg_a")!.length).toBe(860);
    b.dispose();
    // The agent was told the joint, and nothing it may not change.
    const text = (model.requests[0].messages[0].content as Anthropic.ContentBlockParam[]).find((c) => c.type === "text") as Anthropic.TextBlockParam;
    expect(text.text).toContain('"kind": "joint"');
    expect(text.text).toMatch(/"writeScope": \[\s*"corner_a"\s*\]/);
  });

  it("gives a member the sizes its profile has, and refuses an edit to another member", async () => {
    expect(scopedActions("member").map((a) => a.label)).toEqual(["Swap its size", "Turn it 90°", "What is its cut?"]);
    const p = await buildPacket(table, { kind: "feature", id: "leg_a" }, kernel);
    expect(p.member).toMatchObject({
      size: "SHS 40x40x3",
      sizes: ["SHS 40x40x3", "SHS 50x50x3"],
      from: { node: "E", at: [0, 0, 0], joint: null },
      to: { node: "A", at: [0, 0, 900], joint: "corner_a" },
      measured: { length: 860, angles: [0, 0] },
    });
    const model = new ScriptedModel([
      () => [use("updateFeature", { id: "leg_b", patch: { size: "SHS 50x50x3" } })],
      () => [use("updateFeature", { id: "leg_a", patch: { size: "SHS 50x50x3" } })],
      () => [say("leg_a is SHS 50x50x3 now.")],
    ]);
    const r = await runAsk({ doc: table, target: { kind: "feature", id: "leg_a" }, text: "Change this member to SHS 50x50x3", model, kernel });
    expect(r.outcome).toBe("proposal");
    expect(r.calls.map((c) => [c.tool, c.ok])).toEqual([
      ["updateFeature", false],
      ["updateFeature", true],
    ]);
    expect(r.calls[0].error).toContain("outside the scope [leg_a]");
    expect(r.proposal!.doc.features.find((f) => f.id === "leg_a")!.size).toBe("SHS 50x50x3");
  });
});

describe("the profile card's suggestions", () => {
  const facts: ProfileFacts = {
    parameters: ["b", "t"],
    drawn: "2 rect",
    sizes: [
      { values: { b: 40, t: 3 }, area: 444, envelope: [40, 40], centroid: [0, 0], ix: 101972, iy: 101972, hollow: true, open: false, round: false },
      { values: { b: 50, t: 3 }, area: 564, envelope: [50, 50], centroid: [0, 0], ix: 203852, iy: 203852, hollow: true, open: false, round: false },
    ],
    origin: "centre",
    taken: ["RHS"],
    current: { name: "", designations: ["", ""] },
  };

  it("suggests a name, a designation per size, tags and the anchor, from the measured facts only", async () => {
    const model = new ScriptedModel([], [{ name: " SHS ", designations: ["SHS 40x40x3", "SHS 50x50x3"], tags: ["Hollow", "square", "hollow", " steel "], anchor: "centroid", why: "A square tube, symmetric." }]);
    const s = await suggestProfile(model, facts);
    expect(s).toEqual({ name: "SHS", designations: ["SHS 40x40x3", "SHS 50x50x3"], tags: ["hollow", "square", "steel"], anchor: "centroid", why: "A square tube, symmetric." });
    const req = model.intentRequests[0];
    expect(req.schema).toBe("profile");
    const text = (req.content[0] as Anthropic.TextBlockParam).text;
    expect(text).toContain("Size 2: b = 50, t = 3; envelope 50 × 50 mm; area 564 mm²");
    expect(text).toContain("Names already in the library: RHS.");
  });

  it("drops designations that don't line up with the sizes, and a reply that doesn't fit", async () => {
    const short = await suggestProfile(new ScriptedModel([], [{ name: "SHS", designations: ["SHS 40x40x3"], tags: [], anchor: "centroid", why: "" }]), facts);
    expect(short.designations).toEqual([]);
    await expect(suggestProfile(new ScriptedModel([], [{ name: "SHS" }]), facts)).rejects.toThrow("the suggestion did not fit");
  });
});

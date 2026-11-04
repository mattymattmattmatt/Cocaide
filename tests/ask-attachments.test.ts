// Attachments and the AI history: what a file becomes for each provider, the
// limits, DXF/STEP summaries, the earlier conversation a follow-up carries,
// and the per-document history kept in browser storage (a stand-in
// localStorage here). The asks run on the real kernel, with the scripted
// Anthropic-style model and the Ollama provider against its scripted stand-in.

import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { earlierText, runAsk } from "../src/ask/agent";
import {
  attachmentBlocks,
  attachmentKind,
  attachmentNote,
  cadAttachment,
  canAdd,
  MAX_ATTACHMENTS,
  stepSummary,
  textAttachment,
  TEXT_LIMIT,
  type Attachment,
} from "../src/ask/attachments";
import { LocalKernel } from "../src/ask/kernel";
import { ScriptedModel, say, use } from "../src/ask/model";
import { OllamaClient } from "../src/ask/ollama/client";
import { OllamaModel } from "../src/ask/ollama/model";
import { runPartAsk } from "../src/ask/part";
import { writeDxf } from "../src/io/dxf";
import { getOC, loadOC } from "../src/kernel";
import { addHistory, clearHistory, docKey, earlierOf, entryOf, historyOf, loadDraft, saveDraft, threadOf, updateHistory } from "../src/ui/ask/history";
import { bracket } from "./ollama-scenarios";
import { OllamaStandIn, QWEN } from "./ollama-standin";

let kernel: LocalKernel;
beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const image: Attachment = { id: "a1", name: "sketch.png", kind: "image", mediaType: "image/png", size: 70, data: PNG };
const pdf: Attachment = { id: "a2", name: "spec.pdf", kind: "pdf", mediaType: "application/pdf", size: 900, data: "JVBERi0=", text: "PLATE 80 x 40 x 6\nMATERIAL 304", pages: [PNG] };
const notes = textAttachment("a3", "notes.md", 40, "# Notes\nHoles M6 clearance.", "text/markdown");

describe("what an attachment is", () => {
  it("knows the kinds and refuses others and oversized files with the reason", () => {
    expect(attachmentKind({ name: "a.webp", type: "image/webp", size: 10 })).toBe("image");
    expect(attachmentKind({ name: "a.pdf", type: "application/pdf", size: 10 })).toBe("pdf");
    expect(attachmentKind({ name: "a.csv", type: "text/csv", size: 10 })).toBe("text");
    expect(attachmentKind({ name: "part.STEP", type: "", size: 10 })).toBe("cad");
    expect(attachmentKind({ name: "a.exe", type: "application/octet-stream", size: 10 })).toMatch(/^a\.exe: attach images/);
    expect(attachmentKind({ name: "big.png", type: "image/png", size: 11 * 2 ** 20 })).toBe("big.png is 11.0 MB; the most for an image is 10.0 MB");
  });

  it("limits the count and the total size", () => {
    const six = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => ({ ...notes, id: `n${i}` }));
    expect(canAdd(six, notes)).toBe(`at most ${MAX_ATTACHMENTS} attachments per request`);
    const huge = { ...pdf, data: "A".repeat(48 * 2 ** 20) };
    expect(canAdd([], huge)).toBe("the attachments would be 36.0 MB together; the most is 30.0 MB");
    expect(canAdd([], image)).toBeNull();
  });

  it("cuts long text files and says so", () => {
    const t = textAttachment("t", "log.txt", 1, "x".repeat(TEXT_LIMIT + 10));
    expect(t.text!.length).toBe(TEXT_LIMIT);
    expect(t.truncated).toBe(true);
    expect((attachmentBlocks([t], { documents: true })[0] as Anthropic.TextBlockParam).text).toContain(`cut to its first ${TEXT_LIMIT} characters`);
  });

  it("summarises a DXF with the existing reader, and a STEP by its header", () => {
    const dxf = writeDxf({ entities: [{ type: "line", layer: "OUTLINE", a: [0, 0], b: [80, 0] } as never, { type: "circle", layer: "HOLES", c: [30, 20], r: 3.3 } as never] });
    const a = cadAttachment("c", "plate.dxf", dxf.length, dxf);
    expect(a.kind).toBe("cad");
    expect(a.text).toMatch(/Entities: 1 line, 1 circle\./);
    expect(a.text).toMatch(/Layers: .*OUTLINE \(1\).*HOLES \(1\)|Layers: .*HOLES \(1\).*OUTLINE \(1\)/);
    const step = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('bracket'),'2;1');\nFILE_NAME('bracket.step','2026-11-01',('me'),(''),'Cocaide','Cocaide','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n#1=PRODUCT('bracket','bracket','',(#2));\n#9=MANIFOLD_SOLID_BREP('',#10);\nENDSEC;\nEND-ISO-10303-21;";
    expect(stepSummary(step)).toBe(
      "STEP file (AUTOMOTIVE_DESIGN), named bracket.step, written by Cocaide.\nDescription: bracket.\nProducts: bracket.\n1 solid body.\nOnly the header is summarised here; to use the shape, the user imports it (File → Import STEP).",
    );
    expect(stepSummary("hello")).toMatch(/does not look like a STEP file/);
  });

  it("becomes image and document blocks for a provider that reads PDFs, text and page images for one that doesn't", () => {
    const anthropic = attachmentBlocks([image, pdf, notes], { documents: true });
    expect(anthropic.map((b) => b.type)).toEqual(["image", "document", "text"]);
    expect(anthropic[1]).toMatchObject({ type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" }, title: "spec.pdf" });
    const local = attachmentBlocks([image, pdf, notes], { documents: false });
    expect(local.map((b) => b.type)).toEqual(["image", "image", "text", "text"]);
    expect((local[2] as Anthropic.TextBlockParam).text).toContain("PLATE 80 x 40 x 6");
    expect(attachmentNote([image, pdf])).toMatch(/^The user attached 2 files for reference: sketch\.png \(image\), spec\.pdf \(pdf\)\./);
  });
});

describe("attachments in an ask", () => {
  it("Anthropic-style: the image and the PDF go first in the first turn, the packet and request after", async () => {
    const model = new ScriptedModel([() => [use("updateFeature", { id: "hole_1", patch: { diameter: 8 } })], () => [say("Done.")]]);
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "hole_1" }, text: "make it like the sketch", model, kernel, attachments: [image, pdf] });
    expect(r.outcome).toBe("proposal");
    const content = model.requests[0].messages[0].content as Anthropic.ContentBlockParam[];
    expect(content.map((b) => b.type)).toEqual(["image", "document", "text", "text"]);
    expect((content.at(-1) as Anthropic.TextBlockParam).text.endsWith("The user's request:\nmake it like the sketch")).toBe(true);
  });

  it("Ollama: images in the user message's images (with the PDF's pages), the PDF's text as text", async () => {
    const server = new OllamaStandIn();
    const model = new OllamaModel(new OllamaClient(undefined, { fetch: server.fetch }), { model: QWEN.name });
    server.script({ content: "The spec says 80 × 40 × 6." });
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "ext_1" }, text: "What does the spec say?", model, kernel, attachments: [image, pdf, notes] });
    expect(r.outcome).toBe("answer");
    const user = server.chats[0].messages[1];
    expect(user.role).toBe("user");
    expect(user.images).toEqual([PNG, PNG]);
    expect(user.content).toContain("Attached PDF spec.pdf (its first 1 page shown above as images). Its text layer:\nPLATE 80 x 40 x 6");
    expect(user.content).toContain("Attached file notes.md:\n# Notes");
    expect(user.content).toContain("Context packet:");
  });

  it("a part-level ask reads its request with the attachments", async () => {
    const model = new ScriptedModel([], [{ action: "answer" }]);
    await runPartAsk({ doc: bracket, text: "Make one like the attached", model, kernel, attachments: [image] }).catch(() => undefined);
    expect(model.intentRequests[0].content[0]).toMatchObject({ type: "image" });
    expect((model.intentRequests[0].content.at(-1) as Anthropic.TextBlockParam).text.endsWith("The request:\nMake one like the attached")).toBe(true);
  });

  it("a follow-up carries the earlier turns before the packet", async () => {
    const earlier = [{ prompt: "make it 8 mm", reply: "hole_1 is now Ø8.", changes: ["hole_1 diameter: 6.6 → 8"], status: "accepted" }];
    const model = new ScriptedModel([() => [say("It was 6.6 before, now 8.")]]);
    await runAsk({ doc: bracket, target: { kind: "feature", id: "hole_1" }, text: "What was it before?", model, kernel, earlier });
    const content = model.requests[0].messages[0].content as Anthropic.TextBlockParam[];
    expect(content[0].text).toBe(earlierText(earlier));
    expect(content[0].text).toContain("1. The user asked: make it 8 mm\n   You answered: hole_1 is now Ø8.\n   Changes you proposed (accepted): hole_1 diameter: 6.6 → 8");
  });
});

describe("the AI history, per document", () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  afterEach(() => store.clear());

  it("keeps each request with its reply, calls, changes and outcome, by document; updates and clears", async () => {
    const model = new ScriptedModel([() => [use("updateFeature", { id: "hole_1", patch: { diameter: 8 } })], () => [say("hole_1 is now Ø8.")]]);
    const r = await runAsk({ doc: bracket, target: { kind: "feature", id: "hole_1" }, text: "make it 8 mm", model, kernel });
    const e = entryOf(r, { id: "h1", at: "2026-11-04T10:00:00Z", label: "hole_1", target: { kind: "feature", id: "hole_1" }, prompt: "make it 8 mm", attachments: ["sketch.png"] });
    expect(e).toMatchObject({ reply: "hole_1 is now Ø8.", calls: ["updateFeature ✓"], changes: ["hole_1 diameter: 6.6 → 8"], outcome: "proposal", status: "open", attachments: ["sketch.png"] });
    expect(docKey(bracket)).toBe("bracket");
    addHistory("bracket", e);
    addHistory("flange", { ...e, id: "f1" });
    updateHistory("bracket", "h1", { status: "accepted" });
    expect(historyOf("bracket")).toEqual([{ ...e, status: "accepted" }]);
    expect(historyOf("flange")).toHaveLength(1);
    clearHistory("bracket");
    expect(historyOf("bracket")).toEqual([]);
    expect(historyOf("flange")).toHaveLength(1);
  });

  it("a follow-up's thread runs back through what it follows", () => {
    const base = { at: "2026-11-04T10:00:00Z", label: "hole_1", target: { kind: "feature" as const, id: "hole_1" }, attachments: [], model: "m", outcome: "answer" as const, calls: [], changes: [], status: "none" as const };
    const entries = [
      { ...base, id: "a", prompt: "first", reply: "one" },
      { ...base, id: "b", prompt: "other", reply: "x" },
      { ...base, id: "c", prompt: "second", reply: "two", followUpOf: "a" },
    ];
    expect(threadOf(entries, "c").map((e) => e.id)).toEqual(["a", "c"]);
    expect(earlierOf(threadOf(entries, "c"))).toEqual([
      { prompt: "first", reply: "one", changes: [], status: "none" },
      { prompt: "second", reply: "two", changes: [], status: "none" },
    ]);
  });

  it("drafts are kept per document and target until sent", () => {
    saveDraft("bracket", { kind: "feature", id: "hole_1" }, "make it");
    expect(loadDraft("bracket", { kind: "feature", id: "hole_1" })).toBe("make it");
    expect(loadDraft("bracket", { kind: "feature", id: "ext_1" })).toBe("");
    saveDraft("bracket", { kind: "feature", id: "hole_1" }, "");
    expect(loadDraft("bracket", { kind: "feature", id: "hole_1" })).toBe("");
  });
});

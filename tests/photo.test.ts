// Phase G: a photo pinned under the part. The fixture is a photo of the
// spec's bracket from above, with a steel rule beside it, drawn so every
// edge's pixel position is known (scripts/make-photos.ts). The model is
// scripted; the planning, the scale, the estimates and the export rule run
// for real.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/session";
import { applyProposal } from "../src/ask/agent";
import { LocalKernel } from "../src/ask/kernel";
import { ScriptedModel } from "../src/ask/model";
import { runPartAsk, type Photo } from "../src/ask/part";
import { apply, type RawDocument } from "../src/doc/commands";
import { exportRefusal, photoNote } from "../src/doc/photo";
import type { PhotoUnderlay } from "../src/doc/types";
import { allErrors, validateDocument } from "../src/doc/validate";
import { decodePNG } from "../src/render/pngDecode";
import { guessKind } from "../src/photo/kind";
import type { PhotoReading } from "../src/intent/photo";
import { getOC, loadOC, rebuild } from "../src/kernel";
import { HOLE, PHOTO, PLATE, RULE } from "../scripts/make-photos";

const EMPTY: RawDocument = { version: 1, units: "mm", name: "part", features: [] };
const bytes = readFileSync(new URL("../examples/photos/bracket-photo.jpg", import.meta.url));
const PHOTO_FILE: Photo = {
  name: "bracket-photo.jpg",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  mediaType: "image/jpeg",
  data: bytes.toString("base64"),
  width: PHOTO.width,
  height: PHOTO.height,
};
const BRACKET_VOLUME = 18994.728336;

/** What a good reading of the bracket photo looks like, in its pixels. */
function bracketReading(scale: Partial<PhotoReading["scale"]> = {}): PhotoReading {
  return {
    category: { value: "prismatic", evidence: "a flat rectangular steel plate with one round hole", confidence: 0.95 },
    description: "a flat steel plate with one hole near the right end",
    name: "bracket",
    view: "face-on",
    kind: "plate",
    outline: { ...PLATE },
    holes: [{ x: HOLE.x, y: HOLE.y, diameter: HOLE.d }],
    thickness: null,
    typedThickness: { value: null, units: "mm", evidence: "" },
    scale: {
      what: "the plate's long edge",
      dimension: "width",
      from: { x: PLATE.left, y: 420 },
      to: { x: PLATE.right, y: 420 },
      length: 80,
      units: "mm",
      evidence: "the long edge is 80 mm",
      source: "typed",
      ...scale,
    },
    notes: [],
  };
}

let kernel: LocalKernel;
beforeAll(async () => {
  await loadOC();
  kernel = new LocalKernel(getOC);
});

async function fromPhoto(note: string, reading: PhotoReading) {
  const model = new ScriptedModel([], [reading]);
  const r = await runPartAsk({ doc: EMPTY, text: note, photo: PHOTO_FILE, model, kernel });
  return { r, model };
}

function accepted(r: Awaited<ReturnType<typeof runPartAsk>>): RawDocument {
  const a = applyProposal(EMPTY, r.proposal!);
  if (!a.ok) throw new Error(a.error);
  return a.doc;
}

function must(r: ReturnType<typeof apply>): RawDocument {
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

function volume(doc: RawDocument): number {
  const built = rebuild(doc, getOC());
  try {
    expect(built.errors).toEqual([]);
    return built.measurements!.volume;
  } finally {
    built.dispose();
  }
}

describe("a photo becomes a proposed part, pinned over the photo", () => {
  it("scales every size from the one dimension the user typed", async () => {
    const { r, model } = await fromPhoto("the long edge is 80 mm", bracketReading());
    expect(r.outcome, r.text).toBe("proposal");
    // What the model was sent: the photo at its own size, and the note.
    const sent = model.intentRequests[0];
    expect(sent.schema).toBe("photo");
    expect(sent.content[0]).toMatchObject({ type: "image", source: { media_type: "image/jpeg", data: PHOTO_FILE.data } });
    expect((sent.content[1] as Anthropic.TextBlockParam).text).toContain("bracket-photo.jpg, 1400 × 1000 pixels");

    const doc = accepted(r);
    expect(doc.parameters).toEqual({ plate_w: 80, plate_h: 40, part_t: 4, hole_d: 6.6, hole_1_x: 70, hole_1_y: 20 });
    const photo = doc.photo as PhotoUnderlay;
    expect(photo).toMatchObject({
      image: "bracket-photo.jpg",
      sha256: PHOTO_FILE.sha256,
      width: 1400,
      height: 1000,
      origin: [620, 420],
      scale: { from: [300, 420], to: [940, 420], length: 80, what: "the plate's long edge", source: "typed", parameter: "plate_w", confirmed: false },
    });
    // Each estimate keeps its size in pixels; the thickness is a guess.
    expect(photo.estimated).toEqual({ plate_w: 640, plate_h: 320, part_t: null, hole_d: 52.8, hole_1_x: 560, hole_1_y: 160 });
    expect(r.text).toBe(
      'An estimated 80 × 40 × 4 mm plate with 1 hole ("bracket"). Checked against what was read from the photo: 6 of 6 checks pass. ' +
        "Scale: the plate's long edge = 80 mm (from your note); every other size is measured on the photo and scaled from it. part_t is a guess: the photo doesn't show it. " +
        "Export stays off until you confirm the scale on the photo and set the guesses. It is an estimate, not a part ready to make.",
    );
    expect(volume(doc)).toBeCloseTo(80 * 40 * 4 - Math.PI * 3.3 ** 2 * 4, 3);
  });

  it("the system refuses to export STEP until the user has confirmed the scale dimension", async () => {
    const { r } = await fromPhoto("the long edge is 80 mm", bracketReading());
    let doc = accepted(r);
    expect(exportRefusal(doc)).toBe(
      "Not exported. This part was estimated from a photo (bracket-photo.jpg), and its scale is not confirmed: check that the plate's long edge is 80 mm on the photo, then confirm it; " +
        "and part_t is a guess: the photo doesn't show it. Set it in Parameters.",
    );

    // The user sets the thickness: their number, no longer a guess.
    doc = must(apply(doc, { type: "setParameter", name: "part_t", value: 6 }, { user: true }));
    expect((doc.photo as PhotoUnderlay).estimated).not.toHaveProperty("part_t");
    expect(exportRefusal(doc)).toMatch(/its scale is not confirmed/);

    // An agent can't confirm the scale, even with the whole part in scope.
    const agent = apply(doc, { type: "setPhotoScale", confirm: true }, { writeScope: ["*"] });
    expect(agent).toEqual({ ok: false, error: "setPhotoScale: only the user can confirm a photo's scale, in the app" });
    expect(apply(doc, { type: "setPhotoScale", length: 81 }, { writeScope: ["hole_1"] })).toEqual({
      ok: false,
      error: "writeScope: setPhotoScale is outside the scope [hole_1]",
    });

    doc = must(apply(doc, { type: "setPhotoScale", confirm: true }, { user: true }));
    expect(exportRefusal(doc)).toBeNull();
    expect(volume(doc)).toBeCloseTo(BRACKET_VOLUME, 4);
    expect(photoNote(doc)).toBe(
      "Estimated from a photo (bracket-photo.jpg), scaled from one dimension the user confirmed: the plate's long edge = 80 mm. 5 sizes are still estimated from the photo. Check every size against the part before making it.",
    );
  });

  it("every export path asks: the agent session refuses, then writes the note into the STEP header", async () => {
    const { r } = await fromPhoto("the long edge is 80 mm", bracketReading());
    const dir = mkdtempSync(join(tmpdir(), "cocaide-photo-"));
    const unconfirmed = must(apply(accepted(r), { type: "setParameter", name: "part_t", value: 6 }, { user: true }));
    const s = await AgentSession.open({ doc: unconfirmed, outDir: dir });
    for (const tool of ["exportSTEP", "exportSTL"] as const) {
      const refused = (await s.call(tool)).result;
      expect(refused.ok).toBe(false);
      expect(refused.error).toMatch(new RegExp(`^${tool}: Not exported\\. This part was estimated from a photo`));
    }
    s.close();

    const confirmed = must(apply(unconfirmed, { type: "setPhotoScale", confirm: true }, { user: true }));
    const t = await AgentSession.open({ doc: confirmed, outDir: dir });
    expect((await t.call("exportSTEP")).result).toMatchObject({ ok: true });
    expect(readFileSync(join(dir, "bracket.step"), "utf8")).toContain(
      "FILE_DESCRIPTION(('Estimated from a photo (bracket-photo.jpg), scaled from one dimension the user confirmed: the plate''s long edge = 80 mm. 5 sizes are still estimated from the photo.",
    );
    t.close();
  });

  it("changing the scale rescales every estimate, not the sizes the user set, and unconfirms it", async () => {
    const { r } = await fromPhoto("the long edge is 80 mm", bracketReading());
    let doc = must(apply(accepted(r), { type: "setParameter", name: "part_t", value: 6 }, { user: true }));
    doc = must(apply(doc, { type: "setPhotoScale", confirm: true }, { user: true }));
    // The long edge was really 100: everything measured on the photo grows with it.
    doc = must(apply(doc, { type: "setPhotoScale", length: 100 }, { user: true }));
    expect(doc.parameters).toEqual({ plate_w: 100, plate_h: 50, part_t: 6, hole_d: 8.3, hole_1_x: 87.5, hole_1_y: 25 });
    expect((doc.photo as PhotoUnderlay).scale).toMatchObject({ length: 100, source: "typed", confirmed: false, parameter: "plate_w" });
    expect(volume(doc)).toBeCloseTo(100 * 50 * 6 - Math.PI * 4.15 ** 2 * 6, 3);

    // Moving the scale's points: the line no longer measures plate_w.
    doc = must(apply(doc, { type: "setPhotoScale", from: [RULE.zero[0], RULE.zero[1]], to: [RULE.hundred[0], RULE.hundred[1]] }, { user: true }));
    expect((doc.photo as PhotoUnderlay).scale).not.toHaveProperty("parameter");
    expect((doc.photo as PhotoUnderlay).scale.what).toBe("the line picked on the photo");
    expect(doc.parameters).toMatchObject({ plate_w: 80, plate_h: 40, hole_d: 6.6 });
    // A size set by hand is the user's.
    doc = must(apply(doc, { type: "setParameter", name: "hole_d", value: 6.5 }, { user: true }));
    doc = must(apply(doc, { type: "setPhotoScale", length: 50 }, { user: true }));
    expect(doc.parameters).toMatchObject({ plate_w: 40, hole_d: 6.5 });
  });

  it("a rule in the photo can set the scale; a guess can't be confirmed as it is", async () => {
    const ruler = bracketReading({ what: "the 0 and 100 mm marks on the rule", dimension: "none", from: { x: RULE.zero[0], y: RULE.zero[1] }, to: { x: RULE.hundred[0], y: RULE.hundred[1] }, length: 100, evidence: "rule marked 0 to 10 cm", source: "reference" });
    const ref = accepted((await fromPhoto("", ruler)).r);
    expect(ref.parameters).toMatchObject({ plate_w: 80, plate_h: 40, hole_d: 6.6, hole_1_x: 70, hole_1_y: 20 });
    expect((ref.photo as PhotoUnderlay).scale).toMatchObject({ source: "reference", length: 100, confirmed: false });

    // "80" said to be typed, but the note doesn't say it: a guess.
    const { r } = await fromPhoto("make this", bracketReading());
    expect((accepted(r).photo as PhotoUnderlay).scale.source).toBe("guess");
    expect(r.text).toContain("(a guess)");
    // No length at all: the long side is guessed at about 100 mm.
    const none = accepted((await fromPhoto("", bracketReading({ length: null, source: "guess" }))).r);
    expect(none.parameters).toMatchObject({ plate_w: 100, plate_h: 50 });
    const guess = { type: "setPhotoScale", confirm: true } as const;
    expect(apply(none, guess, { user: true })).toEqual({ ok: false, error: "setPhotoScale: the length is a guess; type the real length to confirm it" });
    expect(apply(none, { ...guess, length: 80 }, { user: true }).ok).toBe(true);
  });

  it("a thickness typed in the note is the user's number, not a guess", async () => {
    const reading = bracketReading();
    reading.typedThickness = { value: 6, units: "mm", evidence: "6 mm plate" };
    const { r } = await fromPhoto("6 mm plate, the long edge is 80 mm", reading);
    const doc = accepted(r);
    expect(doc.parameters).toMatchObject({ part_t: 6 });
    expect((doc.photo as PhotoUnderlay).estimated).not.toHaveProperty("part_t");
    expect(r.text).not.toContain("guess");
    expect(exportRefusal(doc)).toMatch(/its scale is not confirmed: .*\.$/);
    expect(exportRefusal(doc)).not.toMatch(/guess/);
  });

  it("freeform parts are refused; plates and discs only", async () => {
    const freeform = bracketReading();
    freeform.category = { value: "freeform", evidence: "a smooth, organic moulded shape", confidence: 0.9 };
    freeform.kind = "other";
    const a = (await fromPhoto("", freeform)).r;
    expect(a.outcome).toBe("refused");
    expect(a.proposal).toBeNull();
    expect(a.text).toBe("This looks freeform (a smooth, organic moulded shape). Cocaide builds prismatic and turned parts; model this one by hand, with the photo for reference.");

    const bracketBody = bracketReading();
    bracketBody.kind = "other";
    bracketBody.description = "an L-shaped bracket";
    expect((await fromPhoto("", bracketBody)).r.text).toMatch(/^From a photo, v1 builds flat plates and discs/);
  });

  it("a disc's holes are placed from its centre", async () => {
    const disc = bracketReading({ what: "the disc's diameter", dimension: "diameter", length: 60 });
    disc.kind = "disc";
    disc.outline = { left: 400, top: 200, right: 880, bottom: 680 }; // 480 px across
    disc.holes = [
      { x: 640 + 160, y: 440, diameter: 48 },
      { x: 640 - 160, y: 440, diameter: 48 },
    ];
    const doc = accepted((await fromPhoto("the disc is 60 across", disc)).r);
    expect(doc.parameters).toEqual({ disc_d: 60, part_t: 6, hole_d: 6, hole_1_x: -20, hole_1_y: 0, hole_2_x: 20, hole_2_y: 0 });
    expect((doc.photo as PhotoUnderlay).scale.parameter).toBe("disc_d");
  });
});

describe("the photo in the document", () => {
  it("validates strictly", async () => {
    const doc = accepted((await fromPhoto("the long edge is 80 mm", bracketReading())).r);
    expect(allErrors(validateDocument(doc))).toEqual([]);
    const bad = structuredClone(doc) as RawDocument & { photo: Record<string, unknown> };
    bad.photo.estimated = { ...(bad.photo.estimated as object), nope: 3 };
    (bad.photo.scale as Record<string, unknown>).source = "vibes";
    bad.photo.colour = "red";
    expect(allErrors(validateDocument(bad))).toEqual([
      'document: photo: unknown field "colour" (allowed: image, sha256, width, height, origin, scale, estimated)',
      "document: photo.scale.source: must be one of typed, reference, guess (got \"vibes\")",
      "document: photo.estimated.nope: is not a parameter",
    ]);
    // Deleting a parameter takes it out of the estimates.
    const lessDoc = must(apply(doc, { type: "updateFeature", id: "hole_1", patch: { diameter: 6.6 } }));
    const gone = must(apply(lessDoc, { type: "deleteParameter", name: "hole_d" }));
    expect((gone.photo as PhotoUnderlay).estimated).not.toHaveProperty("hole_d");
  });

  it("a drawing looks like a drawing to the drop guess", async () => {
    for (const f of ["bracket-scan.png", "bracket-blurry.png"]) {
      const img = await decodePNG(new Uint8Array(readFileSync(new URL(`../examples/drawings/${f}`, import.meta.url))));
      expect(guessKind(img.data, img.width, img.height), f).toBe("drawing");
    }
  });
});

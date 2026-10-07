// Phase G acceptance against the real model. Runs only with ANTHROPIC_API_KEY
// set (COCAIDE_ASK_MODEL picks the model; default Claude Opus 5.5). The same
// checks run without a key in tests/photo.test.ts (scripted readings) and
// e2e/photo.spec.ts (the browser, with the API answered by a script).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { applyProposal } from "../src/ask/agent";
import { LocalKernel } from "../src/ask/kernel";
import { AnthropicModel, anthropicClient, DEFAULT_MODEL } from "../src/ask/model";
import { runPartAsk, type Photo } from "../src/ask/part";
import { apply, type RawDocument } from "../src/doc/commands";
import { exportRefusal, photoGuesses } from "../src/doc/photo";
import type { PhotoUnderlay } from "../src/doc/types";
import { getOC, loadOC } from "../src/kernel";

const key = process.env.ANTHROPIC_API_KEY;
const EMPTY: RawDocument = { version: 1, units: "mm", name: "part", features: [] };

/** A fixture as the browser prepares it: 1400 x 1000 is under the 1568 px limit, so it goes as it is. */
function photo(file: string): Photo {
  const bytes = readFileSync(new URL(`../examples/photos/${file}`, import.meta.url));
  return { name: file, sha256: createHash("sha256").update(bytes).digest("hex"), mediaType: "image/jpeg", data: bytes.toString("base64"), width: 1400, height: 1000 };
}

describe.skipIf(!key)("Phase G acceptance (live model)", () => {
  let kernel: LocalKernel;
  const model = () => new AnthropicModel(anthropicClient({ apiKey: key }), process.env.COCAIDE_ASK_MODEL ?? DEFAULT_MODEL, "low");
  beforeAll(async () => {
    await loadOC();
    kernel = new LocalKernel(getOC);
  });

  it("a photo with one known dimension becomes proposed features, and STEP waits for the user to confirm the scale", async () => {
    const r = await runPartAsk({ doc: EMPTY, text: "the long edge is 80 mm", photo: photo("bracket-photo.jpg"), model: model(), kernel });
    expect(r.outcome, r.text).toBe("proposal");
    const accepted = applyProposal(EMPTY, r.proposal!);
    if (!accepted.ok) throw new Error(accepted.error);
    let doc = accepted.doc;
    const p = doc.parameters as Record<string, number>;
    // Estimates from a photo: the typed edge exactly, the rest near the truth.
    expect(p.plate_w).toBe(80);
    expect(Math.abs(p.plate_h - 40)).toBeLessThan(4);
    expect(Math.abs(p.hole_d - 6.6)).toBeLessThan(1.5);
    expect((doc.photo as PhotoUnderlay).scale.confirmed).toBe(false);
    expect(exportRefusal(doc)).toMatch(/its scale is not confirmed/);

    // The user sets the guesses and confirms the scale: then, and only then, it may be exported.
    for (const name of photoGuesses(doc.photo as PhotoUnderlay)) {
      const set = apply(doc, { type: "setParameter", name, value: 6 }, { user: true });
      if (!set.ok) throw new Error(set.error);
      doc = set.doc;
    }
    expect(exportRefusal(doc)).toMatch(/its scale is not confirmed/);
    const confirmed = apply(doc, { type: "setPhotoScale", confirm: true }, { user: true });
    if (!confirmed.ok) throw new Error(confirmed.error);
    expect(exportRefusal(confirmed.doc)).toBeNull();
  }, 240_000);

  it("a freeform part is refused", async () => {
    const r = await runPartAsk({ doc: EMPTY, text: "", photo: photo("freeform-photo.jpg"), model: model(), kernel });
    expect(r.outcome, r.text).toBe("refused");
    expect(r.proposal).toBeNull();
  }, 240_000);
});

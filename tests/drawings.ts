// The Phase F drawing fixtures (examples/drawings, made by
// scripts/make-drawings.ts) as the browser prepares them: page PNGs at
// 200 dpi, legibility measured on the pixels, and the PDF's text layer.

import { readFileSync } from "node:fs";
import type { Drawing } from "../src/ask/part";
import { legibility } from "../src/drawing/legibility";
import { decodePNG } from "../src/render/pngDecode";

/** The text layer pdf.js extracts from examples/drawings/bracket.pdf. */
export const SHEET = "80 40 70 20 Ø6.6 THRU TOP VIEW 6 FRONT VIEW BRACKET DWG NO. CD-0001 SCALE 3:2 MATERIAL: S275 STEEL UNITS: mm TOLERANCES ±0.1 THIRD ANGLE PROJECTION";
export const fixture = (f: string) => new Uint8Array(readFileSync(new URL(`../examples/drawings/${f}`, import.meta.url)));

/** A fixture as prepareDrawing() makes it in the browser. */
export async function drawingOf(file: string, type: string, text: string, dpi: number | null): Promise<Drawing> {
  const bytes = fixture(file);
  const png = file.endsWith(".png") ? bytes : fixture("bracket-scan.png"); // a PDF reaches the model as its 200 dpi page
  const img = await decodePNG(png);
  const leg = legibility(img.data, img.width, img.height);
  return {
    name: file,
    mediaType: type,
    pages: [{ png: Buffer.from(png).toString("base64"), width: img.width, height: img.height, legibility: leg }],
    pageCount: 1,
    text,
    dpi,
    legibility: leg,
  };
}

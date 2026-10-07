// A dropped drawing, made ready to read (spec 5.2, step 1): PDF pages
// rasterised at 200 dpi, with the PDF's own text layer when it has one;
// images taken as they are. Each page is checked for legibility. Browser
// only: it draws on a canvas. pdf.js is loaded on first use.

import { legibility, type Legibility } from "./legibility";

export const DPI = 200;
/** v1 reads one part per drawing; more pages than this are not sent. */
export const MAX_PAGES = 3;
/** The API's largest image side. */
const MAX_SIDE = 8000;

export interface DrawingPage {
  /** PNG, base64. */
  png: string;
  width: number;
  height: number;
  legibility: Legibility;
}

export interface PreparedDrawing {
  name: string;
  mediaType: string;
  pages: DrawingPage[];
  /** Pages in the file (more than were rasterised, if over MAX_PAGES). */
  pageCount: number;
  /** The PDF's text layer: the exact text printed on the drawing. Empty for images and scanned PDFs. */
  text: string;
  /** Rasterisation resolution, for PDFs. */
  dpi: number | null;
  /** The least legible page decides. */
  legibility: Legibility;
}

export async function prepareDrawing(file: { name: string; type: string; bytes: Uint8Array }): Promise<PreparedDrawing> {
  if (file.type === "application/pdf") return preparePdf(file);
  return prepareImage(file);
}

async function preparePdf(file: { name: string; type: string; bytes: Uint8Array }): Promise<PreparedDrawing> {
  // The legacy build carries polyfills for what current browsers lack (Map.getOrInsertComputed).
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const workerUrl = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  // Scripting stays off: a drawing is read, never run.
  const task = pdfjs.getDocument({ data: file.bytes.slice(), enableXfa: false });
  const doc = await task.promise;
  try {
    const pages: DrawingPage[] = [];
    const text: string[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(DPI / 72, MAX_SIDE / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      pages.push(await pageOf(canvas, ctx));
      const content = await page.getTextContent();
      text.push(content.items.map((i) => ("str" in i ? i.str : "")).filter(Boolean).join(" "));
      page.cleanup();
    }
    return finish(file, pages, doc.numPages, text.join("\n").trim(), DPI);
  } finally {
    await task.destroy();
  }
}

async function prepareImage(file: { name: string; type: string; bytes: Uint8Array }): Promise<PreparedDrawing> {
  const bitmap = await createImageBitmap(new Blob([file.bytes as BlobPart], { type: file.type }));
  const k = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * k);
  canvas.height = Math.round(bitmap.height * k);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return finish(file, [await pageOf(canvas, ctx)], 1, "", null);
}

async function pageOf(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): Promise<DrawingPage> {
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode the page"))), "image/png"));
  return { png: base64(new Uint8Array(await blob.arrayBuffer())), width: canvas.width, height: canvas.height, legibility: legibility(pixels.data, canvas.width, canvas.height) };
}

function finish(file: { name: string; type: string }, pages: DrawingPage[], pageCount: number, text: string, dpi: number | null): PreparedDrawing {
  const worst = pages.reduce((a, p) => (p.legibility.score < a.score ? p.legibility : a), pages[0].legibility);
  return { name: file.name, mediaType: file.type, pages, pageCount, text, dpi, legibility: worst };
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

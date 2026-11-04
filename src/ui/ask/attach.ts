// Reading a file the user attached to an AI request, in the browser: an image
// scaled to what the models take and re-encoded as PNG or JPEG (so WebP and
// GIF work with every provider), a PDF kept whole for providers that read PDFs
// and also rendered and read by the drawing rasteriser (its text layer and
// first pages) for those that don't, a text file's text, and a DXF or STEP
// file's summary. The rules (kinds, limits, summaries) are src/ask/attachments.ts.

import { attachmentKind, cadAttachment, textAttachment, type Attachment } from "../../ask/attachments";
import { base64 } from "../../ask/prompt";

/** The longest side an attached image is sent at (larger ones are scaled down). */
export const IMAGE_SIDE = 1568;

let seq = 0;

export async function prepareAttachment(file: File): Promise<Attachment | string> {
  const kind = attachmentKind(file);
  if (!kind.match(/^(image|pdf|text|cad)$/)) return kind;
  const id = `att${Date.now().toString(36)}${++seq}`;
  try {
    if (kind === "image") return { id, name: file.name || "pasted image", kind, size: file.size, ...(await imageData(file)) };
    if (kind === "pdf") {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { prepareDrawing } = await import("../../drawing/rasterize");
      const d = await prepareDrawing({ name: file.name, type: "application/pdf", bytes: bytes.slice() });
      return { id, name: file.name, kind, mediaType: "application/pdf", size: file.size, data: base64(bytes), text: d.text, pages: d.pages.map((p) => p.png) };
    }
    const text = await file.text();
    return kind === "cad" ? cadAttachment(id, file.name, file.size, text) : textAttachment(id, file.name, file.size, text, file.type || "text/plain");
  } catch (e) {
    return `${file.name}: could not be read (${(e as Error).message})`;
  }
}

async function imageData(file: File): Promise<{ mediaType: string; data: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const keep = scale === 1 && (file.type === "image/png" || file.type === "image/jpeg") && file.size <= 4 * 2 ** 20;
  if (keep) {
    bitmap.close();
    return { mediaType: file.type, data: base64(new Uint8Array(await file.arrayBuffer())) };
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // Photos stay JPEG; anything else (screenshots, drawings, WebP, GIF) becomes PNG.
  const type = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("the image could not be encoded"))), type, 0.9));
  return { mediaType: type, data: base64(new Uint8Array(await blob.arrayBuffer())) };
}

// Sheet files for export (Phase L, Phase Q): the PDF's fonts and the sheet
// as a PNG. The sheet itself is drawn by SheetCanvas.tsx (wave Q2B).

import type { ComposedSheet } from "../../drafting/compose";
import type { FontFile } from "../../drafting/pdf";
import { sheetSVG } from "../../drafting/svg";

let fonts: Promise<{ regular: FontFile; bold: FontFile } | null> | null = null;

/** Liberation Sans regular and bold, fetched once and deflated, for PDFs that carry their font. Null when they can't be had. */
export function pdfFonts(): Promise<{ regular: FontFile; bold: FontFile } | null> {
  if (!fonts) {
    const one = async (file: string): Promise<FontFile> => {
      const r = await fetch(`${import.meta.env.BASE_URL}fonts/${file}`);
      if (!r.ok) throw new Error(`${file}: ${r.status}`);
      const data = new Uint8Array(await r.arrayBuffer());
      const deflated = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
      return { data, deflated };
    };
    fonts = Promise.all([one("LiberationSans-Regular.ttf"), one("LiberationSans-Bold.ttf")]).then(
      ([regular, bold]) => ({ regular, bold }),
      () => null,
    );
  }
  return fonts;
}

/** The sheet as a PNG at 200 dpi (at most 8000 pixels across), drawn from its SVG. */
export async function sheetPNG(sheet: ComposedSheet, dpi = 200): Promise<Uint8Array> {
  const k = Math.min(dpi / 25.4, 8000 / Math.max(sheet.width, sheet.height));
  const w = Math.round(sheet.width * k);
  const h = Math.round(sheet.height * k);
  const svg = sheetSVG(sheet).replace(/width="[^"]*mm" height="[^"]*mm"/, `width="${w}" height="${h}"`);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/png"));
    if (!blob) throw new Error("the browser could not make the picture");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

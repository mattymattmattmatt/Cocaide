// The sheet as a vector PDF (Phase L): one page, the sheet's size, every line
// and circle as a path and every word as real text in Helvetica, which every
// PDF reader has built in, so nothing is embedded and nothing is rasterised.
// Written by hand: a page of lines and text needs a few hundred bytes of
// structure, not a library.

import type { ComposedSheet } from "./compose";
import type { Prim } from "./sheet";
import { textWidth } from "./text";

const PT_PER_MM = 72 / 25.4;
/** Bézier handle length for a quarter circle. */
const KAPPA = 0.5522847498;

export interface PdfOptions {
  title?: string;
}

export function sheetPDF(sheet: ComposedSheet, opts: PdfOptions = {}): Uint8Array {
  const n = (x: number) => String(Math.round(x * 1000) / 1000 + 0);
  const ops: string[] = [`${n(PT_PER_MM)} 0 0 ${n(PT_PER_MM)} 0 0 cm`, "1 J 1 j 0 G 0 g"];
  let width = -1;
  let dash = "";
  const stroke = (w: number, d?: number[]) => {
    if (w !== width) ops.push(`${n(w)} w`);
    width = w;
    const next = d ? `[${d.map(n).join(" ")}] 0 d` : "[] 0 d";
    if (next !== dash) ops.push(next);
    dash = next;
  };
  for (const p of sheet.prims) ops.push(...prim(p));
  const content = ops.join("\n");

  function prim(p: Prim): string[] {
    if (p.k === "line") {
      if (p.pts.length < 2) return [];
      stroke(p.w, p.fill ? undefined : p.dash);
      const path = p.pts.map(([x, y], i) => `${n(x)} ${n(y)} ${i ? "l" : "m"}`);
      return [...path, p.fill ? "h f" : p.closed ? "h S" : "S"];
    }
    if (p.k === "circle") {
      stroke(p.w);
      const [cx, cy] = p.c;
      const r = p.r;
      const k = r * KAPPA;
      return [
        `${n(cx + r)} ${n(cy)} m`,
        `${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c`,
        `${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c`,
        `${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c`,
        `${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c`,
        p.fill ? "f" : "S",
      ];
    }
    const a = ((p.angle ?? 0) * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const w = textWidth(p.text, p.size, p.bold);
    const shift = p.anchor === "start" ? 0 : p.anchor === "middle" ? -w / 2 : -w;
    const x = p.at[0] + shift * c;
    const y = p.at[1] + shift * s;
    return [`BT /${p.bold ? "F2" : "F1"} ${n(p.size)} Tf ${n(c)} ${n(s)} ${n(-s)} ${n(c)} ${n(x)} ${n(y)} Tm (${pdfString(p.text)}) Tj ET`];
  }

  const W = n(sheet.width * PT_PER_MM);
  const H = n(sheet.height * PT_PER_MM);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Title (${pdfString(opts.title ?? "drawing")}) /Producer (Cocaide) >>`,
  ];
  let out = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every character above is one byte (the content is ASCII; the header's marker bytes are Latin-1).
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

/** Windows-1252 positions of the few characters outside Latin-1 that a drawing uses. */
const WIN_ANSI: Record<string, number> = { "–": 150, "—": 151, "…": 133, "‘": 145, "’": 146, "“": 147, "”": 148, "•": 149, "€": 128 };

/** A PDF literal string in WinAnsiEncoding, as ASCII: escapes for ( ) \ and octal for the rest. */
export function pdfString(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (ch === "(" || ch === ")" || ch === "\\") out += `\\${ch}`;
    else if (c >= 32 && c < 127) out += ch;
    else {
      const code = WIN_ANSI[ch] ?? (c >= 160 && c <= 255 ? c : 63); // "?" for what Helvetica can't show
      out += `\\${code.toString(8).padStart(3, "0")}`;
    }
  }
  return out;
}

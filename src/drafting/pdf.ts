// The drawing as a vector PDF (Phase L; Phase Q: every sheet a page, the
// font embedded): every line and circle a path at its real line weight, every
// word real text. With fonts given (Liberation Sans, metric-compatible with
// Helvetica, so the sheet's text measures the same), they are embedded as
// TrueType and the file prints the same anywhere; without, the text is set in
// Helvetica, which every reader has built in. Written by hand: pages of lines
// and text need a few hundred bytes of structure, not a library.

import type { ComposedSheet } from "./compose";
import type { Prim } from "./sheet";
import { textWidth } from "./text";

const PT_PER_MM = 72 / 25.4;
/** Bézier handle length for a quarter circle. */
const KAPPA = 0.5522847498;

/** A TrueType font to embed: the file, and the same deflated (zlib) when the caller has it. */
export interface FontFile {
  data: Uint8Array;
  deflated?: Uint8Array;
}

export interface PdfOptions {
  title?: string;
  /** Embed these (regular and bold) instead of naming Helvetica. */
  fonts?: { regular: FontFile; bold: FontFile };
}

/** One sheet, one page. */
export function sheetPDF(sheet: ComposedSheet, opts: PdfOptions = {}): Uint8Array {
  return drawingPDF([sheet], opts);
}

const n = (x: number) => String(Math.round(x * 1000) / 1000 + 0);

/** A page's content stream: the sheet's primitives, in mm (the page's matrix scales them to points). */
function pageContent(sheet: ComposedSheet): string {
  const ops: string[] = [`${n(PT_PER_MM)} 0 0 ${n(PT_PER_MM)} 0 0 cm`, "1 J 1 j 0 G 0 g"];
  let width = -1;
  let dash = "";
  let stroke = "0 G";
  let fill = "0 g";
  const setStroke = (w: number, d?: number[], color?: string) => {
    if (w !== width) ops.push(`${n(w)} w`);
    width = w;
    const next = d ? `[${d.map(n).join(" ")}] 0 d` : "[] 0 d";
    if (next !== dash) ops.push(next);
    dash = next;
    const s = color ? `${rgb(color)} RG` : "0 G";
    if (s !== stroke) ops.push(s);
    stroke = s;
  };
  const setFill = (color?: string) => {
    const f = color ? `${rgb(color)} rg` : "0 g";
    if (f !== fill) ops.push(f);
    fill = f;
  };
  for (const p of sheet.prims) ops.push(...prim(p));
  return ops.join("\n");

  function prim(p: Prim): string[] {
    if (p.k === "line") {
      if (p.pts.length < 2) return [];
      setStroke(p.w, p.fill ? undefined : p.dash, p.color);
      if (p.fill) setFill(p.color);
      const path = p.pts.map(([x, y], i) => `${n(x)} ${n(y)} ${i ? "l" : "m"}`);
      return [...path, p.fill ? "h f" : p.closed ? "h S" : "S"];
    }
    if (p.k === "area") {
      setFill(p.fill);
      const path = p.loops.flatMap((l) => [...l.map(([x, y], i) => `${n(x)} ${n(y)} ${i ? "l" : "m"}`), "h"]);
      return [...path, "f*"];
    }
    if (p.k === "circle") {
      setStroke(p.w, p.dash, p.color);
      if (p.fill) setFill(p.color);
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
    setFill(p.color);
    const a = ((p.angle ?? 0) * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const w = textWidth(p.text, p.size, p.bold);
    const shift = p.anchor === "start" ? 0 : p.anchor === "middle" ? -w / 2 : -w;
    const x = p.at[0] + shift * c;
    const y = p.at[1] + shift * s;
    // Italic: the letters sheared 12° (the fonts embedded are upright), turned with the text.
    const k = p.italic ? Math.tan((12 * Math.PI) / 180) : 0;
    return [`BT /${p.bold ? "F2" : "F1"} ${n(p.size)} Tf ${n(c)} ${n(s)} ${n(k * c - s)} ${n(k * s + c)} ${n(x)} ${n(y)} Tm (${pdfString(p.text)}) Tj ET`];
  }
}

function rgb(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return "0 0 0";
  return [m[1], m[2], m[3]].map((h) => n(parseInt(h, 16) / 255)).join(" ");
}

/** Every sheet a page, in order, the fonts shared. */
export function drawingPDF(sheets: ComposedSheet[], opts: PdfOptions = {}): Uint8Array {
  const objects: (string | Uint8Array)[][] = [];
  const add = (...parts: (string | Uint8Array)[]) => {
    objects.push(parts);
    return objects.length;
  };
  const catalog = add(""); // filled below
  const pages = add("");
  let fonts: [number, number];
  if (opts.fonts) {
    fonts = [embedFont(add, opts.fonts.regular, "LiberationSans"), embedFont(add, opts.fonts.bold, "LiberationSans-Bold")];
  } else {
    fonts = [add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"), add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")];
  }
  const kids: number[] = [];
  for (const sheet of sheets) {
    const content = pageContent(sheet);
    const stream = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const W = n(sheet.width * PT_PER_MM);
    const H = n(sheet.height * PT_PER_MM);
    kids.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${fonts[0]} 0 R /F2 ${fonts[1]} 0 R >> >> /Contents ${stream} 0 R >>`));
  }
  objects[catalog - 1] = [`<< /Type /Catalog /Pages ${pages} 0 R >>`];
  objects[pages - 1] = [`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`];
  const info = add(`<< /Title (${pdfString(opts.title ?? "drawing")}) /Producer (Cocaide) /Creator (Cocaide drawing) >>`);

  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === "string" ? latin1(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  push("%PDF-1.4\n%âãÏÓ\n");
  const offsets: number[] = [];
  objects.forEach((parts, i) => {
    offsets.push(length);
    push(`${i + 1} 0 obj\n`);
    for (const p of parts) push(p);
    push("\nendobj\n");
  });
  const xref = length;
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) tail += `${String(o).padStart(10, "0")} 00000 n \n`;
  tail += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  push(tail);
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Each character one byte (they are all below 256 here). */
function latin1(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

/** A TrueType font as a PDF simple font in WinAnsiEncoding: its widths, descriptor and file. Returns the font's object number. */
function embedFont(add: (...parts: (string | Uint8Array)[]) => number, font: FontFile, name: string): number {
  const t = readTrueType(font.data);
  const k = 1000 / t.unitsPerEm;
  const widths: number[] = [];
  for (let code = 32; code <= 255; code++) {
    const u = winAnsiUnicode(code);
    const g = u === null ? 0 : (t.glyph(u) ?? 0);
    widths.push(Math.round(t.advance(g) * k));
  }
  const file = font.deflated
    ? add(`<< /Length ${font.deflated.length} /Length1 ${font.data.length} /Filter /FlateDecode >>\nstream\n`, font.deflated, "\nendstream")
    : add(`<< /Length ${font.data.length} /Length1 ${font.data.length} >>\nstream\n`, font.data, "\nendstream");
  const bbox = t.bbox.map((v) => Math.round(v * k)).join(" ");
  const descriptor = add(
    `<< /Type /FontDescriptor /FontName /${name} /Flags 32 /FontBBox [${bbox}] /ItalicAngle 0 /Ascent ${Math.round(t.ascent * k)} /Descent ${Math.round(t.descent * k)} /CapHeight ${Math.round(t.capHeight * k)} /StemV ${name.endsWith("Bold") ? 140 : 80} /FontFile2 ${file} 0 R >>`,
  );
  return add(`<< /Type /Font /Subtype /TrueType /BaseFont /${name} /FirstChar 32 /LastChar 255 /Widths [${widths.join(" ")}] /Encoding /WinAnsiEncoding /FontDescriptor ${descriptor} 0 R >>`);
}

/** The Unicode character a WinAnsi (Windows-1252) code is; null for the codes it leaves unused. */
export function winAnsiUnicode(code: number): number | null {
  if (code < 128 || code >= 160) return code;
  const map: Record<number, number> = {
    128: 0x20ac, 130: 0x201a, 131: 0x0192, 132: 0x201e, 133: 0x2026, 134: 0x2020, 135: 0x2021, 136: 0x02c6, 137: 0x2030, 138: 0x0160, 139: 0x2039, 140: 0x0152, 142: 0x017d,
    145: 0x2018, 146: 0x2019, 147: 0x201c, 148: 0x201d, 149: 0x2022, 150: 0x2013, 151: 0x2014, 152: 0x02dc, 153: 0x2122, 154: 0x0161, 155: 0x203a, 156: 0x0153, 158: 0x017e, 159: 0x0178,
  };
  return map[code] ?? null;
}

/** What a PDF needs from a TrueType file: glyphs by character, their advances, the font's box and heights. */
export function readTrueType(data: Uint8Array): { unitsPerEm: number; bbox: [number, number, number, number]; ascent: number; descent: number; capHeight: number; glyph(u: number): number | null; advance(g: number): number } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tables = new Map<string, number>();
  const count = view.getUint16(4);
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);
    tables.set(tag, view.getUint32(at + 8));
  }
  const need = (tag: string) => {
    const at = tables.get(tag);
    if (at === undefined) throw new Error(`the font has no ${tag} table`);
    return at;
  };
  const head = need("head");
  const unitsPerEm = view.getUint16(head + 18);
  const bbox: [number, number, number, number] = [view.getInt16(head + 36), view.getInt16(head + 38), view.getInt16(head + 40), view.getInt16(head + 42)];
  const hhea = need("hhea");
  const ascent = view.getInt16(hhea + 4);
  const descent = view.getInt16(hhea + 6);
  const metrics = view.getUint16(hhea + 34);
  const hmtx = need("hmtx");
  const os2 = tables.get("OS/2");
  const capHeight = os2 !== undefined && view.getUint16(os2) >= 2 ? view.getInt16(os2 + 88) : Math.round(ascent * 0.72);
  // cmap: the Windows Unicode (3,1) subtable, format 4.
  const cmap = need("cmap");
  let sub = -1;
  for (let i = 0; i < view.getUint16(cmap + 2); i++) {
    const at = cmap + 4 + i * 8;
    if (view.getUint16(at) === 3 && view.getUint16(at + 2) === 1) sub = cmap + view.getUint32(at + 4);
  }
  if (sub < 0 || view.getUint16(sub) !== 4) throw new Error("the font has no Unicode character map (format 4)");
  const segs = view.getUint16(sub + 6) / 2;
  const ends = sub + 14;
  const starts = ends + segs * 2 + 2;
  const deltas = starts + segs * 2;
  const ranges = deltas + segs * 2;
  const glyph = (u: number): number | null => {
    for (let i = 0; i < segs; i++) {
      const end = view.getUint16(ends + i * 2);
      if (u > end) continue;
      const start = view.getUint16(starts + i * 2);
      if (u < start) return null;
      const delta = view.getInt16(deltas + i * 2);
      const range = view.getUint16(ranges + i * 2);
      if (range === 0) return (u + delta) & 0xffff;
      const g = view.getUint16(ranges + i * 2 + range + (u - start) * 2);
      return g === 0 ? null : (g + delta) & 0xffff;
    }
    return null;
  };
  const advance = (g: number) => view.getUint16(hmtx + Math.min(g, metrics - 1) * 4);
  return { unitsPerEm, bbox, ascent, descent, capHeight, glyph, advance };
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
      const code = WIN_ANSI[ch] ?? (c >= 160 && c <= 255 ? c : 63); // "?" for what the font can't show
      out += `\\${code.toString(8).padStart(3, "0")}`;
    }
  }
  return out;
}

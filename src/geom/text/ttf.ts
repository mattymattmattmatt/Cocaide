// A small TrueType reader: enough of a .ttf to take glyph outlines out of it
// (the head, hhea, maxp, cmap format 4, hmtx, loca and glyf tables; simple
// and composite glyphs). It is what scripts/build-font.ts runs over the
// bundled font to write the outline data the app uses (fontData.ts), and the
// tests read the font with it too. Written here rather than taking a font
// library as a dependency: the app needs outlines only (no hinting, no
// shaping, no kerning tables), and this is a few hundred lines with no
// runtime cost (the outlines are read at build time).
//
// Pure: it works on bytes (a Uint8Array), no file system.

/** One point of a glyph's contour, in font units; `on`: on the curve (else a quadratic control point). */
export interface TtfPoint {
  x: number;
  y: number;
  on: boolean;
}

export interface TtfGlyph {
  /** How far the pen moves after it, font units. */
  advance: number;
  /** Closed contours, each a list of points (TrueType quadratic outlines). */
  contours: TtfPoint[][];
}

export interface TtfFont {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  /** The glyph index of a character code (0, the missing glyph, when it has none). */
  glyphIndex(code: number): number;
  glyph(index: number): TtfGlyph;
}

export class TtfError extends Error {}

/** Reads a TrueType font's tables. */
export function readTtf(bytes: Uint8Array): TtfFont {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number) => view.getUint16(o);
  const i16 = (o: number) => view.getInt16(o);
  const u32 = (o: number) => view.getUint32(o);
  const tables = new Map<string, number>();
  const n = u16(4);
  for (let i = 0; i < n; i++) {
    const at = 12 + 16 * i;
    const tag = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    tables.set(tag, u32(at + 8));
  }
  const table = (tag: string) => {
    const t = tables.get(tag);
    if (t === undefined) throw new TtfError(`the font has no "${tag}" table (a TrueType font with glyf outlines is needed)`);
    return t;
  };
  const head = table("head");
  const unitsPerEm = u16(head + 18);
  const longLoca = i16(head + 50) === 1;
  const hhea = table("hhea");
  const ascender = i16(hhea + 4);
  const descender = i16(hhea + 6);
  const metrics = u16(hhea + 34);
  const numGlyphs = u16(table("maxp") + 4);
  const hmtx = table("hmtx");
  const loca = table("loca");
  const glyf = table("glyf");

  // cmap: the Windows Unicode BMP subtable, format 4.
  const cmap = table("cmap");
  let sub = -1;
  for (let i = 0; i < u16(cmap + 2); i++) {
    const at = cmap + 4 + 8 * i;
    if (u16(at) === 3 && (u16(at + 2) === 1 || u16(at + 2) === 0)) sub = cmap + u32(at + 4);
  }
  if (sub < 0 || u16(sub) !== 4) throw new TtfError("the font has no Unicode character map (cmap format 4)");
  const segs = u16(sub + 6) / 2;
  const ends = sub + 14;
  const starts = ends + 2 * segs + 2;
  const deltas = starts + 2 * segs;
  const offsets = deltas + 2 * segs;
  const glyphIndex = (code: number): number => {
    for (let i = 0; i < segs; i++) {
      if (u16(ends + 2 * i) < code) continue;
      const start = u16(starts + 2 * i);
      if (start > code) return 0;
      const ro = u16(offsets + 2 * i);
      if (ro === 0) return (code + i16(deltas + 2 * i)) & 0xffff;
      const g = u16(offsets + 2 * i + ro + 2 * (code - start));
      return g === 0 ? 0 : (g + i16(deltas + 2 * i)) & 0xffff;
    }
    return 0;
  };
  const advance = (g: number) => u16(hmtx + 4 * Math.min(g, metrics - 1));
  const locaAt = (g: number) => (longLoca ? u32(loca + 4 * g) : 2 * u16(loca + 2 * g));

  const glyph = (index: number, depth = 0): TtfGlyph => {
    if (index < 0 || index >= numGlyphs) throw new TtfError(`no glyph ${index}`);
    const start = locaAt(index);
    const end = locaAt(index + 1);
    const out: TtfGlyph = { advance: advance(index), contours: [] };
    if (end <= start) return out; // a blank (the space)
    const at = glyf + start;
    const nContours = i16(at);
    if (nContours >= 0) {
      const endPts: number[] = [];
      for (let i = 0; i < nContours; i++) endPts.push(u16(at + 10 + 2 * i));
      const nPts = nContours ? endPts[nContours - 1] + 1 : 0;
      let p = at + 10 + 2 * nContours;
      p += 2 + u16(p); // instructions
      const flags: number[] = [];
      while (flags.length < nPts) {
        const f = bytes[p++];
        flags.push(f);
        if (f & 8) {
          const r = bytes[p++];
          for (let k = 0; k < r; k++) flags.push(f);
        }
      }
      const coords = (short: number, same: number): number[] => {
        const v: number[] = [];
        let c = 0;
        for (const f of flags) {
          if (f & short) {
            const d = bytes[p++];
            c += f & same ? d : -d;
          } else if (!(f & same)) {
            c += i16(p);
            p += 2;
          }
          v.push(c);
        }
        return v;
      };
      const xs = coords(2, 16);
      const ys = coords(4, 32);
      let k = 0;
      for (const e of endPts) {
        const contour: TtfPoint[] = [];
        for (; k <= e; k++) contour.push({ x: xs[k], y: ys[k], on: (flags[k] & 1) === 1 });
        if (contour.length) out.contours.push(contour);
      }
      return out;
    }
    // A composite: other glyphs placed (moved, perhaps scaled).
    if (depth > 8) throw new TtfError("a composite glyph nests too deep");
    let p = at + 10;
    for (;;) {
      const flags = u16(p);
      const part = u16(p + 2);
      p += 4;
      let dx: number;
      let dy: number;
      if (flags & 1) {
        dx = i16(p);
        dy = i16(p + 2);
        p += 4;
      } else {
        dx = view.getInt8(p);
        dy = view.getInt8(p + 1);
        p += 2;
      }
      let a = 1;
      let b = 0;
      let c = 0;
      let d = 1;
      const f2 = (o: number) => i16(o) / 16384;
      if (flags & 8) {
        a = d = f2(p);
        p += 2;
      } else if (flags & 0x40) {
        a = f2(p);
        d = f2(p + 2);
        p += 4;
      } else if (flags & 0x80) {
        a = f2(p);
        b = f2(p + 2);
        c = f2(p + 4);
        d = f2(p + 6);
        p += 8;
      }
      // Offsets as point numbers (args not XY values) are rare in Latin fonts: taken as 0.
      if (!(flags & 2)) dx = dy = 0;
      for (const contour of glyph(part, depth + 1).contours) out.contours.push(contour.map((q) => ({ x: a * q.x + c * q.y + dx, y: b * q.x + d * q.y + dy, on: q.on })));
      if (!(flags & 0x20)) break;
    }
    return out;
  };
  return { unitsPerEm, ascender, descender, glyphIndex, glyph: (i) => glyph(i) };
}

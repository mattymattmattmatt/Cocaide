// The sheet's zoom and pan (Phase Q wave Q2B), as pure maths so it can be
// tested: the part of the sheet shown is a view box in SVG units (mm, y
// down, the sheet's top left at 0,0), always the shape of the host so one
// screen pixel is the same length across and down. Zooming keeps the point
// under the cursor where it is; Fit (F) shows the whole sheet with a margin;
// zoom to area fills the host with a dragged box.

/** x, y (top left, SVG units: mm, y down), width, height. */
export type ViewBox = [number, number, number, number];

/** How far in and out the sheet zooms: a box at most this many sheets wide, at least this many mm. */
export const ZOOM_LIMITS = { minWidth: 4, maxSheets: 6 } as const;

/** The whole sheet, centred in a host of this shape, with `margin` of the host round it (a fraction of the smaller side). */
export function fitBox(sheetW: number, sheetH: number, hostW: number, hostH: number, margin = 0.04): ViewBox {
  const aspect = hostW > 0 && hostH > 0 ? hostW / hostH : sheetW / sheetH;
  const m = 2 * margin;
  let w = sheetW * (1 + m);
  let h = sheetH * (1 + m);
  if (w / h > aspect) h = w / aspect;
  else w = h * aspect;
  return [(sheetW - w) / 2, (sheetH - h) / 2, w, h];
}

/** The box reshaped to a host's aspect about its centre (a resize): the same width shown. */
export function reshape(box: ViewBox, hostW: number, hostH: number): ViewBox {
  if (hostW <= 0 || hostH <= 0) return box;
  const [x, y, w, h] = box;
  const nh = (w * hostH) / hostW;
  return [x, y + (h - nh) / 2, w, nh];
}

/**
 * Zoom by `factor` (above 1 zooms in) about `p` (SVG units): `p` stays where
 * it is on the screen. The width is kept within the limits for a sheet `sheetW` wide.
 */
export function zoomAt(box: ViewBox, p: [number, number], factor: number, sheetW: number): ViewBox {
  const [x, y, w, h] = box;
  const nw = Math.min(Math.max(w / factor, ZOOM_LIMITS.minWidth), sheetW * ZOOM_LIMITS.maxSheets);
  const s = nw / w;
  return [p[0] - (p[0] - x) * s, p[1] - (p[1] - y) * s, nw, h * s];
}

/** Pan by a pointer move of (dx, dy) screen pixels in a host `hostW` pixels wide: the sheet follows the pointer. */
export function panBy(box: ViewBox, dx: number, dy: number, hostW: number): ViewBox {
  const k = box[2] / hostW;
  return [box[0] - dx * k, box[1] - dy * k, box[2], box[3]];
}

/** The box that fills a host with the area between two corners (SVG units), kept to the host's shape; null when the area is too small to mean one. */
export function areaBox(a: [number, number], b: [number, number], hostW: number, hostH: number, min = 1): ViewBox | null {
  const w = Math.abs(b[0] - a[0]);
  const h = Math.abs(b[1] - a[1]);
  if (w < min && h < min) return null;
  const cx = (a[0] + b[0]) / 2;
  const cy = (a[1] + b[1]) / 2;
  const aspect = hostW / hostH;
  let bw = Math.max(w, ZOOM_LIMITS.minWidth);
  let bh = h;
  if (bw / Math.max(bh, 1e-9) > aspect) bh = bw / aspect;
  else bw = bh * aspect;
  return [cx - bw / 2, cy - bh / 2, bw, bh];
}

/** A host pixel (from its top left) in SVG units: the box fills the host exactly (same shape). */
export function toUser(box: ViewBox, hostW: number, px: number, py: number): [number, number] {
  const k = box[2] / hostW;
  return [box[0] + px * k, box[1] + py * k];
}

/** A point in SVG units as host pixels. */
export function toHost(box: ViewBox, hostW: number, ux: number, uy: number): [number, number] {
  const k = hostW / box[2];
  return [(ux - box[0]) * k, (uy - box[1]) * k];
}

/** Sheet mm per screen pixel: how big a glyph of n pixels is on the sheet. */
export function mmPerPixel(box: ViewBox, hostW: number): number {
  return hostW > 0 ? box[2] / hostW : 1;
}

/** The zoom as the status bar says it: 100 % is the sheet's real size on a 96 dpi screen. */
export function zoomPercent(box: ViewBox, hostW: number): number {
  const pxPerMm = hostW / box[2];
  return Math.round((pxPerMm / (96 / 25.4)) * 100);
}

/** A smooth step from one box to another (t from 0 to 1, eased), for Fit and zoom to area. */
export function blendBox(a: ViewBox, b: ViewBox, t: number): ViewBox {
  const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  return [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, a[2] + (b[2] - a[2]) * e, a[3] + (b[3] - a[3]) * e];
}

// PNG encoding for rendered images (Node only: uses node:zlib).

import { crc32, deflateSync } from "node:zlib";
import type { Image } from "./raster";

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An 8-bit RGB PNG (alpha is dropped: renders are opaque). */
export function encodePNG(img: Image): Uint8Array {
  const { width, height, data } = img;
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let r = 0; r < height; r++) {
    const row = r * (stride + 1);
    raw[row] = 1; // Sub filter: smooth gradients compress well
    for (let c = 0; c < width; c++) {
      for (let k = 0; k < 3; k++) {
        const v = data[(r * width + c) * 4 + k];
        const left = c > 0 ? data[(r * width + c - 1) * 4 + k] : 0;
        raw[row + 1 + c * 3 + k] = (v - left) & 0xff;
      }
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array(0))]);
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}

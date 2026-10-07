// A small PNG decoder (8-bit greyscale, RGB, RGBA, grey+alpha; no
// interlacing, no palettes), for reading drawing scans outside a browser.
// Uses DecompressionStream, so it runs in Node and the browser alike.

import type { Image } from "./raster";

export async function decodePNG(bytes: Uint8Array): Promise<Image> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== 0x89504e47) throw new Error("not a PNG");
  let at = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  let interlace = 0;
  const idat: Uint8Array[] = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      const h = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = h.getUint32(0);
      height = h.getUint32(4);
      depth = body[8];
      colour = body[9];
      interlace = body[12];
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colour];
  if (depth !== 8 || !channels || interlace) throw new Error(`unsupported PNG (depth ${depth}, colour type ${colour}, interlace ${interlace})`);
  const stream = new Blob(idat as BlobPart[]).stream().pipeThrough(new DecompressionStream("deflate"));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());

  const stride = width * channels;
  const px = new Uint8Array(stride * height);
  for (let r = 0; r < height; r++) {
    const filter = raw[r * (stride + 1)];
    const src = raw.subarray(r * (stride + 1) + 1, (r + 1) * (stride + 1));
    const out = px.subarray(r * stride, (r + 1) * stride);
    const prev = r > 0 ? px.subarray((r - 1) * stride, r * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[i] = v & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const grey = channels <= 2;
    data[i * 4] = px[s];
    data[i * 4 + 1] = grey ? px[s] : px[s + 1];
    data[i * 4 + 2] = grey ? px[s] : px[s + 2];
    data[i * 4 + 3] = channels === 4 ? px[s + 3] : channels === 2 ? px[s + 1] : 255;
  }
  return { width, height, data };
}

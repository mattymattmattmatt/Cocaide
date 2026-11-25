// A small .glb for tests: a box (w × h × d, glTF Y up, metres) with texture coordinates, one material with a base
// colour factor and an embedded 2 × 2 PNG texture, under a node moved by `at`.

/** A 2 × 2 PNG (red, green, blue, white). */
export const PNG_2X2 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwPCfgYGBgYGBAQAa/wP9g8m6WAAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

export function boxGlb(w = 2, h = 0.5, d = 1, at: [number, number, number] = [0, 0, 0], opts: { color?: number[]; texture?: boolean; padding?: number } = {}): Uint8Array {
  const [x, y, z] = [w / 2, h / 2, d / 2];
  // Each face its own 4 corners (so it has its own uvs and normal).
  const faces: { n: number[]; c: number[][] }[] = [
    { n: [0, 0, 1], c: [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]] },
    { n: [0, 0, -1], c: [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]] },
    { n: [1, 0, 0], c: [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]] },
    { n: [-1, 0, 0], c: [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]] },
    { n: [0, 1, 0], c: [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]] },
    { n: [0, -1, 0], c: [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]] },
  ];
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  faces.forEach((f, i) => {
    for (const p of f.c) pos.push(...p);
    for (let k = 0; k < 4; k++) nor.push(...f.n);
    uv.push(0, 1, 1, 1, 1, 0, 0, 0);
    idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
  });
  const texture = opts.texture ?? true;
  const pad4 = (n: number) => (4 - (n % 4)) % 4;
  const parts: Uint8Array[] = [];
  const views: Record<string, unknown>[] = [];
  let off = 0;
  const add = (bytes: Uint8Array) => {
    views.push({ buffer: 0, byteOffset: off, byteLength: bytes.length });
    parts.push(bytes);
    const p = pad4(bytes.length);
    if (p) parts.push(new Uint8Array(p));
    off += bytes.length + p;
    return views.length - 1;
  };
  const f32 = (a: number[]) => new Uint8Array(new Float32Array(a).buffer);
  const vPos = add(f32(pos));
  const vNor = add(f32(nor));
  const vUv = add(f32(uv));
  const vIdx = add(new Uint8Array(new Uint16Array(idx).buffer));
  const vImg = texture ? add(PNG_2X2) : -1;
  // Bytes nothing uses (random, so they don't compress): to make a big file for tests of big files.
  if (opts.padding) {
    const junk = new Uint8Array(opts.padding);
    for (let i = 0; i < junk.length; i += 65536) crypto.getRandomValues(junk.subarray(i, Math.min(junk.length, i + 65536)));
    add(junk);
  }
  const n = pos.length / 3;
  const json = {
    asset: { version: "2.0", generator: "cocaide test" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ translation: at, children: [1] }, { mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    accessors: [
      { bufferView: vPos, componentType: 5126, count: n, type: "VEC3", min: [-x, -y, -z], max: [x, y, z] },
      { bufferView: vNor, componentType: 5126, count: n, type: "VEC3" },
      { bufferView: vUv, componentType: 5126, count: n, type: "VEC2" },
      { bufferView: vIdx, componentType: 5123, count: idx.length, type: "SCALAR" },
    ],
    bufferViews: views,
    buffers: [{ byteLength: off }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: opts.color ?? [1, 1, 1, 1], ...(texture ? { baseColorTexture: { index: 0 } } : {}) }, doubleSided: true }],
    ...(texture ? { textures: [{ source: 0 }], images: [{ bufferView: vImg, mimeType: "image/png" }] } : {}),
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jp = pad4(jsonBytes.length);
  if (jp) jsonBytes = Uint8Array.from([...jsonBytes, ...new Array(jp).fill(0x20)]);
  const bin = new Uint8Array(off);
  let o = 0;
  for (const p of parts) {
    bin.set(p, o);
    o += p.length;
  }
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  const b = 20 + jsonBytes.length;
  dv.setUint32(b, bin.length, true);
  dv.setUint32(b + 4, 0x004e4942, true);
  out.set(bin, b + 8);
  return out;
}

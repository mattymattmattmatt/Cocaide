// Is a drawing scan sharp enough to read numbers from? A model reading a
// blurry scan can be confidently wrong, so this is measured on the pixels,
// in code: line art that is in focus has solid black ink with hard edges; a
// blurred scan has only grey smudges. Below the threshold every number read
// from the drawing is a blank the user fills (spec Phase F).

export interface Legibility {
  /** 0 to 1. */
  score: number;
  /** The scan is too blurry or faint to trust any number read from it. */
  blurry: boolean;
  /** Paper luminance minus the darkest ink (0 to 255). */
  contrast: number;
  /** Of the ink, the share that is solid (near the darkest), not grey blur. */
  solidInk: number;
}

export const LEGIBLE = 0.5;

/** RGBA pixels, row-major. Large images are sampled on a grid (every `step` pixels). */
export function legibility(data: Uint8Array | Uint8ClampedArray, width: number, height: number): Legibility {
  const n = width * height;
  const step = Math.max(1, Math.floor(Math.sqrt(n / 2_000_000)));
  const lum: number[] = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      lum.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    }
  }
  const sorted = Float64Array.from(lum).sort();
  const paper = sorted[Math.floor(0.9 * (sorted.length - 1))];
  const ink = sorted[Math.floor(0.0005 * (sorted.length - 1))];
  const contrast = paper - ink;
  let any = 0;
  let solid = 0;
  for (const v of lum) {
    if (v < paper - 0.25 * contrast) any++;
    if (v < ink + 0.25 * contrast) solid++;
  }
  const solidInk = any ? solid / any : 0;
  const score = Math.min(1, contrast / 200) * Math.min(1, solidInk / 0.3);
  return { score, blurry: score < LEGIBLE, contrast, solidInk };
}

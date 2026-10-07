// Is a dropped image a drawing or a photo? A first guess from the pixels, for
// the user to switch: a drawing is mostly bright, colourless paper; a photo
// is coloured and tonal.

export type ImageKind = "drawing" | "photo";

export function guessKind(data: Uint8ClampedArray | Uint8Array, width: number, height: number): ImageKind {
  const step = Math.max(1, Math.floor((width * height) / 200_000));
  const lums: number[] = [];
  let saturation = 0;
  for (let i = 0; i < width * height; i += step) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const max = Math.max(r, g, b);
    saturation += max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
    lums.push(0.299 * r + 0.587 * g + 0.114 * b);
  }
  if (!lums.length) return "drawing";
  const sorted = [...lums].sort((a, b) => a - b);
  const paper = sorted[Math.floor(sorted.length * 0.95)];
  const onPaper = lums.filter((l) => l >= paper - 30).length / lums.length;
  return paper >= 150 && saturation / lums.length <= 0.12 && onPaper >= 0.5 ? "drawing" : "photo";
}

// Words to lines that fit a width: a note on a pin, sized to what it says. Breaks between words (a word too long for a
// line on its own is split), keeps the writer's own line breaks, and stops at a number of lines with "…". Pure: the
// width of a piece of text comes from `measure` (a canvas's measureText in the browser).

export function wrapText(text: string, maxWidth: number, measure: (s: string) => number, maxLines = 8): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r/g, "").split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      if (out.length) out.push("");
      continue;
    }
    let line = "";
    for (let w of words) {
      // A word wider than a line: split it, a line's worth at a time.
      while (measure(w) > maxWidth) {
        if (line) {
          out.push(line);
          line = "";
        }
        let n = w.length - 1;
        while (n > 1 && measure(w.slice(0, n)) > maxWidth) n--;
        out.push(w.slice(0, n));
        w = w.slice(n);
      }
      const next = line ? `${line} ${w}` : w;
      if (measure(next) <= maxWidth) line = next;
      else {
        out.push(line);
        line = w;
      }
    }
    if (line) out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  if (out.length <= maxLines) return out;
  const kept = out.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && measure(`${last}…`) > maxWidth) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last.trimEnd()}…`;
  return kept;
}

/**
 * The width to wrap a note at so it reads as a block rather than a ribbon: a short note on one line, a longer one
 * about twice as wide as it is tall (in lines of `lineHeight`), never wider than `maxWidth`.
 */
export function noteWidth(text: string, measure: (s: string) => number, lineHeight: number, maxWidth: number, minWidth: number): number {
  const whole = Math.max(...text.split("\n").map((l) => measure(l.trim())), 0);
  if (whole <= minWidth * 1.6) return Math.max(minWidth, whole);
  // Width w gives about whole / w lines, each lineHeight tall: w / (lines × lineHeight) ≈ 2.6 at w = √(2.6 · whole · lineHeight).
  return Math.min(maxWidth, Math.max(minWidth, Math.sqrt(2.6 * whole * lineHeight)));
}

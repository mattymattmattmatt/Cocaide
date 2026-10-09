// Names the model tools give what they make.

/** The first free body name of the form body_1, body_2, ... */
export function nextBodyName(taken: string[]): string {
  for (let n = 1; ; n++) if (!taken.includes(`body_${n}`)) return `body_${n}`;
}

/** A coordinate as the document keeps it: 3 decimals, no -0. */
export const round3 = (x: number) => Math.round(x * 1000) / 1000 + 0;

/** A direction component as the document keeps it: 9 decimals, no -0. */
export const round9 = (x: number) => Math.round(x * 1e9) / 1e9 + 0;

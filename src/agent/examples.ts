// The example parts, read from the examples folder: what { "example": name }
// inserts in an assembly (the app has the same ones in its Examples menu).

import { readdirSync, readFileSync } from "node:fs";

let cache: Record<string, string> | null = null;

/** Each example part's text, by name ("bracket", "flange", "mounting-plate" ...). */
export function exampleParts(): Record<string, string> {
  if (cache) return cache;
  const out: Record<string, string> = {};
  try {
    const dir = new URL("../../examples/", import.meta.url);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".cocaide.json")) continue;
      out[f.replace(/\.cocaide\.json$/, "")] = readFileSync(new URL(f, dir), "utf8");
    }
  } catch {
    // No examples folder (a packaged bridge): none.
  }
  cache = out;
  return out;
}

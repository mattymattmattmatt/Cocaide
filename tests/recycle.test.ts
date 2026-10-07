import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { heapBytes, loadOC, rebuild, recycleOC } from "../src/kernel";

const plate = JSON.parse(readFileSync(new URL("../examples/mounting-plate.cocaide.json", import.meta.url), "utf8"));

it("swaps in a fresh kernel with an empty heap that rebuilds identically", async () => {
  const first = await loadOC();
  const before = rebuild(plate, first);
  const volume = before.measurements!.volume;
  before.dispose();
  for (let i = 0; i < 30; i++) rebuild(plate, first).dispose();
  const grown = heapBytes(first);

  const fresh = await recycleOC();
  expect(fresh).not.toBe(first);
  expect(await loadOC()).toBe(fresh);
  expect(heapBytes(fresh)).toBeLessThan(grown);

  const after = rebuild(plate, fresh);
  try {
    expect(after.errors).toEqual([]);
    expect(after.measurements!.volume).toBe(volume);
  } finally {
    after.dispose();
  }
});

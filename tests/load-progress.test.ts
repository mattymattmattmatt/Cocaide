// The load bar's sums: what is loading, and how far.
import { describe, expect, it } from "vitest";
import { loadProgress } from "../src/ui/loadProgress";

const idle = { fetching: false, kernelLoading: false, building: false, parts: null };

describe("loadProgress", () => {
  it("is idle when nothing is loading", () => {
    expect(loadProgress(idle)).toMatchObject({ active: false });
    expect(loadProgress({ ...idle, parts: { done: 7, total: 7 } })).toMatchObject({ active: false });
  });
  it("can't tell how far while the file downloads or the kernel loads, or a part builds", () => {
    expect(loadProgress({ ...idle, fetching: true, kernelLoading: true })).toEqual({ active: true, fraction: null, label: "Downloading the file…" });
    expect(loadProgress({ ...idle, kernelLoading: true, parts: { done: 0, total: 5 } })).toMatchObject({ active: true, fraction: null, label: "Loading the modelling kernel…" });
    expect(loadProgress({ ...idle, building: true })).toMatchObject({ active: true, fraction: null, label: "Building…" });
  });
  it("fills as an assembly's parts come in, with a sliver before the first", () => {
    expect(loadProgress({ ...idle, parts: { done: 0, total: 7 } })).toEqual({ active: true, fraction: 0.04, label: "Building part 1 of 7…" });
    expect(loadProgress({ ...idle, parts: { done: 3, total: 4 } })).toEqual({ active: true, fraction: 0.75, label: "Building part 4 of 4…" });
  });
  it("follows the assembly's parts, not the part's own rebuild, when an assembly is on screen", () => {
    expect(loadProgress({ ...idle, building: true, parts: { done: 2, total: 2 } })).toMatchObject({ active: false });
  });
});

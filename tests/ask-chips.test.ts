// The ask card's chips show off the build tools: rib, shell, revolve, spring.
import { describe, expect, it } from "vitest";
import { scopedActions } from "../src/ask/prompt";

const labels = (k: Parameters<typeof scopedActions>[0]) => scopedActions(k).map((a) => a.label);

describe("ask chips", () => {
  it("a face offers a rib, a shell, a draft and a spring", () => {
    expect(labels("face")).toEqual(expect.arrayContaining(["Add a rib here", "Shell this body 2 mm", "Draft this face", "Make this a spring"]));
    const shell = scopedActions("face").find((a) => a.label === "Shell this body 2 mm")!;
    expect(shell.submit).toBe(true); // complete as it is
    expect(scopedActions("face").find((a) => a.label === "Add a rib here")!.submit).toBe(false); // the user finishes it
  });

  it("a sketch offers revolve and spring; a body offers shell; the part offers a turned part and a spring", () => {
    expect(labels("sketch")).toEqual(expect.arrayContaining(["Revolve this profile", "Make this a spring"]));
    expect(labels("body")).toContain("Shell this body 2 mm");
    expect(labels("part")).toEqual(expect.arrayContaining(["Revolve a turned part", "Make a spring"]));
  });

  it("every chip has a label, and an unsubmitted chip leaves room to type", () => {
    for (const k of ["face", "edge", "sketch", "entity", "body", "part"] as const)
      for (const a of scopedActions(k)) {
        expect(a.label.length).toBeGreaterThan(0);
        if (a.submit) expect(a.prompt.trim().length).toBeGreaterThan(0);
      }
  });
});

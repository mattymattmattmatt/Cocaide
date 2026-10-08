// The keyboard and mouse settings: SOLIDWORKS's defaults, keys read the same
// whatever the layout's shift does, a rebinding takes the key from whatever
// would clash, and the wheel zooms the way SOLIDWORKS does unless reversed.

import { afterEach, describe, expect, it } from "vitest";
import { bindKey, clashes, COMMANDS, inputPrefs, keyFor, keyOf, resetInputPrefs, setInputPrefs, wheelZoom } from "../src/ui/input";

const press = (code: string, key: string, mods: Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>> = {}) =>
  ({ code, key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods }) as KeyboardEvent;
const wheel = (deltaY: number, ctrlKey = false) => ({ deltaY, deltaMode: 0, ctrlKey }) as WheelEvent;

afterEach(() => resetInputPrefs());

describe("the defaults are SOLIDWORKS's", () => {
  it("binds the standard views to Ctrl+1–8, and F, Z, Space and S", () => {
    expect(["front", "back", "left", "right", "top", "bottom", "iso", "normal"].map((v) => keyFor(`view.${v}`))).toEqual(["Ctrl+1", "Ctrl+2", "Ctrl+3", "Ctrl+4", "Ctrl+5", "Ctrl+6", "Ctrl+7", "Ctrl+8"]);
    expect([keyFor("view.fit"), keyFor("view.zoomIn"), keyFor("view.zoomOut"), keyFor("view.orientation"), keyFor("shortcutBar")]).toEqual(["F", "Shift+Z", "Z", "Space", "S"]);
  });

  it("puts no two live commands on one key", () => {
    const seen = new Map<string, (typeof COMMANDS)[number]>();
    for (const c of COMMANDS) {
      if (!c.key) continue;
      const other = seen.get(c.key);
      if (other) expect(clashes(other.group, c.group), `${c.key}: ${other.id} and ${c.id}`).toBe(false);
      seen.set(c.key, c);
    }
  });
});

describe("keys", () => {
  it("reads a press the way the bindings are written", () => {
    expect(keyOf(press("Digit1", "!", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+1");
    expect(keyOf(press("KeyZ", "Z", { shiftKey: true }))).toBe("Shift+Z");
    expect(keyOf(press("Space", " "))).toBe("Space");
    expect(keyOf(press("ArrowLeft", "ArrowLeft", { altKey: true }))).toBe("Alt+ArrowLeft");
    expect(keyOf(press("KeyS", "s", { metaKey: true }))).toBe("Ctrl+S");
    expect(keyOf(press("ShiftLeft", "Shift", { shiftKey: true }))).toBeNull();
  });

  it("rebinds: the key moves, and a command that would clash loses it; a sketch tool may share a model tool's key", () => {
    expect(bindKey("tool.extrude", "F")).toBe("Zoom to fit");
    expect(keyFor("tool.extrude")).toBe("F");
    expect(keyFor("view.fit")).toBeNull();
    expect(bindKey("tool.cut", "L")).toBeNull();
    expect(keyFor("sketch.line")).toBe("L");
    bindKey("view.front", null);
    expect(keyFor("view.front")).toBeNull();
    resetInputPrefs();
    expect(keyFor("view.fit")).toBe("F");
    expect(inputPrefs().keys).toEqual({});
  });
});

describe("the wheel", () => {
  it("zooms in rolled toward you, as SOLIDWORKS does; reversed, away from you; a pinch spreads to zoom in either way", () => {
    expect(wheelZoom(wheel(100))).toBeGreaterThan(1);
    expect(wheelZoom(wheel(-100))).toBeLessThan(1);
    setInputPrefs({ ...inputPrefs(), reverseWheel: true });
    expect(wheelZoom(wheel(100))).toBeLessThan(1);
    expect(wheelZoom(wheel(-10, true))).toBeGreaterThan(1);
    setInputPrefs({ ...inputPrefs(), reverseWheel: false, mouse: "trackpad" });
    expect(wheelZoom(wheel(-100))).toBeGreaterThan(1);
  });
});

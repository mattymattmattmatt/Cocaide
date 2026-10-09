// How the mouse and keyboard drive the app: SOLIDWORKS's defaults, changed in
// Settings and kept in this browser. Every keyboard command is listed here
// with its default key; each part of the app handles the commands it owns
// through useCommands(), so a rebinding in Settings applies everywhere at once.

import { useEffect, useRef, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type WheelEvent as ReactWheelEvent } from "react";

/** How the mouse moves the 3D view. */
export type MouseScheme = "solidworks" | "trackpad";

export const COMMAND_GROUPS = ["General", "View", "Model tools", "Sketch"] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

export interface CommandDef {
  id: string;
  label: string;
  group: CommandGroup;
  /** SOLIDWORKS's key for it, or ours where it has none; null: unbound until you bind it. */
  key: string | null;
  /**
   * Listed ahead of its tool, so that its id and key are taken: Settings leaves
   * it out until the tool that runs it lands (that change drops this flag).
   */
  planned?: true;
}

/**
 * Every command a key can run. The view keys are SOLIDWORKS's defaults.
 * Ctrl+N, Ctrl+T and Ctrl+W belong to the browser and can't be taken.
 */
export const COMMANDS: CommandDef[] = [
  { id: "save", label: "Save", group: "General", key: "Ctrl+S" },
  { id: "open", label: "Open a part", group: "General", key: "Ctrl+O" },
  { id: "new", label: "New part", group: "General", key: null },
  { id: "undo", label: "Undo", group: "General", key: "Ctrl+Z" },
  { id: "redo", label: "Redo", group: "General", key: "Ctrl+Y" },
  { id: "delete", label: "Delete the selected feature", group: "General", key: "Delete" },
  { id: "repeat", label: "Repeat the last tool", group: "General", key: "Enter" },
  { id: "shortcutBar", label: "Shortcut bar: tools at the pointer", group: "General", key: "S" },
  { id: "toggleTree", label: "Show or hide the left column", group: "General", key: "F9" },
  { id: "settings", label: "Settings", group: "General", key: null },

  { id: "view.front", label: "Front", group: "View", key: "Ctrl+1" },
  { id: "view.back", label: "Back", group: "View", key: "Ctrl+2" },
  { id: "view.left", label: "Left", group: "View", key: "Ctrl+3" },
  { id: "view.right", label: "Right", group: "View", key: "Ctrl+4" },
  { id: "view.top", label: "Top", group: "View", key: "Ctrl+5" },
  { id: "view.bottom", label: "Bottom", group: "View", key: "Ctrl+6" },
  { id: "view.iso", label: "Isometric", group: "View", key: "Ctrl+7" },
  { id: "view.normal", label: "Normal to the selected face", group: "View", key: "Ctrl+8" },
  { id: "view.orientation", label: "View orientation menu", group: "View", key: "Space" },
  { id: "view.fit", label: "Zoom to fit", group: "View", key: "F" },
  { id: "view.zoomIn", label: "Zoom in", group: "View", key: "Shift+Z" },
  { id: "view.zoomOut", label: "Zoom out", group: "View", key: "Z" },
  { id: "view.rotateLeft", label: "Rotate left 15°", group: "View", key: "ArrowLeft" },
  { id: "view.rotateRight", label: "Rotate right 15°", group: "View", key: "ArrowRight" },
  { id: "view.rotateUp", label: "Rotate up 15°", group: "View", key: "ArrowUp" },
  { id: "view.rotateDown", label: "Rotate down 15°", group: "View", key: "ArrowDown" },
  { id: "view.rotateLeft90", label: "Rotate left 90°", group: "View", key: "Shift+ArrowLeft" },
  { id: "view.rotateRight90", label: "Rotate right 90°", group: "View", key: "Shift+ArrowRight" },
  { id: "view.rotateUp90", label: "Rotate up 90°", group: "View", key: "Shift+ArrowUp" },
  { id: "view.rotateDown90", label: "Rotate down 90°", group: "View", key: "Shift+ArrowDown" },
  { id: "view.panLeft", label: "Pan left", group: "View", key: "Ctrl+ArrowLeft" },
  { id: "view.panRight", label: "Pan right", group: "View", key: "Ctrl+ArrowRight" },
  { id: "view.panUp", label: "Pan up", group: "View", key: "Ctrl+ArrowUp" },
  { id: "view.panDown", label: "Pan down", group: "View", key: "Ctrl+ArrowDown" },
  { id: "view.rollLeft", label: "Roll anticlockwise 15°", group: "View", key: "Alt+ArrowLeft" },
  { id: "view.rollRight", label: "Roll clockwise 15°", group: "View", key: "Alt+ArrowRight" },
  { id: "view.planes", label: "Show or hide planes, axes and points", group: "View", key: null },

  { id: "tool.sketch", label: "Sketch (on the selected face, or Top)", group: "Model tools", key: null },
  { id: "tool.extrude", label: "Extrude", group: "Model tools", key: null },
  { id: "tool.cut", label: "Cut", group: "Model tools", key: null },
  { id: "tool.hole", label: "Hole", group: "Model tools", key: null },
  { id: "tool.fillet", label: "Fillet", group: "Model tools", key: null },
  { id: "tool.chamfer", label: "Chamfer", group: "Model tools", key: null },
  { id: "tool.linearPattern", label: "Linear pattern", group: "Model tools", key: null },
  { id: "tool.circularPattern", label: "Circular pattern", group: "Model tools", key: null },
  { id: "tool.mirror", label: "Mirror", group: "Model tools", key: null },
  { id: "tool.combine", label: "Combine", group: "Model tools", key: null },
  { id: "tool.split", label: "Split", group: "Model tools", key: null },
  { id: "tool.move", label: "Move", group: "Model tools", key: null },
  { id: "tool.deleteBody", label: "Delete body", group: "Model tools", key: null },
  { id: "tool.member", label: "Member", group: "Model tools", key: null },
  // Model tools still to come: ids, labels and keys reserved (each loses `planned` when its tool lands).
  { id: "tool.plane", label: "Reference plane", group: "Model tools", key: null },
  { id: "tool.axis", label: "Reference axis", group: "Model tools", key: null },
  { id: "tool.point", label: "Reference point", group: "Model tools", key: null },

  { id: "tool.revolve", label: "Revolve", group: "Model tools", key: null, planned: true },
  { id: "tool.shell", label: "Shell", group: "Model tools", key: null, planned: true },
  { id: "tool.draft", label: "Draft", group: "Model tools", key: null, planned: true },
  { id: "tool.scale", label: "Scale bodies", group: "Model tools", key: null, planned: true },

  { id: "tool.sweep", label: "Sweep", group: "Model tools", key: null, planned: true },
  { id: "tool.loft", label: "Loft", group: "Model tools", key: null, planned: true },
  { id: "tool.rib", label: "Rib", group: "Model tools", key: null, planned: true },

  { id: "tool.sketchPattern", label: "Sketch-driven pattern", group: "Model tools", key: null, planned: true },

  { id: "tool.measure", label: "Measure", group: "Model tools", key: null, planned: true },
  { id: "tool.section", label: "Section view", group: "Model tools", key: null, planned: true },

  { id: "sketch.select", label: "Select", group: "Sketch", key: "V" },
  { id: "sketch.dimension", label: "Smart Dimension", group: "Sketch", key: "D" },
  { id: "sketch.line", label: "Line", group: "Sketch", key: "L" },
  { id: "sketch.rect", label: "Corner rectangle", group: "Sketch", key: "R" },
  { id: "sketch.circle", label: "Circle", group: "Sketch", key: "C" },
  { id: "sketch.arc", label: "Centrepoint arc", group: "Sketch", key: "A" },
  { id: "sketch.slot", label: "Straight slot", group: "Sketch", key: "O" },
  { id: "sketch.construction", label: "Construction on or off", group: "Sketch", key: "Q" },
  { id: "sketch.finish", label: "Finish the sketch", group: "Sketch", key: "Ctrl+B" },
  // The drawing tools of the sketch tool registry (src/ui/sketcher/tools).
  { id: "sketch.centerline", label: "Centreline", group: "Sketch", key: "Shift+L" },
  { id: "sketch.point", label: "Point", group: "Sketch", key: "P" },
  { id: "sketch.rectCenter", label: "Centre rectangle", group: "Sketch", key: "Shift+R" },
  { id: "sketch.rect3", label: "3-point rectangle", group: "Sketch", key: null },
  { id: "sketch.parallelogram", label: "Parallelogram", group: "Sketch", key: null },
  { id: "sketch.polygon", label: "Polygon", group: "Sketch", key: "G" },
  { id: "sketch.arc3", label: "3-point arc", group: "Sketch", key: "Shift+A" },
  { id: "sketch.tangentArc", label: "Tangent arc", group: "Sketch", key: null },
  { id: "sketch.circle3", label: "Perimeter circle", group: "Sketch", key: "Shift+C" },
  { id: "sketch.slotCenter", label: "Centrepoint slot", group: "Sketch", key: "Shift+O" },
  { id: "sketch.midpointLine", label: "Midpoint line", group: "Sketch", key: null },
  // Sketch tools still to come: ids, labels and keys reserved (each loses `planned` when its tool lands).

  { id: "sketch.convert", label: "Convert entities (model edges into the sketch)", group: "Sketch", key: null },

  { id: "sketch.trim", label: "Trim", group: "Sketch", key: "T", planned: true },
  { id: "sketch.extend", label: "Extend", group: "Sketch", key: "E", planned: true },
  { id: "sketch.split", label: "Split entity", group: "Sketch", key: null, planned: true },
  { id: "sketch.fillet", label: "Sketch fillet", group: "Sketch", key: null, planned: true },
  { id: "sketch.chamfer", label: "Sketch chamfer", group: "Sketch", key: null, planned: true },
  { id: "sketch.offset", label: "Offset entities", group: "Sketch", key: null, planned: true },
  { id: "sketch.mirror", label: "Mirror entities", group: "Sketch", key: "M", planned: true },
  { id: "sketch.linearPattern", label: "Linear sketch pattern", group: "Sketch", key: null, planned: true },
  { id: "sketch.circularPattern", label: "Circular sketch pattern", group: "Sketch", key: null, planned: true },
  { id: "sketch.move", label: "Move entities", group: "Sketch", key: null, planned: true },
  { id: "sketch.rotate", label: "Rotate entities", group: "Sketch", key: null, planned: true },
  { id: "sketch.scale", label: "Scale entities", group: "Sketch", key: null, planned: true },
  { id: "sketch.copy", label: "Copy entities", group: "Sketch", key: null, planned: true },

  { id: "sketch.fullyDefine", label: "Fully define the sketch", group: "Sketch", key: null, planned: true },

  { id: "sketch.ellipse", label: "Ellipse", group: "Sketch", key: null, planned: true },
  { id: "sketch.spline", label: "Spline", group: "Sketch", key: null, planned: true },
];

export interface InputPrefs {
  mouse: MouseScheme;
  /** Wheel zoom the other way round from the scheme's. */
  reverseWheel: boolean;
  /** Keys changed from the defaults: a key, or null for none. */
  keys: Record<string, string | null>;
}

const DEFAULTS: InputPrefs = { mouse: "solidworks", reverseWheel: false, keys: {} };
const STORE_KEY = "cocaide.input.v1";

function load(): InputPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") as Partial<InputPrefs> | null;
    if (!raw || typeof raw !== "object") return DEFAULTS;
    return {
      mouse: raw.mouse === "trackpad" ? "trackpad" : "solidworks",
      reverseWheel: raw.reverseWheel === true,
      keys: raw.keys && typeof raw.keys === "object" ? raw.keys : {},
    };
  } catch {
    return DEFAULTS;
  }
}

let prefs: InputPrefs = load();
const listeners = new Set<() => void>();

export function inputPrefs(): InputPrefs {
  return prefs;
}

export function setInputPrefs(next: InputPrefs): void {
  prefs = next;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    // Private windows may refuse: the change still holds for this visit.
  }
  for (const l of listeners) l();
}

/** Back to SOLIDWORKS's defaults. */
export function resetInputPrefs(): void {
  setInputPrefs(DEFAULTS);
}

export function useInputPrefs(): InputPrefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => prefs,
  );
}

/** The key a command is on now. */
export function keyFor(id: string, p: InputPrefs = prefs): string | null {
  if (id in p.keys) return p.keys[id];
  return COMMANDS.find((c) => c.id === id)?.key ?? null;
}

/** A tooltip's shortcut: " (Ctrl+7)", or nothing. */
export function keyHint(id: string, p: InputPrefs = prefs): string {
  const k = keyFor(id, p);
  return k ? ` (${k})` : "";
}

/** Two commands can share a key only if they are never live at once: a model tool and a sketch tool. */
export function clashes(a: CommandGroup, b: CommandGroup): boolean {
  const apart = (x: CommandGroup, y: CommandGroup) => (x === "Model tools" && y === "Sketch") || (x === "Sketch" && y === "Model tools");
  return !apart(a, b);
}

/** Binds a key to a command; another command on that key that would clash loses it. Returns what lost it. */
export function bindKey(id: string, key: string | null): string | null {
  const def = COMMANDS.find((c) => c.id === id);
  if (!def) return null;
  const keys = { ...prefs.keys, [id]: key };
  let lost: string | null = null;
  if (key) {
    for (const c of COMMANDS) {
      if (c.id !== id && keyFor(c.id) === key && clashes(c.group, def.group)) {
        keys[c.id] = null;
        // A planned command is not in Settings yet: it gives the key up without a word.
        if (!c.planned) lost = c.label;
      }
    }
  }
  setInputPrefs({ ...prefs, keys });
  return lost;
}

const NAMED: Record<string, string> = { " ": "Space", Esc: "Escape", Del: "Delete", Spacebar: "Space" };

/** A key press as written in the bindings: "Ctrl+Shift+Z", "F", "Space", "ArrowLeft". Null for a lone modifier. */
export function keyOf(e: KeyboardEvent | ReactKeyboardEvent): string | null {
  let k: string;
  if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) k = e.code.slice(5);
  else if (/^Numpad[0-9]$/.test(e.code)) k = e.code.slice(6);
  else k = NAMED[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  if (["Control", "Shift", "Alt", "Meta", "OS", "Dead", "Unidentified"].includes(k)) return null;
  const mods = [e.ctrlKey || e.metaKey ? "Ctrl" : null, e.altKey ? "Alt" : null, e.shiftKey ? "Shift" : null].filter(Boolean);
  return [...mods, k].join("+");
}

/** Typing in a field: keys belong to the field, but for saving and opening. */
function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
}
const WHILE_TYPING = new Set(["save", "open"]);

/**
 * Runs these commands when their keys are pressed, while `enabled`. The
 * handlers may change every render: the latest are used.
 */
export function useCommands(handlers: Record<string, (() => void) | undefined>, enabled = true): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      // Held down, only the view keys repeat.
      if (e.defaultPrevented || (e.repeat && !e.key.startsWith("Arrow") && e.key.toLowerCase() !== "z")) return;
      const key = keyOf(e);
      if (!key) return;
      for (const c of COMMANDS) {
        const run = ref.current[c.id];
        if (!run || keyFor(c.id) !== key) continue;
        if (typing(e) && !WHILE_TYPING.has(c.id)) continue;
        // A modal dialog has the keyboard to itself.
        if (document.querySelector(".modal-backdrop") && c.id !== "save") continue;
        e.preventDefault();
        run();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/** Where the pointer last was, for the shortcut bar and the view menu. */
export const pointer = { x: 0, y: 0 };
if (typeof window !== "undefined") {
  window.addEventListener("pointermove", (e) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
  });
}

/** The zoom a wheel turn asks for: above 1 zooms in. SOLIDWORKS zooms in when the wheel rolls toward you. */
export function wheelZoom(e: WheelEvent | ReactWheelEvent, p: InputPrefs = prefs): number {
  const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const dy = e.deltaY * lines;
  // A trackpad pinch arrives as a wheel with Ctrl: spreading the fingers zooms in, whatever the scheme.
  if (e.ctrlKey) return Math.exp(-dy * 0.01);
  let inward = p.mouse === "solidworks" ? dy > 0 : dy < 0;
  if (p.reverseWheel) inward = !inward;
  const step = Math.min(Math.abs(dy), 200) * 0.0016;
  return Math.exp(inward ? step : -step);
}

// How the part is drawn (display style, perspective), where the camera was,
// the views you named and the section view: view state, remembered per
// document (by its name) in this browser, so a part opens, and the view comes
// back after a sketch, the way you left it. Pure apart from the guarded
// localStorage reads and writes.

import type { Vec3 } from "../../doc/types";
import type { IconName } from "../icons";
import { parseSectionView, type SectionView } from "./section";

export type DisplayStyle = "shadedEdges" | "shaded" | "hiddenRemoved" | "hiddenVisible" | "wireframe";

export interface DisplayState {
  style: DisplayStyle;
  /** Perspective (true) or orthographic. */
  perspective: boolean;
}

/** Orthographic by default, as on a drawing and in the usual CAD tools; perspective is a toggle away. */
export const DEFAULT_DISPLAY: DisplayState = { style: "shadedEdges", perspective: false };

/** The styles, in the order the menu lists them, with their commands and icons. */
export const DISPLAY_STYLES: { style: DisplayStyle; label: string; icon: IconName; command: string; hint: string }[] = [
  { style: "shadedEdges", label: "Shaded with edges", icon: "shadedEdges", command: "view.display.shadedEdges", hint: "Faces shaded, every edge drawn" },
  { style: "shaded", label: "Shaded", icon: "shaded", command: "view.display.shaded", hint: "Faces shaded, no edges" },
  { style: "hiddenRemoved", label: "Hidden lines removed", icon: "hiddenLines", command: "view.display.hiddenRemoved", hint: "Edges and outlines you can see, as on a drawing" },
  { style: "hiddenVisible", label: "Hidden lines visible", icon: "hiddenLinesVisible", command: "view.display.hiddenVisible", hint: "Edges you can see, and the hidden ones dashed" },
  { style: "wireframe", label: "Wireframe", icon: "wireframe", command: "view.display.wireframe", hint: "Every edge and outline, see-through" },
];

export interface CameraState {
  position: Vec3;
  target: Vec3;
  up: Vec3;
}

/** A view saved under a name (Views menu, Save view…). */
export interface NamedView {
  name: string;
  camera: CameraState;
}

export interface ViewMemory {
  camera?: CameraState;
  display?: DisplayState;
  /** The views saved under names, in the order they were saved. */
  views?: NamedView[];
  /** The section view as it was left (on or off). */
  section?: SectionView;
}

const KEY = "cocaide.views.v1";
/** How many documents' views are kept: the most recently used. */
const KEEP = 20;

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));
const isCamera = (c: unknown): boolean => !!c && typeof c === "object" && isVec3((c as Record<string, unknown>).position) && isVec3((c as Record<string, unknown>).target) && isVec3((c as Record<string, unknown>).up);
const pickCamera = (c: Record<string, Vec3>): CameraState => ({ position: c.position, target: c.target, up: c.up });
const STYLES = new Set<string>(DISPLAY_STYLES.map((s) => s.style));

/** A stored entry made safe: anything odd is dropped. */
export function parseMemory(raw: unknown): ViewMemory {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: ViewMemory = {};
  const c = r.camera as Record<string, unknown> | undefined;
  if (c && isVec3(c.position) && isVec3(c.target) && isVec3(c.up)) out.camera = { position: c.position, target: c.target, up: c.up };
  const d = r.display as Record<string, unknown> | undefined;
  // A display remembered before orthographic became the default keeps what it said (perspective unless it said otherwise).
  if (d && typeof d.style === "string" && STYLES.has(d.style)) out.display = { style: d.style as DisplayStyle, perspective: d.perspective !== false };
  if (Array.isArray(r.views)) {
    const views = r.views
      .map((v) => v as Record<string, unknown>)
      .filter((v) => v && typeof v.name === "string" && v.name.trim() !== "" && isCamera(v.camera))
      .map((v) => ({ name: (v.name as string).trim(), camera: pickCamera(v.camera as Record<string, Vec3>) }));
    if (views.length) out.views = views;
  }
  const section = parseSectionView(r.section);
  if (section) out.section = section;
  return out;
}

function readAll(): Record<string, unknown> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** What this browser remembers of a document's view. */
export function loadView(name: string): ViewMemory {
  return parseMemory(readAll()[name]);
}

/** Remembers part of a document's view; the oldest documents are forgotten past KEEP. */
export function saveView(name: string, patch: ViewMemory): void {
  if (!name) return;
  try {
    const all = readAll();
    const next = { ...parseMemory(all[name]), ...patch };
    delete all[name];
    all[name] = next;
    const names = Object.keys(all);
    for (const old of names.slice(0, Math.max(0, names.length - KEEP))) delete all[old];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Private windows may refuse: the view still holds for this visit.
  }
}

/** Are two camera states the same, to a hair? */
export function sameCamera(a: CameraState | null | undefined, b: CameraState | null | undefined): boolean {
  if (!a || !b) return a === b;
  const near = (p: Vec3, q: Vec3) => p.every((x, i) => Math.abs(x - q[i]) < 1e-6 * (1 + Math.abs(x)));
  return near(a.position, b.position) && near(a.target, b.target) && near(a.up, b.up);
}

/**
 * The views to go back to (Previous view): each settled camera, newest last,
 * not repeating the one before; at most `limit`.
 */
export function pushView(stack: CameraState[], cam: CameraState, limit = 30): CameraState[] {
  if (sameCamera(stack[stack.length - 1], cam)) return stack;
  return [...stack, cam].slice(-limit);
}

// ------------------------------------------------------------------ named views

/** A name for the next saved view: "View 1", "View 2"… whichever is free. */
export function nextViewName(views: readonly NamedView[]): string {
  const taken = new Set(views.map((v) => v.name.toLowerCase()));
  for (let i = 1; ; i++) if (!taken.has(`view ${i}`)) return `View ${i}`;
}

/** The list with a view saved under `name` (trimmed): a view of that name already there is replaced in place. */
export function saveNamedView(views: readonly NamedView[], name: string, camera: CameraState): NamedView[] {
  const n = name.trim();
  if (!n) return [...views];
  const at = views.findIndex((v) => v.name.toLowerCase() === n.toLowerCase());
  if (at < 0) return [...views, { name: n, camera }];
  return views.map((v, i) => (i === at ? { name: n, camera } : v));
}

/** The list with a view renamed; an error (what to do) when the new name is empty or taken. */
export function renameNamedView(views: readonly NamedView[], from: string, to: string): NamedView[] | string {
  const n = to.trim();
  if (!n) return "A view needs a name: type one.";
  if (views.some((v) => v.name !== from && v.name.toLowerCase() === n.toLowerCase())) return `There is already a view called ${n}: pick another name.`;
  return views.map((v) => (v.name === from ? { ...v, name: n } : v));
}

export function removeNamedView(views: readonly NamedView[], name: string): NamedView[] {
  return views.filter((v) => v.name !== name);
}

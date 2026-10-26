// How the 3D view moves, set in Settings > Mouse and kept in this browser:
// how fast a drag turns the part, whether rotating keeps Z up (a turntable),
// whether view changes glide, whether the view cube is shown, and whether a
// sketch turns the view to face it as it opens and back as it closes. Pure apart
// from the guarded localStorage reads and writes and the React hook.

import { useSyncExternalStore } from "react";

export interface ViewPrefs {
  /** How fast a drag turns the view, 0.5–2 (1: dragging across the view's height turns half a turn). */
  rotateSpeed: number;
  /** Keep Z up while rotating (a turntable); off: free rotation, the part turns any way you drag it. */
  turntable: boolean;
  /** View changes (standard views, fit, the cube, named views…) glide instead of jumping. */
  animate: boolean;
  /** The view cube in the view's top right corner. */
  viewCube: boolean;
  /** Opening a sketch turns the view square onto its plane (Phase P wave 2A). */
  sketchFace: boolean;
  /** Finishing or cancelling a sketch turns the view back to where it was. */
  sketchReturn: boolean;
}

export const DEFAULT_VIEW_PREFS: ViewPrefs = { rotateSpeed: 1, turntable: false, animate: true, viewCube: true, sketchFace: true, sketchReturn: true };
export const MIN_ROTATE_SPEED = 0.5;
export const MAX_ROTATE_SPEED = 2;
const STORE_KEY = "cocaide.viewPrefs.v1";

/** The settings as stored, made safe: anything missing or odd takes its default; the speed is held to 50–200 %. */
export function parseViewPrefs(raw: unknown): ViewPrefs {
  if (!raw || typeof raw !== "object") return DEFAULT_VIEW_PREFS;
  const r = raw as Record<string, unknown>;
  const speed = typeof r.rotateSpeed === "number" && Number.isFinite(r.rotateSpeed) ? r.rotateSpeed : 1;
  return {
    rotateSpeed: Math.min(MAX_ROTATE_SPEED, Math.max(MIN_ROTATE_SPEED, speed)),
    turntable: r.turntable === true,
    animate: r.animate !== false,
    viewCube: r.viewCube !== false,
    sketchFace: r.sketchFace !== false,
    sketchReturn: r.sketchReturn !== false,
  };
}

function load(): ViewPrefs {
  try {
    return parseViewPrefs(JSON.parse(localStorage.getItem(STORE_KEY) ?? "null"));
  } catch {
    return DEFAULT_VIEW_PREFS;
  }
}

let prefs: ViewPrefs = typeof localStorage === "undefined" ? DEFAULT_VIEW_PREFS : load();
const listeners = new Set<() => void>();

export function viewPrefs(): ViewPrefs {
  return prefs;
}

export function setViewPrefs(next: ViewPrefs): void {
  prefs = parseViewPrefs(next);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
  } catch {
    // Private windows may refuse: the change still holds for this visit.
  }
  for (const l of listeners) l();
}

export function resetViewPrefs(): void {
  setViewPrefs(DEFAULT_VIEW_PREFS);
}

export function useViewPrefs(): ViewPrefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => prefs,
  );
}

/** Does the page ask for less motion (the system's reduce-motion setting)? Then views never glide. */
export function reducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

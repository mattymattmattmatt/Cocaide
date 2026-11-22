// The VR walkthrough's settings (Settings > VR), kept in this browser: whether
// the Enter VR button shows on a headset, how you move (teleport, and the
// thumbstick to walk if you like), how far a snap turn turns, and how high the
// "roof off" cut is above the floor you stand on. Pure apart from the guarded
// localStorage reads and writes and the React hook.

import { useSyncExternalStore } from "react";

export interface VrPrefs {
  /** Show the Enter VR button where the browser can do VR (a headset). */
  button: boolean;
  /** The left thumbstick walks you smoothly, as well as teleporting. */
  smooth: boolean;
  /** Degrees a flick of the right thumbstick turns you. */
  snapTurn: 30 | 45 | 90;
  /** Walking speed with the thumbstick, m/s. */
  speed: number;
  /** Show the VR start point (a figure where you will stand) in the 3D view. */
  showStart: boolean;
  /** Darken the edge of view while walking with the stick (eases motion sickness). */
  vignette: boolean;
  /** "Roof off" hides what is more than this above the floor you stand on, mm. */
  cutAbove: number;
}

export const DEFAULT_VR_PREFS: VrPrefs = { button: true, smooth: true, snapTurn: 30, speed: 1.4, showStart: true, vignette: true, cutAbove: 2300 };
const STORE_KEY = "cocaide.vrPrefs.v1";

export function parseVrPrefs(raw: unknown): VrPrefs {
  if (!raw || typeof raw !== "object") return DEFAULT_VR_PREFS;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    button: r.button !== false,
    smooth: r.smooth !== false,
    snapTurn: r.snapTurn === 45 || r.snapTurn === 90 ? r.snapTurn : 30,
    speed: num(r.speed, 0.5, 3, DEFAULT_VR_PREFS.speed),
    showStart: r.showStart !== false,
    vignette: r.vignette !== false,
    cutAbove: num(r.cutAbove, 1500, 4000, DEFAULT_VR_PREFS.cutAbove),
  };
}

function load(): VrPrefs {
  try {
    return parseVrPrefs(JSON.parse(localStorage.getItem(STORE_KEY) ?? "null"));
  } catch {
    return DEFAULT_VR_PREFS;
  }
}

let prefs: VrPrefs = typeof localStorage === "undefined" ? DEFAULT_VR_PREFS : load();
const listeners = new Set<() => void>();

export function vrPrefs(): VrPrefs {
  return prefs;
}

export function setVrPrefs(next: VrPrefs): void {
  prefs = parseVrPrefs(next);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
  } catch {
    // Private windows may refuse: the change still holds for this visit.
  }
  for (const l of listeners) l();
}

export function useVrPrefs(): VrPrefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => prefs,
  );
}

/** Whether this browser can enter immersive VR (a headset's browser): asked once, remembered. */
let support: Promise<boolean> | null = null;
export function vrSupported(): Promise<boolean> {
  if (!support) {
    const xr = typeof navigator !== "undefined" ? (navigator as Navigator & { xr?: { isSessionSupported(m: string): Promise<boolean> } }).xr : undefined;
    support = xr ? xr.isSessionSupported("immersive-vr").catch(() => false) : Promise.resolve(false);
  }
  return support;
}

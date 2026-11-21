// Which 3D sketch is being drawn in the view, on which work plane, and the
// point the next line starts from: shared by its editor (Properties), the app
// (which turns clicks into edits) and the viewport.

import { useSyncExternalStore } from "react";
import type { WorkPlane } from "./place";

export interface DrawState {
  /** The sketch3d feature being drawn, or null. */
  feature: string | null;
  plane: WorkPlane;
  /** The point the next line starts from (null: the next click starts a new chain). */
  anchor: string | null;
}

let state: DrawState = { feature: null, plane: "XY", anchor: null };
const listeners = new Set<() => void>();

export function getDraw(): DrawState {
  return state;
}

export function setDraw(patch: Partial<DrawState>): void {
  const next = { ...state, ...patch };
  if (next.feature === state.feature && next.plane === state.plane && next.anchor === state.anchor) return;
  state = next;
  for (const l of listeners) l();
}

export function useDraw(): DrawState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getDraw,
    getDraw,
  );
}

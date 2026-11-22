import type { VrStart } from "../../doc/vr";

/** What a view needs for the VR walkthrough: its start point, and placing it (Settings > VR > Set the start point). */
export interface VrViewProps {
  start: VrStart | null;
  /** Show the start marker in the view. */
  showStart: boolean;
  /** Placing the start point in this view now. */
  placing: boolean;
  onPlaced?(start: VrStart): void;
  onCancel?(): void;
  /** In VR or out of it. */
  onVr?(inVr: boolean): void;
}

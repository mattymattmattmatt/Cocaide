import type { VrMove, VrPin, VrStart } from "../../doc/vr";

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
  /** The document's pins and moved furniture from VR: drawn on the desktop (onion skin) and in VR. */
  pins?: VrPin[];
  moves?: VrMove[];
  /** Don't draw them on the desktop (the review panel's eye). */
  notesHidden?: boolean;
  /** What was added in a visit to VR, when you leave it. */
  onNotes?(pins: VrPin[], moves: VrMove[]): void;
  /** A part (the Model tab): VR holds it to inspect (unless a start point says where to stand), and can switch to walking through it. */
  inspect?: boolean;
}

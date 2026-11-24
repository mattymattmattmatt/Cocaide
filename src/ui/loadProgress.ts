// How far the model on screen has got with loading: a file coming in from a link, the kernel starting, the part
// building, an assembly's parts building one by one. What the thin bar along the top of the window shows. Pure.

export interface LoadState {
  /** A file is being fetched from an ?open= link. */
  fetching: boolean;
  /** The kernel (OpenCascade) is still loading. */
  kernelLoading: boolean;
  /** The part is rebuilding, or hasn't been built yet. */
  building: boolean;
  /** An assembly on screen: its parts built so far, of how many (null: not an assembly). */
  parts: { done: number; total: number } | null;
}

export interface LoadProgress {
  /** Whether anything is loading. */
  active: boolean;
  /** How far, 0 to 1; null when it can't be told (the bar shows movement instead). */
  fraction: number | null;
  /** In words, for the bar's tooltip and screen readers. */
  label: string;
}

export function loadProgress(s: LoadState): LoadProgress {
  if (s.fetching) return { active: true, fraction: null, label: "Downloading the file…" };
  if (s.kernelLoading) return { active: true, fraction: null, label: "Loading the modelling kernel…" };
  const p = s.parts;
  if (p && p.total > 0 && p.done < p.total) {
    // A sliver at the start, so the bar shows before the first part is in.
    return { active: true, fraction: Math.max(0.04, p.done / p.total), label: `Building part ${p.done + 1} of ${p.total}…` };
  }
  if (!p && s.building) return { active: true, fraction: null, label: "Building…" };
  return { active: false, fraction: 1, label: "Loaded" };
}

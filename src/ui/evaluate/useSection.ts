// The section view's state in the app: its planes and settings (view state,
// remembered per document in this browser with the camera), whether its panel
// is open, and the ways it is turned on and off: the Evaluate tab's Section
// view tool, the view bar's heads-up toggle, the panel's close. It stays on
// while you work (rebuilds and feature edits keep it); a plane on a plane
// feature follows that feature, and goes when the feature does.

import { useEffect, useRef, useState } from "react";
import { DEFAULT_DATUMS } from "../../features/datum";
import type { Selection } from "../model/selection";
import type { RebuildView } from "../../worker/protocol";
import { loadView, saveView } from "./display";
import { followDatums, sectionOn, sectionViewOf, setPlane, type SectionState, type SectionView } from "./section";

export interface SectionControl {
  /** The section view (null: never set up for this part); shown while `on`. */
  section: SectionView | null;
  /** The panel is open (it shows while the section is on). */
  panelOpen: boolean;
  /** Any change to the section (the panel, a dragged arrow). */
  setSection(next: SectionView | null): void;
  /** The Section view tool: on with its panel (on the selected flat face or plane, if one is); again, off. */
  toggleTool(): void;
  /** The view bar's toggle: on or off, keeping every setting; set up (on Front, or the selection) when there is none. */
  toggleShown(): void;
  /** The panel's close: the section goes off (kept for next time) and the panel closes. */
  close(): void;
  /** Plane i moved onto a default plane, a plane feature or the selected face. */
  planeTo(i: number, on: string): void;
}

/** The plane a new section starts on: the selected flat face or plane, else Front through the middle. An error says what to pick. */
function firstPlane(view: RebuildView | null, selection: Selection): SectionState | string {
  const box = view?.measurements?.boundingBox ?? null;
  const face = selection.faces.length === 1 && selection.edges.length === 0 ? view?.faces[selection.faces[0]] : undefined;
  const datum = selection.datums?.length === 1 && selection.faces.length === 0 ? selection.datums[0] : undefined;
  const planeDatum = datum && (Object.hasOwn(DEFAULT_DATUMS, datum) ? DEFAULT_DATUMS[datum] : view?.datums?.[datum])?.kind === "plane" ? datum : undefined;
  if (face?.type === "plane") return sectionOn("face", view?.datums ?? {}, box, face);
  return sectionOn(planeDatum ?? "Front", view?.datums ?? {}, box);
}

/** Is a flat face or a plane selected alone (a reason to put plane 1 on it)? */
function planeSelected(view: RebuildView | null, selection: Selection): boolean {
  const face = selection.faces.length === 1 && selection.edges.length === 0 ? view?.faces[selection.faces[0]] : undefined;
  if (face?.type === "plane") return true;
  const datum = selection.datums?.length === 1 && selection.faces.length === 0 ? selection.datums[0] : undefined;
  return !!datum && (Object.hasOwn(DEFAULT_DATUMS, datum) ? DEFAULT_DATUMS[datum] : view?.datums?.[datum])?.kind === "plane";
}

export function useSectionView(docName: string, view: RebuildView | null, selection: Selection, notice: (kind: "info" | "error", text: string) => void): SectionControl {
  const [section, setSectionState] = useState<SectionView | null>(() => (docName ? (loadView(docName).section ?? null) : null));
  const [panelOpen, setPanelOpen] = useState(() => !!section?.on);
  // Another part: its own section, as it was left.
  const loadedFor = useRef(docName);
  useEffect(() => {
    if (loadedFor.current === docName) return;
    loadedFor.current = docName;
    const s = docName ? (loadView(docName).section ?? null) : null;
    setSectionState(s);
    setPanelOpen(!!s?.on);
  }, [docName]);

  const setSection = (next: SectionView | null) => {
    setSectionState(next);
    if (docName) saveView(docName, { section: next ?? undefined });
  };

  // Planes on plane features follow them, and go when they do.
  useEffect(() => {
    if (!section || !view) return;
    const r = followDatums(section, view.datums ?? {});
    if (r.view === section) return;
    setSection(r.view);
    if (r.gone.length) notice("info", r.view ? `Section plane on ${r.gone.join(", ")} removed: it is no longer in the part.` : `Section view closed: its plane ${r.gone.join(", ")} is no longer in the part.`);
    if (!r.view) setPanelOpen(false);
  }, [view, section]); // eslint-disable-line react-hooks/exhaustive-deps

  /** On, with plane 1 on the selected flat face or plane when one is selected. */
  const turnOn = (): boolean => {
    if (section && !planeSelected(view, selection)) {
      setSection({ ...section, on: true, collapsed: false });
      return true;
    }
    const first = firstPlane(view, selection);
    if (typeof first === "string") {
      notice("error", first);
      return false;
    }
    setSection(section ? { ...setPlane(section, 0, first), on: true, active: 0, collapsed: false } : sectionViewOf(first));
    return true;
  };

  return {
    section,
    panelOpen,
    setSection,
    toggleTool() {
      if (section?.on && panelOpen) {
        setSection({ ...section, on: false });
        setPanelOpen(false);
        return;
      }
      if (turnOn()) setPanelOpen(true);
    },
    toggleShown() {
      if (!section) {
        if (turnOn()) setPanelOpen(true);
        return;
      }
      setSection({ ...section, on: !section.on });
    },
    close() {
      if (section) setSection({ ...section, on: false });
      setPanelOpen(false);
    },
    planeTo(i: number, on: string) {
      if (!section) return;
      const face = selection.faces.length === 1 ? view?.faces[selection.faces[0]] : undefined;
      const s = sectionOn(on, view?.datums ?? {}, view?.measurements?.boundingBox ?? null, face);
      if (typeof s === "string") return notice("error", s);
      const old = section.planes[i];
      if (old && old.on === on && on !== "face") return;
      // A new plane starts afresh (through the middle, untilted, unflipped); it keeps only being on or off.
      setSection(setPlane(section, i, { ...s, ...(old?.enabled === false ? { enabled: false } : {}) }));
    },
  };
}

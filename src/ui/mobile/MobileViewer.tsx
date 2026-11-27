// The touch viewer: what a phone shows (src/ui/mobile/layout). The model fills
// the screen; a slim bar at the top (the project, Open, Share, Full app) and
// big buttons at the bottom: Views, Measure, Section, Parts, and the VR notes
// when there are any. One finger turns the model, two pinch and pan, a double
// tap zooms in (src/ui/cadControls). Nothing here edits the design except
// accepting or rejecting what was proposed in VR.

import { useMemo, useRef, useState, type ReactNode } from "react";
import type { RebuildView } from "../../worker/protocol";
import type { Vec3 } from "../../doc/types";

type Box = { min: Vec3; max: Vec3 };
import { Viewport } from "../Viewport";
import { Icon, type IconName } from "../icons";
import { EMPTY_SELECTION, type PickTarget, type Selection } from "../model/selection";
import { itemName, measure, measureItems, type MeasureItem } from "../evaluate/measure";
import { meshClosest } from "../evaluate/meshDistance";
import type { EvalOverlay } from "../viewport/evalLayer";
import type { SectionControl } from "../evaluate/useSection";
import { extentAlong, sectionOn, sectionViewOf, setPlane, type SectionView } from "../evaluate/section";
import { itemOfFace, itemsOf } from "../vr/items";
import { niceName } from "../../doc/vr";
import type { VrViewProps } from "../vr/types";

type Sheet = "views" | "measure" | "section" | "parts" | "notes" | null;

export interface MobileViewerProps {
  name: string;
  /** Rebuilding, loading: what the bar says while the model is not ready. */
  status: string | null;
  view: RebuildView | null;
  fitToken: number;
  /** Re-frame only if the camera hasn't been moved (an assembly loading). */
  softFitToken?: number;
  /** The view's parts (an assembly's components, a part's bodies), each with its label. */
  parts: { id: string; label: string }[];
  /** "components" or "bodies". */
  partsNoun: string;
  appearances?: Parameters<typeof Viewport>[0]["appearances"];
  clearBodies?: Parameters<typeof Viewport>[0]["clearBodies"];
  /** Hidden besides what the Parts sheet hides (isolate). */
  alsoHidden?: ReadonlySet<string>;
  /** The component (or body) a face belongs to, for the measure title. */
  ownerOf?(face: number): string | undefined;
  memoryKey: string;
  display?: Parameters<typeof Viewport>[0]["display"];
  onDisplay?: Parameters<typeof Viewport>[0]["onDisplay"];
  section: SectionControl;
  /** The box the section's slider spans. */
  sectionBox: Box | null;
  capColour: SectionView["capColour"];
  vr?: VrViewProps;
  /** The VR notes panel, and how many notes there are (0: no button). */
  vrNotes: ReactNode;
  vrNoteCount: number;
  notice: ReactNode;
  onOpen(): void;
  onShare(): void;
  onFull(): void;
}

const PLANES: { on: string; label: string; hint: string }[] = [
  { on: "Top", label: "Plan", hint: "Level, as a floor plan: what is above the cut taken away" },
  { on: "Front", label: "Front", hint: "Front to back" },
  { on: "Right", label: "Side", hint: "Side to side" },
];

export function MobileViewer(p: MobileViewerProps) {
  const [sheet, setSheet] = useState<Sheet>(null);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const commands = useRef<((id: string) => void) | null>(null);
  const cmd = (id: string) => commands.current?.(id);
  const measuring = sheet === "measure";
  const toggle = (s: Exclude<Sheet, null>) => setSheet((now) => (now === s ? null : s));

  // Taps pick while measuring: one face, edge or corner for its size or place; a second for the distance; a third starts again.
  const pick = (t: PickTarget | null) => {
    if (!measuring || !t || t.kind === "datum" || t.kind === "sketch") return;
    setSelection((sel) => {
      const n = sel.faces.length + sel.edges.length + (sel.vertices?.length ?? 0);
      const base: Selection = n >= 2 ? EMPTY_SELECTION : sel;
      if (t.kind === "vertex") return { ...base, vertices: [...(base.vertices ?? []), { edge: t.edge, at: t.at }] };
      return t.kind === "face" ? { ...base, faces: [...base.faces, t.index] } : { ...base, edges: [...base.edges, t.index] };
    });
  };
  const items = useMemo(() => itemsOf(p.view), [p.view]);
  const measured = useMemo(() => {
    const v = p.view;
    if (!measuring || !v) return null;
    const its = measureItems(selection, v.faces, v.edges);
    if (!its.length) return null;
    const ref = (it: MeasureItem) => (it.kind === "face" ? { kind: "face" as const, index: it.index } : it.kind === "edge" ? { kind: "edge" as const, index: it.index } : null);
    const ra = its.length === 2 ? ref(its[0]) : null;
    const rb = its.length === 2 ? ref(its[1]) : null;
    const r = measure(its, ra && rb && v.mesh ? meshClosest(v.mesh, ra, rb) : null);
    // What each picked thing is part of: the piece (a bed, a wall) and its size. A corner: the piece of its edge's face.
    const faces = [...selection.faces, ...selection.edges.map((e) => v.edges[e]?.faces[0]), ...(selection.vertices ?? []).map((x) => v.edges[x.edge]?.faces[0])];
    const piece = (k: number) => {
      const f = faces[k];
      const item = f !== undefined ? itemOfFace(items, f) : null;
      if (!item) return null;
      const size = [0, 1, 2].map((j) => Math.round(item.max[j] - item.min[j]));
      return { name: niceName(item.partBody ?? item.body), size };
    };
    const named = (k: number) => {
      const pc = piece(k);
      return `${itemName(its[k])}${pc ? ` of ${pc.name}` : ""}`;
    };
    const title = its.length === 1 ? named(0) : `${named(0)} to ${named(1)}`;
    return { ...r, title: title.charAt(0).toUpperCase() + title.slice(1), piece: its.length === 1 ? piece(0) : null };
  }, [measuring, selection, p.view, items]);
  const overlay = useMemo<EvalOverlay | null>(() => (measured && (measured.line || measured.points.length) ? { lines: measured.line ? [measured.line] : [], points: measured.points, centreOfMass: null } : null), [measured]);
  const shownHidden = useMemo(() => new Set([...hidden, ...(p.alsoHidden ?? [])]), [hidden, p.alsoHidden]);

  // The section: one plane (Plan, Front or Side), its slider across the model.
  const sec = p.section.section;
  const plane = sec?.on ? sec.planes[sec.active] ?? sec.planes[0] : null;
  const span = plane ? extentAlong(plane.normal, plane.origin, p.sectionBox) : null;
  const cutOn = (on: string) => {
    const st = sectionOn(on, {}, p.sectionBox);
    if (typeof st === "string") return;
    // A plan cut starts at a person's eye height above the bottom of the model (on a house: through the windows), else the middle.
    const ext = extentAlong(st.normal, st.origin, p.sectionBox);
    const offset = on === "Top" && ext.max - ext.min > 3000 ? ext.min + 1400 : st.offset;
    // The plane itself not drawn: on a phone it would tint the whole view (the Section tag says it is on).
    p.section.setSection({ ...sectionViewOf({ ...st, offset }), capColour: p.capColour, on: true, showPlane: false });
  };
  const sectionBtn = (on: string) => !!plane && plane.on === on;

  const btn = (id: Exclude<Sheet, null>, icon: IconName, label: string, badge?: number) => (
    <button type="button" className={sheet === id ? "on" : ""} aria-pressed={sheet === id} onClick={() => toggle(id)} data-testid={`mv-${id}`}>
      <Icon name={icon} size={22} />
      <span>{label}</span>
      {badge ? <span className="mv-badge">{badge}</span> : null}
    </button>
  );

  return (
    <div className="mobile-viewer" data-testid="mobile-viewer">
      <header className="mv-top">
        <span className="mv-name" data-testid="doc-name-mobile">
          {p.name}
        </span>
        {p.status && <span className="mv-status">{p.status}</span>}
        <button type="button" onClick={p.onOpen} aria-label="Open" data-testid="mv-open">
          <Icon name="open" size={20} />
        </button>
        <button type="button" onClick={p.onShare} aria-label="Share" data-testid="mv-share">
          <Icon name="share" size={20} />
        </button>
        <button type="button" className="mv-full" onClick={p.onFull} title="The full app (as on a computer)" data-testid="mv-full">
          Full app
        </button>
      </header>
      {p.notice}
      <section className="mv-view">
        <Viewport
          view={p.view}
          fitToken={p.fitToken}
          softFitToken={p.softFitToken}
          selection={measuring ? selection : EMPTY_SELECTION}
          onPick={pick}
          memoryKey={`${p.memoryKey}#mobile`}
          display={p.display}
          onDisplay={p.onDisplay}
          clearBodies={p.clearBodies}
          hiddenBodies={shownHidden}
          appearances={p.appearances}
          overlay={overlay}
          vr={p.vr}
          commandsRef={commands}
          section={sec}
          onSection={p.section.setSection}
        />
      </section>
      {sheet && (
        <div className="mv-sheet" data-testid={`mv-sheet-${sheet}`}>
          {sheet === "views" && (
            <div className="mv-grid">
              {(
                [
                  ["view.fit", "Fit all"],
                  ["view.iso", "3D"],
                  ["view.top", "Top"],
                  ["view.front", "Front"],
                  ["view.right", "Side"],
                  ["view.back", "Back"],
                  ["view.perspective", "Perspective"],
                ] as const
              ).map(([id, label]) => (
                <button type="button" key={id} onClick={() => cmd(id)} data-testid={`mv-${id}`}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {sheet === "measure" && (
            <div className="mv-measure" data-testid="mv-measure-result">
              {!measured ? (
                <p>Tap a face or an edge for its size; tap a second for the distance between them.</p>
              ) : (
                <>
                  <h3>{measured.title}</h3>
                  {measured.piece && (
                    <p className="mv-piece" data-testid="mv-piece">
                      {measured.piece.name}: {measured.piece.size.map((v) => v.toLocaleString("en-AU")).join(" × ")} mm
                    </p>
                  )}
                  <table>
                    <tbody>
                      {measured.rows.map((r) => (
                        <tr key={r.key}>
                          <th>{r.label}</th>
                          <td>{r.text ?? (r.xyz ? r.xyz.map((v) => Math.round(v * 10) / 10).join(", ") : r.value !== undefined ? `${Math.round(r.value * 10) / 10}${r.unit === "°" ? "°" : r.unit ? ` ${r.unit}` : ""}` : "")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <button type="button" onClick={() => setSelection(EMPTY_SELECTION)} data-testid="mv-measure-clear">
                    Clear
                  </button>
                </>
              )}
            </div>
          )}
          {sheet === "section" && (
            <div className="mv-section">
              <div className="mv-grid">
                {PLANES.map((pl) => (
                  <button type="button" key={pl.on} className={sectionBtn(pl.on) ? "on" : ""} aria-pressed={sectionBtn(pl.on)} title={pl.hint} onClick={() => cutOn(pl.on)} data-testid={`mv-cut-${pl.on}`}>
                    {pl.label}
                  </button>
                ))}
                <button type="button" disabled={!plane} onClick={() => sec && plane && p.section.setSection(setPlane(sec, sec.active, { ...plane, flip: !plane.flip }))} data-testid="mv-cut-flip">
                  Flip
                </button>
                <button type="button" disabled={!plane} onClick={() => sec && p.section.setSection({ ...sec, on: false })} data-testid="mv-cut-off">
                  Off
                </button>
              </div>
              {plane && span && sec && (
                <label className="mv-slider">
                  <span>Move the cut</span>
                  <input
                    type="range"
                    min={Math.floor(span.min)}
                    max={Math.ceil(span.max)}
                    step={Math.max(1, Math.round((span.max - span.min) / 400))}
                    value={plane.offset}
                    onChange={(e) => p.section.setSection(setPlane(sec, sec.active, { ...plane, offset: Number(e.target.value) }))}
                    data-testid="mv-cut-slider"
                  />
                </label>
              )}
              {!plane && <p>Cut the model open to see inside: Plan cuts it level, like a floor plan.</p>}
            </div>
          )}
          {sheet === "parts" && (
            <div className="mv-parts">
              <ul>
                {p.parts.map((pt) => (
                  <li key={pt.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={!hidden.has(pt.id)}
                        onChange={(e) =>
                          setHidden((h) => {
                            const n = new Set(h);
                            if (e.target.checked) n.delete(pt.id);
                            else n.add(pt.id);
                            return n;
                          })
                        }
                        data-testid={`mv-part-${pt.id}`}
                      />
                      {pt.label}
                    </label>
                  </li>
                ))}
              </ul>
              {p.parts.length === 0 && <p>One {p.partsNoun === "bodies" ? "body" : "part"}: nothing to hide.</p>}
              <button type="button" disabled={!hidden.size} onClick={() => setHidden(new Set())} data-testid="mv-parts-all">
                Show all
              </button>
            </div>
          )}
          {sheet === "notes" && <div className="mv-notes">{p.vrNotes}</div>}
        </div>
      )}
      <nav className="mv-bar" aria-label="Viewer">
        {btn("views", "iso", "Views")}
        {btn("measure", "measure", "Measure")}
        {btn("section", "section", "Section")}
        {btn("parts", "eye", "Parts")}
        {p.vrNoteCount > 0 && btn("notes", "perspective", "VR notes", p.vrNoteCount)}
      </nav>
    </div>
  );
}

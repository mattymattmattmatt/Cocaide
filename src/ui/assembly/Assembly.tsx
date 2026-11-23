// The Assembly tab: its command bar, the tree of components and mates, the
// assembly in the 3D view, and the properties of what is selected (a
// component's place, a mate's type and value, the mates the selection can
// make, interference, the parts list).

import { useMemo, useState, type ReactNode } from "react";
import { SELF } from "../../doc/assembly";
import { MATE_TYPES } from "../../doc/types";
import type { MateType, Vec3 } from "../../doc/types";
import { Field, NumberInput, Vec3Input } from "../fields";
import { Icon, type IconName } from "../icons";
import { SidePanel } from "../SidePanel";
import { MenuItem, ToolButton, ToolMenu } from "../tools";
import { Viewport } from "../Viewport";
import type { PickTarget } from "../model/selection";
import type { AssemblyWorkspace } from "./useAssembly";
import type { SectionControl } from "../evaluate/useSection";
import { MeasurePanel, SectionPanel } from "../evaluate/EvaluatePanels";
import { itemName, measure, measureItems, type MeasureItem } from "../evaluate/measure";
import { meshClosest } from "../evaluate/meshDistance";
import type { EvalOverlay } from "../viewport/evalLayer";
import type { VrViewProps } from "../vr/types";
import { EMPTY_SELECTION } from "../model/selection";
import { addPlane, sectionChoices } from "../evaluate/section";
import type { RebuildView } from "../../worker/protocol";
import { AppearanceChip, AppearancePicker, describeAppearance, sourceWords } from "../appearance/AppearancePicker";

const MATE_WORDS: Record<MateType, { label: string; icon: IconName; hint: string }> = {
  coincident: { label: "Coincident", icon: "coincident", hint: "Two faces flat against each other (or an edge on a face, two axes in line)" },
  concentric: { label: "Concentric", icon: "concentric", hint: "Two round faces or edges on one axis: a pin in a hole" },
  distance: { label: "Distance", icon: "dimension", hint: "Two faces held apart by a distance" },
  parallel: { label: "Parallel", icon: "parallel", hint: "Two faces or edges kept parallel" },
  perpendicular: { label: "Perpendicular", icon: "perpendicular", hint: "Two faces or edges kept square" },
  angle: { label: "Angle", icon: "angle", hint: "Two faces or edges at an angle" },
  tangent: { label: "Tangent", icon: "tangent", hint: "A round face touching a flat one, or two round faces touching (side by side, or flipped: one inside the other)" },
};

export function AssemblyBar({ a, undo, redo, canUndo, canRedo, onDrawing, section }: { a: AssemblyWorkspace; undo(): void; redo(): void; canUndo: boolean; canRedo: boolean; onDrawing?: () => void; section?: SectionControl }) {
  const has = !!a.asm?.components.length;
  const sel = a.item?.kind === "component" ? a.asm?.components.find((k) => k.id === a.item!.id) : undefined;
  const ready = a.mateChoices.some((c) => c.ok);
  return (
    <div className="toolbar command-manager assembly-bar" role="toolbar" aria-label="Assembly">
      <div className="cm-pinned">
        <ToolButton icon="undo" label="Undo" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" testId="undo" />
        <ToolButton icon="redo" label="Redo" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)" testId="redo" />
      </div>
      <span className="sep cm-sep" />
      <div className="cm-body">
        <div className="cm-tools">
          <span className="cm-group">
            <ToolMenu icon="import" label="Insert" title="Put a part in the assembly" testId="asm-insert">
              {(close) => (
                <>
                  <MenuItem icon="model" label="This part" hint="The part of this document (its Model tab)" onClick={() => (close(), a.insertSelf())} testId="asm-insert-self" />
                  <MenuItem icon="open" label="From a file…" hint="A .cocaide.json part or a STEP file (.step, .stp): it is carried in this file, and its holes and faces mate like any" onClick={() => (close(), void a.insertFile())} testId="asm-insert-file" />
                  {a.examples.map((name) => (
                    <MenuItem key={name} icon="examples" label={`Example: ${name}`} onClick={() => (close(), a.insertExample(name))} testId={`asm-insert-example-${name.replace(/\W+/g, "-")}`} />
                  ))}
                </>
              )}
            </ToolMenu>
            <ToolMenu icon="mate" label="Mate" title={ready ? "Mate the two things selected" : "Select a face or edge of one component, then Ctrl-click one of another"} testId="asm-mate" disabled={!has}>
              {(close) => (
                <>
                  {a.mateChoices.map((c) => (
                    <MenuItem key={c.type} icon={MATE_WORDS[c.type].icon} label={MATE_WORDS[c.type].label} hint={c.ok ? MATE_WORDS[c.type].hint : c.why} disabled={!c.ok} onClick={() => (close(), a.mate(c.type))} testId={`asm-mate-${c.type}`} />
                  ))}
                </>
              )}
            </ToolMenu>
          </span>
          <span className="cm-group">
            <span className="sep" />
            <ToolButton icon="fix" label={sel?.fixed ? "Float" : "Fix"} onClick={() => sel && a.editComponent(sel.id, { fixed: !sel.fixed }, `${sel.fixed ? "Float" : "Fix"} ${sel.id}`, false)} disabled={!sel} pressed={!!sel?.fixed} title={sel ? (sel.fixed ? "Let it move: mates move it" : "Hold it where it is: mates move the others to it") : "Select a component"} testId="asm-fix" />
            <ToolButton icon={sel?.hidden ? "eye" : "eyeOff"} label={sel?.hidden ? "Show" : "Hide"} onClick={() => sel && a.editComponent(sel.id, { hidden: !sel.hidden }, `${sel.hidden ? "Show" : "Hide"} ${sel.id}`, false)} disabled={!sel} title="Hide or show the selected component" testId="asm-hide" />
            <ToolButton
              icon="seeThrough"
              label="Transparent"
              onClick={() => sel && a.editComponent(sel.id, { transparent: !sel.transparent }, `${sel.transparent ? "Opaque" : "Transparent"} ${sel.id}`, false)}
              disabled={!sel}
              pressed={!!sel?.transparent}
              title={sel ? (sel.transparent ? "Make it solid again" : "See through it, and click through it to faces inside or behind it (to mate them)") : "Select a component"}
              testId="asm-transparent"
            />
            <ToolButton
              icon="measure"
              label="Measure"
              onClick={() => {
                a.setMeasuring(!a.measuring);
                if (!a.measuring) a.setSelection(EMPTY_SELECTION);
              }}
              disabled={!has}
              pressed={a.measuring}
              title="Measure what you click, across components: one face or edge for its size, two for the distance and angle between them (stays on while you pick)"
              testId="asm-measure"
            />
            {section && (
              <ToolButton
                icon="section"
                label="Section"
                onClick={section.toggleTool}
                disabled={!has}
                pressed={!!section.section?.on}
                title="Cut the assembly open: a plane (or up to three) through it, the cut faces hatched in each component's colour; drag its arrow to move it"
                testId="asm-section"
              />
            )}
            <ToolButton
              icon="isolate"
              label={a.isolated ? "Exit isolate" : "Isolate"}
              onClick={() => a.setIsolated(a.isolated ? null : sel ? [sel.id, ...(a.selection.faces.length || a.selection.edges.length ? a.selectedComponents().filter((id) => id !== sel.id) : [])] : null)}
              disabled={!a.isolated && !sel}
              pressed={!!a.isolated}
              title={a.isolated ? "Show every component again" : sel ? "Show only this component (and the one picked with it), the rest hidden for now" : "Select a component"}
              testId="asm-isolate"
            />
            <ToolButton icon="trash" label="Delete" onClick={() => a.item && a.remove(a.item)} disabled={!a.item} title="Delete the selected component (and its mates) or mate" testId="asm-delete" />
          </span>
          <span className="cm-group">
            <span className="sep" />
            <ToolButton icon="check" label="Solve" onClick={a.resolve} disabled={!a.solve || a.solve.solved} title={a.solve && !a.solve.solved ? "Move the components so the mates hold (after the parts changed)" : "Every mate holds"} testId="asm-solve" />
            <ToolButton icon="diagnose" label="Check" onClick={() => void a.check()} disabled={!a.asm?.components.length || !!a.busy} title="Find what's wrong: mates that don't hold, parts held by nothing or free to slide, parts that overlap" testId="asm-check" />
            <ToolButton
              icon="explode"
              label={a.exploded ? "Collapse view" : "Explode"}
              onClick={a.toggleExplode}
              disabled={!a.asm || a.asm.components.length < 2}
              pressed={a.exploded}
              title={a.exploded ? "Back to the assembled view (the explode steps are kept for drawings)" : "Move the parts apart along their mates (worked out the first time; kept in the file for exploded drawing views)"}
              testId="asm-explode"
            />
            <ToolButton icon="combine" label="Interference" onClick={() => void a.interference()} disabled={!a.asm || a.asm.components.length < 2 || !!a.busy} title="Find components that overlap" testId="asm-interference" />
            <ToolButton icon="drawing" label="Make drawing" onClick={() => onDrawing?.()} disabled={!has || !!a.busy} title="A drawing sheet of the assembly: front, top, an exploded iso, the BOM and balloons" testId="asm-make-drawing" />
            <ToolButton icon="export" label="Export STEP" onClick={() => void a.exportStep()} disabled={!has || !!a.busy} title="The assembly as one STEP file: each component a named solid where it sits" testId="asm-export-step" />
          </span>
        </div>
      </div>
    </div>
  );
}

export function AssemblyMain({
  a,
  display,
  onDisplay,
  section,
  sectionView,
  vr,
  onEditPart,
}: {
  a: AssemblyWorkspace;
  /** Edit a part carried in the file (by its key) on the Model tab; "self" goes to the Model tab. */
  onEditPart?: (key: string) => void;
  /** The VR walkthrough's start point and placing it. */
  vr?: VrViewProps;
  display?: Parameters<typeof Viewport>[0]["display"];
  onDisplay?: Parameters<typeof Viewport>[0]["onDisplay"];
  /** The assembly's section view and the view its box comes from. */
  section?: SectionControl;
  sectionView?: RebuildView;
}) {
  const comps = a.asm?.components ?? [];
  const status = new Map((a.solve?.mates ?? []).map((m) => [m.id, m]));
  // Measure: the picked faces and edges, the closest points between two from the placed parts' shapes.
  const measured = useMemo(() => {
    if (!a.measuring) return null;
    const v = a.scene.view;
    const items = measureItems(a.selection, v.faces, v.edges);
    const ref = (it: MeasureItem) => (it.kind === "face" ? { kind: "face" as const, index: it.index } : it.kind === "edge" ? { kind: "edge" as const, index: it.index } : null);
    const ra = items.length === 2 ? ref(items[0]) : null;
    const rb = items.length === 2 ? ref(items[1]) : null;
    const closest = ra && rb && v.mesh ? meshClosest(v.mesh, ra, rb) : null;
    const r = measure(items, closest);
    // Which component each one is on.
    const owner = (it: MeasureItem) => (it.kind === "face" ? a.scene.faceOwner[it.index]?.component : it.kind === "edge" ? a.scene.edgeOwner[it.index]?.component : undefined);
    const named = (it: MeasureItem) => `${itemName(it)}${owner(it) ? ` of ${owner(it)}` : ""}`;
    const title = items.length === 1 ? named(items[0]) : items.length === 2 ? `${named(items[0])} to ${named(items[1])}` : r.title;
    return { ...r, title: title.charAt(0).toUpperCase() + title.slice(1) };
  }, [a.measuring, a.selection, a.scene]);
  const overlay = useMemo<EvalOverlay | null>(() => (measured && (measured.line || measured.points.length) ? { lines: measured.line ? [measured.line] : [], points: measured.points, centreOfMass: null } : null), [measured]);
  // The selected component's faces light up, so it is plain which one it is.
  const selectedId = a.item?.kind === "component" ? a.item.id : null;
  const body = selectedId ? a.scene.view.bodies.find((b) => b.name === selectedId) : undefined;
  const peek: PickTarget[] | null = body && !a.selection.faces.length && !a.selection.edges.length ? a.scene.view.faces.slice(body.faces[0], body.faces[1]).map((f) => ({ kind: "face", index: f.index, point: f.centroid })) : null;
  return (
    <>
      <aside className="side left assembly-tree" data-testid="assembly-tree">
        <div className="panel-title">Assembly</div>
        {!comps.length ? (
          <p className="muted small">No components yet: Insert puts a part in.</p>
        ) : (
          <>
            <div className="asm-heading">Components</div>
            <ul className="asm-list">
              {comps.map((k) => (
                <li key={k.id} className={a.item?.kind === "component" && a.item.id === k.id ? "selected" : ""} data-testid={`asm-component-${k.id}`}>
                  <button className="asm-row" onClick={() => a.setItem({ kind: "component", id: k.id })}>
                    {(() => {
                      // Its colour as the view shows it: a glance ties the row to the part on screen.
                      const info = a.componentLook(k.id);
                      return <AppearanceChip look={info.own ?? info.inherited?.appearance ?? null} fallback={info.fallback} size={12} title={info.own ? describeAppearance(info.own) : undefined} />;
                    })()}
                    <span className="asm-name">{k.id}</span>
                    <span className="muted small">{a.partName(k.part)}</span>
                    {k.fixed && <span className="asm-badge" title="Fixed">(f)</span>}
                  </button>
                  <button className="asm-eye" title={k.hidden ? "Show" : "Hide"} onClick={() => a.editComponent(k.id, { hidden: !k.hidden }, `${k.hidden ? "Show" : "Hide"} ${k.id}`, false)} data-testid={`asm-eye-${k.id}`}>
                    <Icon name={k.hidden ? "eyeOff" : "eye"} size={14} />
                  </button>
                </li>
              ))}
            </ul>
            <div className="asm-heading">Mates</div>
            {!a.asm?.mates?.length ? (
              <p className="muted small">None yet: select a face of one component, Ctrl-click one of another, then Mate.</p>
            ) : (
              <ul className="asm-list">
                {a.asm.mates.map((m) => {
                  const st = status.get(m.id);
                  const bad = m.suppressed ? false : st ? !st.ok : false;
                  return (
                    <li key={m.id} className={`${a.item?.kind === "mate" && a.item.id === m.id ? "selected" : ""}${bad ? " failed" : ""}${m.suppressed ? " suppressed" : ""}`} data-testid={`asm-mate-${m.id}`}>
                      <button className="asm-row" onClick={() => a.setItem({ kind: "mate", id: m.id })} title={st?.problem ?? (bad ? "Doesn't hold: Solve, or check the mates fighting it" : undefined)}>
                        <Icon name={bad ? "alert" : MATE_WORDS[m.type].icon} size={14} />
                        <span className="asm-name">{m.id}</span>
                        <span className="muted small">
                          {m.a.component} ↔ {m.b.component}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </aside>
      <section className="center">
        <Viewport
          view={a.scene.view}
          fitToken={a.fitToken}
          selection={a.selection}
          onPick={a.pick}
          peek={peek}
          handles={a.handles}
          onHandle={a.onHandle}
          memoryKey={`${typeof a.doc?.name === "string" ? a.doc.name : "part"}#assembly`}
          display={display}
          onDisplay={onDisplay}
          clearBodies={a.clearBodies}
          hiddenBodies={a.isolateHides}
          appearances={a.appearances}
          overlay={overlay}
          vr={vr}
          {...(section ? { section: section.section, onSection: section.setSection, onSectionToggle: section.toggleShown, onSectionPanel: section.openPanel } : {})}
        />
        {a.isolated && (
          <div className="view-hint asm-isolate-hint" role="status" data-testid="asm-isolate-hint">
            <Icon name="isolate" />
            Isolated: {a.isolated.join(", ")}
            <button onClick={() => a.setIsolated(null)} data-testid="asm-isolate-exit">
              Exit isolate
            </button>
          </div>
        )}
        {a.busy && <div className="asm-busy">{a.busy}</div>}
      </section>
      <SidePanel title="Properties" testId="assembly-props">
        {measured && (
          <div className="eval-panels eval-dock" data-testid="asm-measure-dock">
            <MeasurePanel result={measured} busy={false} error={null} onClose={() => a.setMeasuring(false)} onClear={() => a.setSelection(EMPTY_SELECTION)} />
          </div>
        )}
        {section?.section?.on && section.panelOpen && (
          <div className="eval-panels eval-dock" data-testid="asm-section-dock">
            <SectionPanel
              section={section.section}
              choices={sectionChoices({})}
              faceOk={a.selection.faces.length === 1 && a.scene.view.faces[a.selection.faces[0]]?.type === "plane"}
              box={sectionView?.measurements?.boundingBox ?? null}
              bodies={(a.asm?.components ?? []).filter((k) => !k.hidden).map((k) => k.id)}
              onPlane={section.planeTo}
              onChange={section.setSection}
              onAdd={() => section.section && section.setSection(addPlane(section.section, {}, sectionView?.measurements?.boundingBox ?? null))}
              onClose={section.close}
              noun="components"
            />
          </div>
        )}
        <AssemblyProps a={a} onEditPart={onEditPart} />
      </SidePanel>
    </>
  );
}

function AssemblyProps({ a, onEditPart }: { a: AssemblyWorkspace; onEditPart?: (key: string) => void }) {
  const k = a.item?.kind === "component" ? a.asm?.components.find((x) => x.id === a.item!.id) : undefined;
  const m = a.item?.kind === "mate" ? a.asm?.mates?.find((x) => x.id === a.item!.id) : undefined;
  const st = m ? a.solve?.mates.find((x) => x.id === m.id) : undefined;
  const picking = !a.measuring && a.selection.faces.length + a.selection.edges.length > 0;
  const sections: ReactNode[] = [];
  if (picking) {
    sections.push(
      <section key="mate" className="asm-section" data-testid="asm-mate-panel">
        <h3>Mate</h3>
        <p className="muted small">{a.mateChoices.find((c) => c.ok) ? "Choose how the two selected things go together:" : a.mateChoices[0]?.why}</p>
        <div className="asm-mate-grid">
          {a.mateChoices.map((c) => (
            <button key={c.type} disabled={!c.ok} title={c.ok ? MATE_WORDS[c.type].hint : c.why} onClick={() => a.mate(c.type)} data-testid={`asm-mate-btn-${c.type}`}>
              <Icon name={MATE_WORDS[c.type].icon} size={16} />
              {MATE_WORDS[c.type].label}
            </button>
          ))}
        </div>
      </section>,
    );
  }
  if (k) {
    const at = (k.at ?? [0, 0, 0]) as Vec3;
    const rot = (k.rotation ?? [0, 0, 0]) as Vec3;
    sections.push(
      <section key="comp" className="asm-section" data-testid="asm-component-props">
        <h3>{k.id}</h3>
        <Field label="Part">
          <span className="readout">{k.part === SELF ? `${a.partName(k.part)} (this part)` : a.partName(k.part)}</span>
        </Field>
        <div className="asm-part-actions">
          <button type="button" onClick={() => onEditPart?.(k.part)} title={k.part === SELF ? "This document's own part: on the Model tab" : "Open this part on the Model tab, change it with every tool, then Done puts it back here (every component using it updates)"} data-testid="asm-edit-part">
            <Icon name="model" size={14} />
            Edit part
          </button>
          {k.part !== SELF && (
            <button type="button" onClick={() => void a.replacePart(k.part)} title="Put a newer copy of the part in from its file (.cocaide.json or STEP): every component using it updates, where it is; mates find their faces again where they still exist" data-testid="asm-replace-part">
              <Icon name="open" size={14} />
              Replace from file…
            </button>
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={!!k.fixed} onChange={(e) => a.editComponent(k.id, { fixed: e.target.checked }, `${e.target.checked ? "Fix" : "Float"} ${k.id}`, false)} data-testid="asm-prop-fixed" />
          Fixed (mates move the others to it)
        </label>
        <Field label="Position" unit="mm">
          <Vec3Input value={at} onCommit={(v) => a.editComponent(k.id, { at: v.map(Number) as Vec3 }, `Move ${k.id}`)} testId="asm-prop-at" />
        </Field>
        <Field label="Rotation" unit="°">
          <Vec3Input value={rot} onCommit={(v) => a.editComponent(k.id, { rotation: v.map(Number) as Vec3 }, `Turn ${k.id}`)} testId="asm-prop-rotation" />
        </Field>
        <ComponentLook a={a} id={k.id} />
        <p className="muted small">Turned about X, then Y, then Z, then moved. A mated component goes back where its mates hold it.</p>
        {a.holeCopyPlan && (
          <div className="asm-copy-holes">
            <button onClick={a.copyToHoles} data-testid="asm-copy-holes" title="Put a copy of this component, with its mates, in each of the other free holes of its size on that part">
              <Icon name="circularPattern" size={14} />
              Copy to {a.holeCopyPlan.copies.length} matching hole{a.holeCopyPlan.copies.length === 1 ? "" : "s"}
            </button>
          </div>
        )}
      </section>,
    );
  }
  if (a.exploded && a.asm) {
    const off = k ? (a.offsets.get(k.id) ?? [0, 0, 0]) : null;
    sections.push(
      <section key="explode" className="asm-section" data-testid="asm-explode-props">
        <h3>Exploded view</h3>
        {k && off && (
          <Field label={`${k.id} moved`} unit="mm">
            <Vec3Input value={off as Vec3} onCommit={(v) => a.setExplodeOffset(k.id, v.map(Number) as Vec3)} testId="asm-explode-offset" />
          </Field>
        )}
        <div className="asm-explode-actions">
          <button onClick={() => a.reExplode(1)} data-testid="asm-explode-again" title="Work the moves out again from the mates">
            Explode again
          </button>
          <button onClick={() => a.reExplode(1.6)} data-testid="asm-explode-farther" title="Further apart">
            Farther
          </button>
          <button onClick={() => a.reExplode(0.6)} title="Closer together">
            Closer
          </button>
          <button onClick={a.clearExplode} data-testid="asm-explode-clear" title="Remove the explode steps">
            Clear
          </button>
        </div>
        <p className="muted small">{a.asm.explode?.length ?? 0} step{a.asm.explode?.length === 1 ? "" : "s"}. Select a component to move it on its own. A drawing view with "Exploded" shows this.</p>
      </section>,
    );
  }
  if (k && a.suggestions.length) {
    sections.push(
      <section key="suggest" className="asm-section" data-testid="asm-suggestions">
        <h3>Suggested mates</h3>
        <p className="muted small">Found from the parts' holes, bosses and faces:</p>
        <ul className="asm-suggest">
          {a.suggestions.map((sg, i) => (
            <li key={i}>
              <span>{sg.what}</span>
              <button onClick={() => a.applySuggestion(sg)} title={sg.mates.map((x) => x.type).join(" + ")} data-testid={`asm-suggest-apply-${i}`}>
                Apply
              </button>
            </li>
          ))}
        </ul>
      </section>,
    );
  }
  if (m) {
    sections.push(
      <section key="m" className="asm-section" data-testid="asm-mate-props">
        <h3>{m.id}</h3>
        <Field label="Type">
          <select value={m.type} onChange={(e) => a.editMate(m.id, { type: e.target.value as MateType, ...(e.target.value === "distance" ? { value: m.value ?? 10 } : e.target.value === "angle" ? { value: m.value ?? 45 } : { value: undefined }) }, `Edit ${m.id}`)} data-testid="asm-prop-mate-type">
            {MATE_TYPES.map((t) => (
              <option key={t} value={t}>
                {MATE_WORDS[t].label}
              </option>
            ))}
          </select>
        </Field>
        {(m.type === "distance" || m.type === "angle") && (
          <Field label={m.type === "distance" ? "Distance" : "Angle"} unit={m.type === "distance" ? "mm" : "°"}>
            <NumberInput value={m.value ?? 0} onCommit={(v) => a.editMate(m.id, { value: Number(v) }, `Edit ${m.id}`)} testId="asm-prop-mate-value" />
          </Field>
        )}
        {(() => {
          // The way round, and a flip (aligned or opposed, face to face or the same way, an angle the other way, a distance's side).
          const f = a.flipsOf(m);
          return (
            <>
              {f.flip && (
                <Field label="Way round">
                  <span className="asm-flip">
                    <span className="readout" data-testid="asm-prop-mate-way">
                      {f.flip.now}
                    </span>
                    <button type="button" onClick={() => a.editMate(m.id, f.flip!.patch, `Flip ${m.id}`)} title="The other way round" data-testid="asm-prop-mate-flip">
                      <Icon name="mirror" size={14} />
                      Flip
                    </button>
                  </span>
                </Field>
              )}
              {f.side && (
                <Field label="Side">
                  <span className="asm-flip">
                    <span className="readout" data-testid="asm-prop-mate-side">
                      {f.side.now}
                    </span>
                    <button type="button" onClick={() => a.editMate(m.id, f.side!.patch, `Flip ${m.id} to the other side`)} title="To the other side of the first face" data-testid="asm-prop-mate-flip-side">
                      <Icon name="mirror" size={14} />
                      Flip side
                    </button>
                  </span>
                </Field>
              )}
            </>
          );
        })()}
        <label className="check">
          <input type="checkbox" checked={!!m.suppressed} onChange={(e) => a.editMate(m.id, { suppressed: e.target.checked }, `${e.target.checked ? "Suppress" : "Unsuppress"} ${m.id}`)} data-testid="asm-prop-mate-suppressed" />
          Suppressed
        </label>
        <Field label="Between">
          <span className="readout">
            {m.a.component} ↔ {m.b.component}
          </span>
        </Field>
        <p className={`small ${st && !st.ok ? "error-text" : "muted"}`} data-testid="asm-prop-mate-status">
          {m.suppressed ? "Suppressed: it holds nothing." : !st ? "…" : st.ok ? "Holds." : (st.problem ?? `Doesn't hold (${st.error < 1e6 ? `${Math.round(st.error * 1000) / 1000} off` : "can't"}): another mate fights it, or the parts changed (Solve).`)}
        </p>
      </section>,
    );
  }
  if (a.checked) {
    sections.push(
      <section key="check" className="asm-section" data-testid="asm-check-results">
        <h3>Check</h3>
        {a.checked.issues.length ? (
          <ul className="asm-plain error-text">
            {a.checked.issues.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Every mate holds, and every part is held.</p>
        )}
        <ul className="asm-plain">
          {a.checked.freedom.map((f) => (
            <li key={f.id}>
              <b>{f.id}</b>: {f.fixed ? "fixed" : f.motions.length === 0 ? "fully placed" : f.motions.length === 6 ? "free (nothing holds it)" : `can still ${f.motions.join("; ")}`}
            </li>
          ))}
        </ul>
        <p className="muted small">A part that can still turn or slide is fine when it should (a hinge, a slider); otherwise add a mate that stops it.</p>
      </section>,
    );
  }
  if (a.clashes) {
    sections.push(
      <section key="clash" className="asm-section" data-testid="asm-clashes">
        <h3>Interference</h3>
        {a.clashes.length ? (
          <ul className="asm-plain">
            {a.clashes.map((c) => (
              <li key={c.components.join("|")} className={c.expected ? "muted" : "error-text"}>
                {c.components[0]} and {c.components[1]}: {Math.round(c.volume * 1000) / 1000} mm³{c.expected ? ` — expected: ${c.expected}` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">No components overlap.</p>
        )}
      </section>,
    );
  }
  if (a.asm?.components.length) {
    sections.push(
      <section key="bom" className="asm-section" data-testid="asm-bom">
        <h3>Parts list</h3>
        <table className="asm-bom">
          <thead>
            <tr>
              <th>Item</th>
              <th>Part</th>
              <th>Qty</th>
            </tr>
          </thead>
          <tbody>
            {a.bom.map((r, i) => (
              <tr key={r.part}>
                <td>{i + 1}</td>
                <td>{r.name}</td>
                <td>{r.qty}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>,
    );
  }
  if (!sections.length) return <section className="asm-section"><p className="muted small">Insert a part to start. Select a component in the tree or the view to place it; select a face of one and Ctrl-click one of another to mate them.</p></section>;
  return <>{sections}</>;
}

/** A component's colour: its own over its part's, picked from the appearance picker. */
function ComponentLook({ a, id }: { a: AssemblyWorkspace; id: string }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const info = a.componentLook(id);
  const showing = info.own ?? info.inherited?.appearance ?? null;
  return (
    <Field label="Appearance">
      <span className="asm-look">
        <button
          type="button"
          className="look-button"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setAt({ x: r.left, y: r.bottom + 4 });
          }}
          aria-label={`Appearance of component ${id}`}
          data-testid="asm-prop-look"
        >
          <AppearanceChip look={showing} fallback={info.fallback} inherited={!info.own} size={18} />
        </button>
        <span className="muted small">{info.own ? describeAppearance(info.own) : info.inherited ? `From ${sourceWords(info.inherited)}` : "Its part's colours"}</span>
      </span>
      {at && (
        <AppearancePicker
          x={at.x}
          y={at.y}
          {...info}
          inherited={info.inherited}
          onChange={(look) => a.editComponent(id, { appearance: look ?? undefined }, look ? `Colour ${id}` : `${id}: its part's colours`, false)}
          onPreview={(look) => a.setLookTry(look === undefined ? null : { id, look })}
          onClose={() => {
            setAt(null);
            a.setLookTry(null);
          }}
          testId="asm-look-picker"
        />
      )}
    </Field>
  );
}


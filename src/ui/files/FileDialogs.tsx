// The questions a file asks when it is opened or dropped (Phase P): a STEP
// file dropped on the view (a new part, or a body in this one), and a DXF
// drawing (which layers, where it goes, its units) before it becomes a sketch
// or goes into the sketch being edited, with a preview of what comes in.

import { useMemo, useState } from "react";
import type { DxfEntity, DxfRead } from "../../io/dxf";
import { skippedText, unitScale } from "../../io/dxf";
import { boundsOf, entityPoints } from "../../io/dxfGeom";
import type { InsertOptions } from "../../io/dxfSketch";
import { sizeText } from "../../features/import/doc";
import { Icon } from "../icons";

/** A STEP file dropped on the view: open it as a new part, or put its solids in this part as bodies. */
export function StepDropDialog({ fileName, size, onOpen, onInsert, onCancel, canInsert }: { fileName: string; size: number; onOpen(): void; onInsert(): void; onCancel(): void; canInsert: boolean }) {
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal file-dialog" role="dialog" aria-label="Open a STEP file" data-testid="step-drop-dialog" onKeyDown={(e) => e.key === "Escape" && onCancel()}>
        <h2>
          <Icon name="import" /> {fileName}
        </h2>
        <p className="muted small">A STEP file ({sizeText(size)}). Each solid in it becomes a body you can drill, cut, fillet and build on.</p>
        <div className="file-choices">
          <button type="button" className="file-choice" onClick={onOpen} data-testid="step-open-new" autoFocus>
            <Icon name="new" />
            <span>
              <strong>Open as a new part</strong>
              <span className="muted small">A part named after the file, holding it. It replaces the part you have: Save that first if you want to keep it</span>
            </span>
          </button>
          <button type="button" className="file-choice" onClick={onInsert} disabled={!canInsert} data-testid="step-insert-body" title={canInsert ? undefined : "Fix the document first"}>
            <Icon name="combine" />
            <span>
              <strong>Insert into this part as a body</strong>
              <span className="muted small">At the origin; move or turn it in Properties</span>
            </span>
          </button>
        </div>
        <div className="modal-buttons">
          <span className="sep" />
          <button type="button" onClick={onCancel} data-testid="step-drop-cancel">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Where a DXF goes: into the open sketch, a new part, or a new sketch on Top of this part. */
export type DxfTarget = "sketch" | "newPart" | "newSketch";

const UNIT_CHOICES: [string, string][] = [
  ["file", "As the file says"],
  ["4", "Millimetres"],
  ["1", "Inches (× 25.4)"],
  ["5", "Centimetres (× 10)"],
  ["6", "Metres (× 1000)"],
];

/**
 * A DXF drawing about to come in: its layers to take (a layer the file had
 * off starts unticked), its units (as the file says, or set by hand when it
 * says nothing or says wrong), whether to centre it on the sketch origin, and
 * a preview. `targets`: the places it may go, the first the default.
 */
export function DxfInsertDialog({
  fileName,
  read,
  targets,
  onInsert,
  onCancel,
}: {
  fileName: string;
  read: DxfRead;
  targets: DxfTarget[];
  onInsert(target: DxfTarget, opts: InsertOptions): void;
  onCancel(): void;
}) {
  const [layers, setLayers] = useState<Set<string>>(() => new Set(read.layers.filter((l) => !l.off).map((l) => l.name)));
  const [centre, setCentre] = useState(false);
  const [units, setUnits] = useState("file");
  const [target, setTarget] = useState<DxfTarget>(targets[0]);
  // The file's numbers are already in mm by its own units; a units choice rescales from there.
  const scale = units === "file" ? 1 : (unitScale(Number(units)) ?? 1) / read.units.scale;
  const shown = useMemo(() => read.entities.filter((e) => e.type !== "text" && layers.has(e.layer ?? "0")), [read, layers]);
  const box = useMemo(() => boundsOf(shown), [shown]);
  const size = box ? [(box.max[0] - box.min[0]) * scale, (box.max[1] - box.min[1]) * scale] : null;
  const skipped = skippedText(read.skipped);
  const label: Record<DxfTarget, string> = { sketch: "Insert into this sketch", newPart: "Open as a new part (a sketch on Top)", newSketch: "Add to this part as a sketch on Top" };
  const fmt = (x: number) => (Math.round(x * 100) / 100).toLocaleString("en-US");
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        className="modal file-dialog dxf-dialog"
        role="dialog"
        aria-label="Insert a DXF drawing"
        data-testid="dxf-dialog"
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        onSubmit={(e) => {
          e.preventDefault();
          if (layers.size) onInsert(target, { layers: [...layers], centre, ...(scale !== 1 ? { scale } : {}) });
        }}
      >
        <h2>
          <Icon name="dxfInsert" /> {fileName}
        </h2>
        <DxfPreview entities={shown} />
        <p className="muted small" data-testid="dxf-summary">
          {shown.length} entit{shown.length === 1 ? "y" : "ies"}
          {size ? `, ${fmt(size[0])} × ${fmt(size[1])} mm` : ""}
          {skipped ? `; ${skipped} left out` : ""}.
          {read.units.assumed ? " The file does not say its units: read as millimetres." : read.units.scale !== 1 ? ` In ${read.units.name}: converted to mm.` : ""}
        </p>
        {read.warnings.map((w) => (
          <p key={w} className="hint warn small">
            {w}
          </p>
        ))}
        {/* One layer needs no choice, unless the file had it off (it starts unticked: tick it to insert). */}
        {(read.layers.length > 1 || read.layers.some((l) => l.off)) && (
          <fieldset className="dxf-layers" data-testid="dxf-layers">
            <legend>Layers</legend>
            {read.layers.map((l) => (
              <label key={l.name} title={l.off ? "Off or frozen in the file" : undefined}>
                <input
                  type="checkbox"
                  checked={layers.has(l.name)}
                  data-testid={`dxf-layer-${l.name}`}
                  onChange={(e) => {
                    const next = new Set(layers);
                    if (e.target.checked) next.add(l.name);
                    else next.delete(l.name);
                    setLayers(next);
                  }}
                />
                <span>{l.name}</span>
                <span className="muted small">
                  {l.count}
                  {l.off ? " · off in the file" : ""}
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <label className="row">
          <span>Units</span>
          <select value={units} onChange={(e) => setUnits(e.target.value)} data-testid="dxf-units">
            {UNIT_CHOICES.map(([v, l]) => (
              <option key={v} value={v}>
                {v === "file" ? `${l} (${read.units.assumed ? "not given: mm" : read.units.name})` : l}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={centre} onChange={(e) => setCentre(e.target.checked)} data-testid="dxf-centre" />
          <span>Centre on the sketch origin (else the drawing's origin goes on it)</span>
        </label>
        {targets.length > 1 && (
          <fieldset className="dxf-targets">
            {targets.map((t) => (
              <label key={t} className="check">
                <input type="radio" name="dxf-target" checked={target === t} onChange={() => setTarget(t)} data-testid={`dxf-target-${t}`} />
                <span>{label[t]}</span>
              </label>
            ))}
          </fieldset>
        )}
        <p className="muted small">Ends that meet are joined (coincident), level and plumb lines get horizontal and vertical, and smooth joints (a corner radius, a slot's end) tangent, so a closed outline extrudes at once and keeps its shape when edited.</p>
        <div className="modal-buttons">
          <span className="sep" />
          <button type="button" onClick={onCancel} data-testid="dxf-cancel">
            Cancel
          </button>
          {/* Focused, so Enter inserts and Escape cancels straight away. */}
          <button type="submit" className="primary" disabled={!layers.size || shown.length === 0} data-testid="dxf-insert" autoFocus>
            {target === "sketch" ? "Insert" : target === "newPart" ? "Open" : "Add sketch"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** The entities drawn small, fitted to a box, y up. */
function DxfPreview({ entities }: { entities: DxfEntity[] }) {
  const paths = useMemo(() => {
    const box = boundsOf(entities);
    if (!box) return null;
    const w = Math.max(box.max[0] - box.min[0], 1e-6);
    const h = Math.max(box.max[1] - box.min[1], 1e-6);
    const k = Math.min(400 / w, 180 / h);
    const tol = 0.5 / k;
    const d = entities
      .flatMap((e) => {
        if (e.type === "point") return [[e.at, e.at] as [number, number][]];
        const pts = entityPoints(e, tol);
        return pts.length ? [pts] : [];
      })
      .map((pts) => `M${pts.map(([x, y]) => `${((x - box.min[0]) * k).toFixed(1)} ${((box.max[1] - y) * k).toFixed(1)}`).join("L")}`)
      .join(" ");
    return { d, w: w * k, h: h * k };
  }, [entities]);
  if (!paths) return <div className="dxf-preview empty">Nothing on the layers ticked</div>;
  return (
    <svg className="dxf-preview" viewBox={`-6 -6 ${paths.w + 12} ${paths.h + 12}`} data-testid="dxf-preview" aria-label="Preview of the drawing">
      <path d={paths.d} fill="none" stroke="currentColor" strokeWidth={1.2} vectorEffect="non-scaling-stroke" strokeLinecap="round" />
    </svg>
  );
}

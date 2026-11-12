// Export bodies (the Bodies panel): the bodies to write to a STEP file, and
// where the file's axes go: the model's own, or a new origin (the bodies' box
// centre, the middle of its bottom, a point picked in the view, or typed) and
// which way is up and which way the front faces, for a program that wants Z up
// or Y up. It floats beside the view rather than blocking it, so a point or a
// face can be picked in the view and taken with "Use selected" while it is open.

import { useMemo, useState } from "react";
import type { Vec3 } from "../doc/types";
import { AXIS_DIRECTIONS, boxPoints, exportFrame, isIdentity, toFile, type ExportFrame, type UpConvention } from "../geom/exportFrame";
import { formatDirection } from "../geom/vec";
import { Icon } from "./icons";

type Box = { min: Vec3; max: Vec3 };
type OriginMode = "model" | "centre" | "bottom" | "point";

export interface ExportBodiesRequest {
  bodies: string[];
  frame?: ExportFrame;
  fileName: string;
}

interface Props {
  /** Every body of the part, in order. */
  bodies: string[];
  /** The bodies ticked at first (the selected ones, else all). */
  initial: string[];
  /** Each body's bounding box (model coordinates). */
  boxes: Record<string, Box | null>;
  /** What is selected in the view now: a point (a vertex, midpoint, centre, a face's centroid), a direction (a flat face's normal, a straight edge), the bodies it touches. */
  picked(): { point: Vec3 | null; dir: Vec3 | null; bodies: string[] };
  fileBase: string;
  onExport(r: ExportBodiesRequest): void;
  onClose(): void;
}

const fmt = (x: number) => (Math.round(x * 1000) / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 });
const same = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-9;
const axisId = (v: Vec3) => AXIS_DIRECTIONS.find((d) => same(d.dir, v))?.id ?? "custom";

export function ExportBodiesDialog({ bodies, initial, boxes, picked, fileBase, onExport, onClose }: Props) {
  const [chosen, setChosen] = useState<string[]>(initial.length ? initial : bodies);
  const [originMode, setOriginMode] = useState<OriginMode>("model");
  const [point, setPoint] = useState<Vec3>([0, 0, 0]);
  const [up, setUp] = useState<Vec3>([0, 0, 1]);
  const [front, setFront] = useState<Vec3>([0, -1, 0]);
  const [convention, setConvention] = useState<UpConvention>("zUp");
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const box = useMemo<Box | null>(() => {
    const list = chosen.map((b) => boxes[b]).filter((b): b is Box => !!b);
    if (!list.length) return null;
    return { min: [0, 1, 2].map((i) => Math.min(...list.map((b) => b.min[i]))) as Vec3, max: [0, 1, 2].map((i) => Math.max(...list.map((b) => b.max[i]))) as Vec3 };
  }, [chosen, boxes]);
  const origin: Vec3 = originMode === "model" ? [0, 0, 0] : originMode === "point" ? point : box ? boxPoints(box, up)[originMode === "centre" ? "centre" : "bottom"] : [0, 0, 0];
  const frame = exportFrame(origin, up, front, convention);
  const changed = typeof frame !== "string" && !isIdentity(frame);
  // The chosen bodies' size and place as the file will have them.
  const fileBox = useMemo(() => {
    if (!box || typeof frame === "string") return null;
    const pts: Vec3[] = [];
    for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) pts.push(toFile(frame, [x, y, z]));
    return [0, 1, 2].map((i) => [Math.min(...pts.map((p) => p[i])), Math.max(...pts.map((p) => p[i]))] as const);
  }, [box, frame]);

  const defaultName = `${fileBase}${chosen.length === bodies.length ? "" : `-${chosen.length === 1 ? chosen[0] : `${chosen.length}-bodies`}`}`;
  const setUpDir = (v: Vec3) => {
    setUp(v);
    // A front along the new up can't be: the first axis square to it instead.
    const f = front;
    const dot = Math.abs(v[0] * f[0] + v[1] * f[1] + v[2] * f[2]) / (Math.hypot(...v) * Math.hypot(...f) || 1);
    if (dot > 1 - 1e-6) setFront(AXIS_DIRECTIONS.find((d) => Math.abs(d.dir[0] * v[0] + d.dir[1] * v[1] + d.dir[2] * v[2]) < 1e-9)!.dir);
  };
  const useSelected = (what: "point" | "up" | "front" | "bodies") => {
    const p = picked();
    setProblem(null);
    if (what === "bodies") {
      if (!p.bodies.length) return setProblem("Select faces of the bodies in the view first (the Bodies filter, B, picks whole bodies).");
      return setChosen(bodies.filter((b) => p.bodies.includes(b)));
    }
    if (what === "point") {
      if (!p.point) return setProblem("Select a vertex, an edge's midpoint, a circle (its centre) or a face (its centre) in the view first.");
      setPoint(p.point);
      return setOriginMode("point");
    }
    if (!p.dir) return setProblem("Select a flat face (its normal) or a straight edge (its direction) in the view first.");
    if (what === "up") setUpDir(p.dir);
    else setFront(p.dir);
  };

  const dirPick = ({ label, value, onPick, testId, exclude }: { label: string; value: Vec3; onPick(v: Vec3): void; testId: string; exclude?: Vec3 }) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="row">
        <select
          value={axisId(value)}
          onChange={(e) => {
            const d = AXIS_DIRECTIONS.find((x) => x.id === e.target.value);
            if (d) onPick(d.dir);
          }}
          data-testid={testId}
        >
          {AXIS_DIRECTIONS.filter((d) => !exclude || Math.abs(d.dir[0] * exclude[0] + d.dir[1] * exclude[1] + d.dir[2] * exclude[2]) < 1 - 1e-6).map((d) => (
            <option key={d.id} value={d.id}>
              model {d.label}
            </option>
          ))}
          {axisId(value) === "custom" && <option value="custom">{formatDirection(value)} (picked)</option>}
        </select>
        <button type="button" className="small" onClick={() => useSelected(label === "Up" ? "up" : "front")} data-testid={`${testId}-selected`} title="Take it from the flat face or straight edge selected in the view">
          Use selected
        </button>
      </span>
    </label>
  );

  return (
    <div className="modal export-dialog floating" role="dialog" aria-label="Export bodies as STEP" data-testid="export-bodies" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <h2>
        <Icon name="export" /> Export bodies as STEP
        <button type="button" className="icon" aria-label="Close" onClick={onClose} style={{ marginLeft: "auto" }}>
          <Icon name="x" size={15} />
        </button>
      </h2>
      <fieldset>
        <legend>Bodies</legend>
        <span className="body-checks" data-testid="export-bodies-list">
          {bodies.map((b) => (
            <label key={b} className="check">
              <input type="checkbox" checked={chosen.includes(b)} onChange={(e) => setChosen(e.target.checked ? bodies.filter((x) => x === b || chosen.includes(x)) : chosen.filter((x) => x !== b))} data-testid={`export-body-${b}`} />
              {b}
            </label>
          ))}
        </span>
        <span className="row">
          <button type="button" className="small" onClick={() => setChosen(bodies)}>
            All
          </button>
          <button type="button" className="small" onClick={() => useSelected("bodies")} data-testid="export-bodies-selected">
            Use selected
          </button>
        </span>
      </fieldset>
      <fieldset>
        <legend>Origin</legend>
        <label className="field">
          <span className="field-label">The file's origin</span>
          <select value={originMode} onChange={(e) => setOriginMode(e.target.value as OriginMode)} data-testid="export-origin">
            <option value="model">the model's origin (as modelled)</option>
            <option value="centre">the centre of the bodies' box</option>
            <option value="bottom">the middle of the bodies' bottom (lowest along Up)</option>
            <option value="point">a point</option>
          </select>
        </label>
        {originMode === "point" && (
          <label className="field">
            <span className="field-label">Point (model)</span>
            <span className="row">
              {[0, 1, 2].map((i) => (
                <input
                  key={i}
                  type="number"
                  value={point[i]}
                  step="any"
                  onChange={(e) => setPoint(point.map((v, j) => (j === i ? Number(e.target.value) || 0 : v)) as Vec3)}
                  aria-label={"XYZ"[i]}
                  data-testid={`export-point-${"xyz"[i]}`}
                  style={{ width: 70 }}
                />
              ))}
            </span>
          </label>
        )}
        <button type="button" className="small" onClick={() => useSelected("point")} data-testid="export-origin-selected" title="A vertex, an edge's midpoint, a circle's centre or a face's centre selected in the view">
          Use selected point
        </button>
      </fieldset>
      <fieldset>
        <legend>Orientation</legend>
        {dirPick({ label: "Up", value: up, onPick: setUpDir, testId: "export-up" })}
        {dirPick({ label: "Front faces", value: front, onPick: setFront, testId: "export-front", exclude: up })}
        <label className="field">
          <span className="field-label">The file is</span>
          <select value={convention} onChange={(e) => setConvention(e.target.value as UpConvention)} data-testid="export-convention">
            <option value="zUp">Z up (most CAD and CAM): up is +Z, the front faces −Y</option>
            <option value="yUp">Y up (many mesh tools): up is +Y, the front faces +Z</option>
          </select>
        </label>
      </fieldset>
      <label className="field">
        <span className="field-label">File name</span>
        <input value={name} placeholder={defaultName} onChange={(e) => setName(e.target.value)} data-testid="export-name" />
      </label>
      <div className="small" role="status" data-testid="export-summary">
        {typeof frame === "string" ? (
          <span className="bridge-status bad">{frame}</span>
        ) : (
          <>
            {chosen.length} bod{chosen.length === 1 ? "y" : "ies"}
            {changed ? (
              <>
                , re-placed: origin at model {origin.map(fmt).join(", ")}, model {formatDirection(up)} becomes {convention === "zUp" ? "+Z" : "+Y"}
              </>
            ) : (
              ", as modelled"
            )}
            {fileBox && (
              <div className="muted">
                In the file: X {fmt(fileBox[0][0])} to {fmt(fileBox[0][1])}, Y {fmt(fileBox[1][0])} to {fmt(fileBox[1][1])}, Z {fmt(fileBox[2][0])} to {fmt(fileBox[2][1])}
              </div>
            )}
          </>
        )}
        {problem && <div className="bridge-status bad">{problem}</div>}
      </div>
      <div className="modal-buttons">
        <span className="sep" />
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={!chosen.length || typeof frame === "string"}
          onClick={() => onExport({ bodies: chosen, ...(changed && typeof frame !== "string" ? { frame } : {}), fileName: (name.trim() || defaultName).replace(/\.ste?p$/i, "") })}
          data-testid="export-go"
        >
          Export STEP
        </button>
      </div>
    </div>
  );
}

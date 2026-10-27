// The Hole Wizard: a hole's properties. Its type (simple, counterbore,
// countersink, tapped: a picture each), the screw size and fit that pick its
// numbers from the ISO table (each number can be given instead), how deep it
// goes, and where: centres on its face (typed, or added where the face is
// clicked) or the points of a sketch. Under it, the callout a drawing will
// give it. The rules are pure, in wizard.ts.

import { Icon, type IconName } from "../../ui/icons";
import { Field, NumberInput, Select, type NumberValue } from "../../ui/fields";
import { FeatureForm, PickWrap } from "../../ui/props/FeatureForm";
import type { PickField } from "../../ui/props/picking";
import { usePickHost } from "../../ui/props/pickHost";
import type { FieldProps, FieldSpec } from "../../ui/props/spec";
import type { FaceSelector } from "../../doc/types";
import { selectFaces } from "../../kernel/selectors";
import { faceSelectorFor } from "../../kernel/synthesize";
import type { RebuildView } from "../../worker/protocol";
import type { UiOp } from "../uiDefs";
import { HOLE_KINDS, holeKind, screwSize, type HoleFit, type HoleKind, type HoleSpec } from "./standards";
import {
  addCentrePatch,
  blindDepth,
  calloutPreview,
  centresOf,
  centresPatch,
  clickedCentre,
  END_LABEL,
  endPatch,
  FIT_LABEL,
  fitPatch,
  holeAsk,
  holeCount,
  holeEnd,
  holeSummary,
  KIND_LABEL,
  kindPatch,
  placement,
  pointSketches,
  pointsPatch,
  removeCentrePatch,
  setCentrePatch,
  SIZE_OPTIONS,
  sizePatch,
  wizardSpec,
  type HoleEnd,
} from "./wizard";

type Raw = Record<string, unknown>;

const KIND_ICON: Record<HoleKind, IconName> = { simple: "holeSimple", counterbore: "holeCounterbore", countersink: "holeCountersink", tapped: "holeTapped" };
const KIND_HINT: Record<HoleKind, string> = {
  simple: "A plain drilled hole: the clearance for the screw",
  counterbore: "A clearance hole with a counterbore for a socket head cap screw",
  countersink: "A clearance hole with a 90° countersink for a countersunk screw",
  tapped: "A tap drill hole with a thread for the screw",
};

/** The four hole types, as pictures. */
function KindPicker({ p, kind }: { p: FieldProps; kind: HoleKind }) {
  return (
    <Field label="Type" block>
      <span className="hole-kinds" role="group" aria-label="Hole type" data-testid="prop-hole-kind">
        {HOLE_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className="hole-kind"
            aria-pressed={k === kind}
            title={KIND_HINT[k]}
            onClick={() => k !== kind && p.update(kindPatch(p.f, k, p.resolved))}
            data-testid={`prop-hole-kind-${k}`}
          >
            <Icon name={KIND_ICON[k]} size={22} />
            <span>{KIND_LABEL[k]}</span>
          </button>
        ))}
      </span>
    </Field>
  );
}

/**
 * A number the table gives unless the hole gives its own: shown either way;
 * typing one makes it the hole's own, and "Use the table" drops it again.
 */
function TableNumber({ label, unit, own, table, min, testId, onCommit, onReset }: { label: string; unit?: string; own: unknown; table: number | undefined; min?: number; testId: string; onCommit(v: NumberValue): void; onReset?(): void }) {
  const mine = own !== undefined && own !== null;
  const hint = mine ? (table !== undefined ? `your own: the table says ${table}` : undefined) : table !== undefined ? "from the table" : undefined;
  return (
    <>
      <Field label={label} unit={unit} hint={hint}>
        <NumberInput value={(mine ? own : (table ?? "")) as NumberValue} min={min} onCommit={onCommit} testId={testId} />
      </Field>
      {mine && table !== undefined && onReset && (
        <button type="button" className="link-button" onClick={onReset} data-testid={`${testId}-table`}>
          Use the table ({table})
        </button>
      )}
    </>
  );
}

/** The table's numbers for this hole with nothing of its own: what "from the table" shows. */
function tableSpec(f: Raw): HoleSpec | null {
  const ask = holeAsk(f);
  if (!ask.size) return null;
  const spec = wizardSpec({ size: ask.size, kind: holeKind(ask), ...(ask.fit ? { fit: ask.fit } : {}), depth: f.depth });
  return typeof spec === "string" ? null : spec;
}

/** Size, fit and the numbers: the bore, the counterbore or countersink, the thread. */
function Numbers({ p, kind, spec }: { p: FieldProps; kind: HoleKind; spec: HoleSpec | null }) {
  const { f, resolved } = p;
  const table = tableSpec(resolved);
  const sized = typeof resolved.size === "string";
  const part = (key: string) => (typeof f[key] === "object" && f[key] !== null ? (f[key] as Raw) : undefined);
  /** Sets one number of a counterbore, countersink or thread, keeping the others it gives itself. */
  const setPart = (key: "counterbore" | "countersink" | "thread", field: string, v: NumberValue | null) => {
    const next: Raw = { ...(part(key) ?? {}) };
    if (v === null) delete next[field];
    else next[field] = v;
    p.update({ [key]: Object.keys(next).length ? next : null });
  };
  const std = sized ? screwSize(String(resolved.size)) : undefined;
  return (
    <>
      <Field label="Size" hint={sized ? undefined : "Custom: give the numbers yourself"}>
        <Select value={sized ? String(resolved.size) : ""} options={SIZE_OPTIONS} onChange={(v) => p.update(sizePatch(f, v, resolved))} testId="prop-hole-size" />
      </Field>
      {sized && kind !== "tapped" && (
        <Field label="Fit" hint="ISO 273 clearance for the screw">
          <Select
            value={(resolved.fit as HoleFit | undefined) ?? "normal"}
            options={(Object.keys(FIT_LABEL) as HoleFit[]).map((k): [string, string] => [k, `${FIT_LABEL[k]} (Ø${std?.clearance[k]})`])}
            onChange={(v) => p.update(fitPatch(v as HoleFit))}
            testId="prop-hole-fit"
          />
        </Field>
      )}
      <TableNumber
        label={kind === "tapped" ? "Tap drill Ø" : "Diameter"}
        unit="mm"
        own={f.diameter}
        table={table?.diameter}
        min={0}
        testId="prop-diameter"
        onCommit={(v) => p.update({ diameter: v })}
        onReset={() => p.update({ diameter: null })}
      />
      {kind === "counterbore" && (
        <>
          <TableNumber label="C'bore Ø" unit="mm" own={part("counterbore")?.diameter} table={table?.counterbore?.diameter} min={0} testId="prop-counterbore-diameter" onCommit={(v) => setPart("counterbore", "diameter", v)} onReset={() => setPart("counterbore", "diameter", null)} />
          <TableNumber label="C'bore depth" unit="mm" own={part("counterbore")?.depth} table={table?.counterbore?.depth} min={0} testId="prop-counterbore-depth" onCommit={(v) => setPart("counterbore", "depth", v)} onReset={() => setPart("counterbore", "depth", null)} />
        </>
      )}
      {kind === "countersink" && (
        <>
          <TableNumber label="C'sink Ø" unit="mm" own={part("countersink")?.diameter} table={table?.countersink?.diameter} min={0} testId="prop-countersink-diameter" onCommit={(v) => setPart("countersink", "diameter", v)} onReset={() => setPart("countersink", "diameter", null)} />
          <TableNumber label="Angle" unit="°" own={part("countersink")?.angle} table={table?.countersink?.angle} min={0} testId="prop-countersink-angle" onCommit={(v) => setPart("countersink", "angle", v)} onReset={() => setPart("countersink", "angle", null)} />
        </>
      )}
      {kind === "tapped" && spec?.thread && (
        <>
          <Field label="Thread">
            <span className="readout" data-testid="prop-thread">
              {spec.thread.designation} - {spec.thread.class} (major Ø{spec.thread.major})
            </span>
          </Field>
          <TableNumber label="Pitch" unit="mm" own={part("thread")?.pitch} table={std?.pitch} min={0} testId="prop-thread-pitch" onCommit={(v) => setPart("thread", "pitch", v)} onReset={() => setPart("thread", "pitch", null)} />
          {typeof resolved.depth === "number" && (
            <TableNumber
              label="Thread depth"
              unit="mm"
              own={part("thread")?.depth}
              table={typeof table?.thread?.depth === "number" ? table.thread.depth : undefined}
              min={0}
              testId="prop-thread-depth"
              onCommit={(v) => setPart("thread", "depth", v)}
              onReset={() => setPart("thread", "depth", null)}
            />
          )}
        </>
      )}
    </>
  );
}

/** How deep: blind (a depth), through all, up to next. */
function End({ p }: { p: FieldProps }) {
  const end = holeEnd(p.f);
  return (
    <>
      <Field label="End" hint={end === "upToNext" ? "Through the first wall it meets, stopping in the gap behind it" : undefined}>
        <Select value={end} options={(Object.keys(END_LABEL) as HoleEnd[]).map((k): [string, string] => [k, END_LABEL[k]])} onChange={(v) => p.update(endPatch(p.f, v as HoleEnd, p.resolved))} testId="prop-hole-end" />
      </Field>
      {end === "blind" && (
        <Field label="Depth" unit="mm">
          <NumberInput value={(p.f.depth ?? blindDepth(p.resolved)) as NumberValue} min={0} onCommit={(v) => p.update({ depth: v })} testId="prop-depth" />
        </Field>
      )}
    </>
  );
}

// The face is picked with the position in a session (a click on a flat face places the hole there), so it is not a pick field of its own.
const FACE: FieldSpec[] = [{ kind: "face", key: "face", label: "Face", testId: "prop-hole-face", hint: "The flat face it is drilled into, against its outward normal", pickable: false }];

/** How near a click must be to a centre (mm) to take that hole out again. */
const NEAR_CENTRE = 2;

/**
 * The hole's position as a live selection field in a session: a click on a
 * flat face drills it there (on a new face: the hole moves there; on its own
 * face: another centre, or that centre out again when the click is on it).
 */
function positionField(p: FieldProps, view: RebuildView | null): PickField | null {
  const { f, resolved } = p;
  if (placement(f) === "points") return null;
  const face = resolved.face as FaceSelector | undefined;
  const own = face && view ? selectFaces(view.faces, face).matches.map((m) => m.index) : [];
  const centres = centresOf(resolved) as number[][];
  return {
    key: "position",
    label: "Position",
    order: 50,
    kind: "point",
    takes: ["faces"],
    count: face ? centres.length : 0,
    required: true,
    // Its centres show as points to drag (handles); its whole face is not lit up.
    items: [],
    prompt: "Click a flat face where the hole goes",
    toggle(t) {
      if (t.kind !== "face" || !view) return "Click a flat face where the hole goes";
      const clicked = view.faces[t.index];
      if (clicked?.type !== "plane") return "That face is not flat: click a flat face for the hole";
      if (!own.includes(t.index)) {
        const s = faceSelectorFor(view.faces, t.index);
        if (!s.ok) return s.error;
        const at = clickedCentre(clicked, t.point, undefined);
        if (typeof at === "string") return at;
        // In a part of several bodies, the hole drills the body clicked (as Hole on a face picked first does).
        const r = p.update({ face: s.selector, ...centresPatch([at]), ...(view.bodies.length > 1 && clicked.body ? { bodies: [clicked.body] } : {}) });
        return typeof r === "string" ? r : null;
      }
      const at = clickedCentre(clicked, t.point, face?.type === "planar" ? face.normal : undefined);
      if (typeof at === "string") return at;
      const near = centres.findIndex((c) => Math.hypot(Number(c[0]) - at[0], Number(c[1]) - at[1]) < NEAR_CENTRE);
      const patch = near >= 0 ? removeCentrePatch(f, near) : addCentrePatch(f, at, resolved);
      if (!patch) return near >= 0 ? "That is the hole's only centre: click elsewhere on the face to move it, or drag its handle" : null;
      const r = p.update(patch);
      return typeof r === "string" ? r : null;
    },
  };
}

/** Where: centres on the face (typed or clicked), or a sketch's points. */
function Position({ p }: { p: FieldProps }) {
  const { f, resolved, before, selection, view } = p;
  const mode = placement(f);
  const sketches = pointSketches(before);
  const centres = centresOf(f) as NumberValue[][];
  const add = (patch: Raw | null | string) => {
    if (typeof patch === "string") return p.setError(patch);
    if (!patch) return p.setError("There is a hole there already.");
    p.setError(null);
    p.update(patch);
  };
  // In a session, the position is a live selection field: a click on a flat face drills the hole there.
  const host = usePickHost();
  const field = host ? positionField(p, host.view ?? view) : null;
  return (
    <PickWrap field={field} tid="prop-hole-position">
      <Field label="Position" hint={mode === "points" ? "A hole at each point of the sketch: move the points and the holes follow" : "Centres in the face's plane, from the origin projected onto it"}>
        <Select
          value={mode}
          options={[
            ["centers", "Centres on the face"],
            ["points", sketches.length ? "A sketch's points" : "A sketch's points (none yet)"],
          ]}
          onChange={(v) => {
            if (v === "centers") return add(centresPatch([[0, 0]]));
            if (!sketches.length) return p.setError("No sketch before this hole has points: sketch on the face, put a point where each hole goes (Point tool), then choose it here.");
            add(pointsPatch(sketches[0][0]));
          }}
          testId="prop-hole-position"
        />
      </Field>
      {mode === "points" ? (
        <Field label="Sketch" hint={`${holeCount(resolved, before)} hole${holeCount(resolved, before) === 1 ? "" : "s"}`}>
          <Select value={String(f.points)} options={sketches.some(([id]) => id === f.points) ? sketches : [[String(f.points), `${String(f.points)} (no points)`], ...sketches]} onChange={(v) => p.update({ points: v })} testId="prop-hole-points" />
        </Field>
      ) : (
        <>
          {centres.length === 1 ? (
            <>
              <Field label="Centre X" unit="mm">
                <NumberInput value={centres[0][0]} onCommit={(v) => p.update(setCentrePatch(f, 0, 0, v))} testId="prop-center-x" />
              </Field>
              <Field label="Centre Y" unit="mm">
                <NumberInput value={centres[0][1]} onCommit={(v) => p.update(setCentrePatch(f, 0, 1, v))} testId="prop-center-y" />
              </Field>
            </>
          ) : (
            <Field label={`Centres (${centres.length})`} block hint="x, y in mm">
              <span className="readout hole-centres" data-testid="prop-hole-centres">
                {centres.map((c, i) => (
                  <span key={i} className="selector-line">
                    <span className="set-text">{i + 1}.</span>
                    <NumberInput value={c[0]} onCommit={(v) => p.update(setCentrePatch(f, i, 0, v))} testId={i === 0 ? "prop-center-x" : `prop-center-x-${i}`} ariaLabel={`Centre ${i + 1} x`} />
                    <NumberInput value={c[1]} onCommit={(v) => p.update(setCentrePatch(f, i, 1, v))} testId={i === 0 ? "prop-center-y" : `prop-center-y-${i}`} ariaLabel={`Centre ${i + 1} y`} />
                    <button type="button" className="selector-remove" aria-label={`Remove centre ${i + 1}`} title="Remove this hole" onClick={() => add(removeCentrePatch(f, i))} data-testid={`prop-center-remove-${i}`}>
                      ×
                    </button>
                  </span>
                ))}
              </span>
            </Field>
          )}
          <span className="inline-buttons">
            <button
              type="button"
              title="Click the face in the view where another hole goes, then this"
              disabled={!selection.point || selection.faces.length !== 1}
              onClick={() => {
                const at = clickedCentre(view?.faces[selection.faces[0]], selection.point, (resolved.face as { normal?: [number, number, number] } | undefined)?.normal);
                add(typeof at === "string" ? at : addCentrePatch(f, at, resolved));
              }}
              data-testid="prop-hole-add-clicked"
            >
              Add the clicked point
            </button>
            <button
              type="button"
              title="Another hole, 10 mm on from the last; type its centre"
              onClick={() => {
                const last = (centresOf(resolved).at(-1) as number[] | undefined) ?? [0, 0];
                add(addCentrePatch(f, [Number(last[0]) + 10, Number(last[1])], resolved));
              }}
              data-testid="prop-hole-add"
            >
              Add a centre
            </button>
          </span>
        </>
      )}
    </PickWrap>
  );
}

/** The callout a drawing will give it: "3× Ø6.6 THRU" and "CBORE Ø11 × 6.5 DEEP", "M8×1.25 - 6H ⌴11.25". */
function Callout({ p, spec }: { p: FieldProps; spec: HoleSpec | null }) {
  if (!spec) return null;
  const n = holeCount(p.resolved, p.before);
  const lines = calloutPreview(spec, p.resolved.depth);
  if (n > 1) lines[0] = `${n}× ${lines[0]}`;
  return (
    <Field label="Callout" hint="What a drawing calls it out">
      <span className="readout" data-testid="prop-hole-callout">
        {lines.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </span>
    </Field>
  );
}

function HoleWizard(p: FieldProps) {
  const ask = holeAsk(p.resolved);
  const kind = holeKind(ask);
  const spec = wizardSpec(p.resolved);
  const bodies: FieldSpec[] = p.bodies.length > 1 ? [{ kind: "bodies", key: "bodies", label: "Bodies", testId: "prop-bodies", allowEmpty: true, emptyHint: "none ticked: every body it reaches" }] : [];
  return (
    <>
      <KindPicker p={p} kind={kind} />
      <Numbers p={p} kind={kind} spec={typeof spec === "string" ? null : spec} />
      {typeof spec === "string" && (
        <p className="muted small" data-testid="prop-hole-problem">
          {spec}
        </p>
      )}
      <End p={p} />
      <FeatureForm fields={FACE} {...p} />
      <Position p={p} />
      <Callout p={p} spec={typeof spec === "string" ? null : spec} />
      {bodies.length > 0 && <FeatureForm fields={bodies} {...p} />}
    </>
  );
}

export const ui: UiOp = {
  op: "hole",
  label: "Hole",
  icon: "hole",
  Editor: HoleWizard,
  summary: (f) => holeSummary(f),
};

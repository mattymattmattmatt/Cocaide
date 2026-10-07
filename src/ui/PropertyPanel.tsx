// Edits one feature through document commands. Every field commits as one
// updateFeature; a rejected command shows why and leaves the document alone.

import { useEffect, useState } from "react";
import type { Command, RawDocument } from "../doc/commands";
import { documentParameters, resolveExpressions } from "../doc/parameters";
import { DEFAULT_BODY, type EdgeSelector, type FaceSelector, type Vec3 } from "../doc/types";
import { validateDocument } from "../doc/validate";
import { sketchDof } from "../geom/solver";
import { describeEdgeSelector, describeWanted } from "../kernel/selectors";
import { edgesSelectorFor, faceSelectorFor } from "../kernel/synthesize";
import type { RebuildView } from "../worker/protocol";
import { DirectionInput, Field, NumberInput, Select, TextInput, Vec3Input, type NumberValue } from "./fields";
import { EndCapProps, GussetProps, JointProps, MemberProps, type FrameActions } from "./FrameProps";
import type { Selection } from "./Viewport";

export const OP_LABEL: Record<string, string> = {
  sketch: "Sketch",
  extrude: "Extrude",
  cut: "Cut",
  hole: "Hole",
  fillet: "Fillet",
  chamfer: "Chamfer",
  linearPattern: "Linear pattern",
  circularPattern: "Circular pattern",
  combine: "Combine",
  member: "Member",
  joint: "Joint",
  endCap: "End cap",
  gusset: "Gusset",
};

/** The first free body name of the form body_1, body_2, ... */
export function nextBodyName(taken: string[]): string {
  for (let n = 1; ; n++) if (!taken.includes(`body_${n}`)) return `body_${n}`;
}

type Raw = Record<string, unknown>;

interface Props {
  doc: RawDocument;
  featureId: string;
  view: RebuildView | null;
  selection: Selection;
  dispatch(cmd: Command): string | null;
  onEditSketch(id: string): void;
  onSelectFeature(id: string | null): void;
  onAsk?(target: { kind: "failed"; id: string }, x: number, y: number): void;
  /** Opens the weldment profile card for a sketch. */
  onProfileCard?(sketchId: string): void;
  /** Adding features and multi-feature changes, for a frame's features. */
  frame?: FrameActions;
}

export function PropertyPanel({ doc, featureId, view, selection, dispatch, onEditSketch, onSelectFeature, onAsk, onProfileCard, frame }: Props) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [featureId]);
  const index = doc.features.findIndex((f) => f.id === featureId);
  const f = doc.features[index] as Raw | undefined;
  if (!f) return <p className="muted">Select a feature in the tree.</p>;

  const run = (cmd: Command) => {
    const problem = dispatch(cmd);
    setError(problem);
    return problem;
  };
  const update = (patch: Raw) => run({ type: "updateFeature", id: featureId, patch });
  const status = view?.features.find((s) => s.id === featureId);
  // Fields show what the document holds ("=plate_t"); anything computed uses the numbers.
  const params = documentParameters(doc);
  const resolved = resolveExpressions(f, params, []) as Raw;
  const before = resolveExpressions(doc.features.slice(0, index), params, []) as Raw[];
  const op = String(f.op);
  /** The bodies made before this feature: what it can add to, cut or combine. */
  const bodiesBefore = validateDocument({ ...doc, features: doc.features.slice(0, index) }).bodies;
  const rename = (from: string, to: string) => run({ type: "renameBody", from, to });
  /** Frame actions whose rejection shows here, like any other edit's. */
  const batched = (a: FrameActions): FrameActions => ({ onCreate: a.onCreate, onBatch: (cmds) => {
    const problem = a.onBatch(cmds);
    setError(problem);
    return problem;
  } });

  return (
    <div className="properties" data-testid="properties">
      <div className="prop-header">
        <h3>{OP_LABEL[op] ?? op}</h3>
        <TextInput
          value={featureId}
          testId="prop-id"
          onCommit={(id) => {
            if (!run({ type: "updateFeature", id: featureId, patch: { id } })) onSelectFeature(id);
          }}
        />
      </div>
      {status?.error && (
        <div
          className="feature-error standalone"
          data-testid="prop-feature-error"
          title="Right-click to ask about this error"
          onContextMenu={(e) => {
            if (!onAsk) return;
            e.preventDefault();
            onAsk({ kind: "failed", id: featureId }, e.clientX, e.clientY);
          }}
        >
          {status.error.replaceAll(`${featureId}: `, "")}
        </div>
      )}
      <div className="prop-body">
        {op === "sketch" && <SketchProps f={resolved} onEdit={() => onEditSketch(featureId)} onProfileCard={onProfileCard && (() => onProfileCard(featureId))} />}
        {op === "member" && <MemberProps f={f} resolved={resolved} doc={doc} view={view} update={update} rename={rename} actions={frame && batched(frame)} />}
        {op === "joint" && <JointProps f={f} doc={doc} view={view} update={update} actions={frame && batched(frame)} />}
        {op === "endCap" && <EndCapProps f={f} doc={doc} update={update} />}
        {op === "gusset" && <GussetProps f={f} doc={doc} update={update} />}
        {(op === "endCap" || op === "gusset") && <BodyNameField f={f} rename={rename} />}
        {(op === "extrude" || op === "cut") && <ExtrudeProps f={f} before={before} update={update} />}
        {op === "extrude" && <BodyProps f={f} bodies={bodiesBefore} update={update} rename={rename} />}
        {op === "hole" && <HoleProps f={f} resolved={resolved} update={update} selection={selection} view={view} setError={setError} />}
        {(op === "cut" || op === "hole") && bodiesBefore.length > 1 && <BodiesScope f={f} bodies={bodiesBefore} update={update} />}
        {op === "combine" && <CombineProps f={f} bodies={bodiesBefore} update={update} />}
        {(op === "fillet" || op === "chamfer") && (
          <EdgeTreatmentProps f={f} update={update} selection={selection} view={view} setError={setError} />
        )}
        {(op === "linearPattern" || op === "circularPattern") && <PatternProps f={f} before={before} update={update} />}
      </div>
      <div className="prop-actions">
        <label className="check">
          <input
            type="checkbox"
            checked={f.suppressed === true}
            data-testid="prop-suppressed"
            onChange={(e) => run({ type: "suppressFeature", id: featureId, suppressed: e.target.checked })}
          />
          Suppressed
        </label>
        <button
          className="danger"
          onClick={() => {
            if (!run({ type: "deleteFeature", id: featureId })) onSelectFeature(null);
          }}
        >
          Delete
        </button>
      </div>
      {error && (
        <div className="command-error" role="alert" data-testid="command-error">
          {error}
        </div>
      )}
    </div>
  );
}

/** The body a plate (end cap, gusset) makes: named by its id, or renamed. */
function BodyNameField({ f, rename }: { f: Raw; rename(from: string, to: string): unknown }) {
  const body = typeof f.newBody === "string" ? f.newBody : String(f.id);
  return (
    <Field label="Body">
      <TextInput value={body} onCommit={(name) => name !== body && rename(body, name)} testId="prop-body-name" />
    </Field>
  );
}

/** Where an extrude's material goes: an existing body, or a new one with a name. */
function BodyProps({ f, bodies, update, rename }: { f: Raw; bodies: string[]; update(p: Raw): unknown; rename(from: string, to: string): unknown }) {
  const newBody = typeof f.newBody === "string" ? f.newBody : null;
  const value = newBody ? "__new" : typeof f.body === "string" ? f.body : DEFAULT_BODY;
  const names = bodies.includes(DEFAULT_BODY) ? bodies : [DEFAULT_BODY, ...bodies];
  const options: [string, string][] = [...names.map((n): [string, string] => [n, n === DEFAULT_BODY && !bodies.includes(n) ? `${n} (new)` : `add to ${n}`]), ["__new", "New body"]];
  return (
    <>
      <Field label="Body">
        <Select
          value={value}
          options={options}
          testId="prop-body"
          onChange={(v) => update(v === "__new" ? { body: null, newBody: nextBodyName(bodies) } : { newBody: null, body: v === DEFAULT_BODY ? null : v })}
        />
      </Field>
      {newBody && (
        <Field label="Name">
          <TextInput value={newBody} onCommit={(to) => to !== newBody && rename(newBody, to)} testId="prop-body-name" />
        </Field>
      )}
    </>
  );
}

/** Which bodies a cut or hole removes material from. None ticked: every body it reaches. */
function BodiesScope({ f, bodies, update }: { f: Raw; bodies: string[]; update(p: Raw): unknown }) {
  const listed = Array.isArray(f.bodies) ? (f.bodies as string[]) : [];
  const toggle = (name: string, on: boolean) => {
    const next = on ? [...listed, name] : listed.filter((n) => n !== name);
    update({ bodies: next.length ? bodies.filter((b) => next.includes(b)) : null });
  };
  return (
    <Field label="Bodies">
      <span className="body-checks" data-testid="prop-bodies">
        {bodies.map((b) => (
          <label key={b} className="check">
            <input type="checkbox" checked={listed.includes(b)} onChange={(e) => toggle(b, e.target.checked)} data-testid={`prop-bodies-${b}`} />
            {b}
          </label>
        ))}
        <span className="muted small">{listed.length ? "only these, and each must lose material" : "none ticked: every body it reaches"}</span>
      </span>
    </Field>
  );
}

function CombineProps({ f, bodies, update }: { f: Raw; bodies: string[]; update(p: Raw): unknown }) {
  const target = String(f.target);
  const tools = Array.isArray(f.tools) ? (f.tools as string[]) : [];
  return (
    <>
      <Field label="Operation">
        <Select
          value={f.operation as "add" | "subtract" | "common"}
          testId="prop-operation"
          options={[
            ["add", "Add (join)"],
            ["subtract", "Subtract"],
            ["common", "Common (intersect)"],
          ]}
          onChange={(v) => update({ operation: v })}
        />
      </Field>
      <Field label="Into">
        <Select value={target} options={bodies.map((b): [string, string] => [b, b])} testId="prop-target" onChange={(v) => update({ target: v, tools: tools.filter((t) => t !== v).length ? tools.filter((t) => t !== v) : bodies.filter((b) => b !== v).slice(0, 1) })} />
      </Field>
      <Field label="Bodies">
        <span className="body-checks">
          {bodies
            .filter((b) => b !== target)
            .map((b) => (
              <label key={b} className="check">
                <input
                  type="checkbox"
                  checked={tools.includes(b)}
                  data-testid={`prop-tools-${b}`}
                  onChange={(e) => {
                    const next = e.target.checked ? [...tools, b] : tools.filter((t) => t !== b);
                    if (next.length) update({ tools: bodies.filter((x) => next.includes(x)) });
                  }}
                />
                {b}
              </label>
            ))}
          <span className="muted small">used up: they become part of {target}</span>
        </span>
      </Field>
    </>
  );
}

function SketchProps({ f, onEdit, onProfileCard }: { f: Raw; onEdit(): void; onProfileCard?(): void }) {
  const plane = f.plane as { normal: Vec3; origin: Vec3 };
  const entities = (f.entities as unknown[]) ?? [];
  const constraints = (f.constraints as unknown[]) ?? [];
  let dof: number | null = null;
  try {
    dof = sketchDof(entities as never, constraints as never);
  } catch {
    dof = null;
  }
  return (
    <>
      <Field label="Plane">
        <span className="readout">{planeName(plane.normal, plane.origin)}</span>
      </Field>
      <Field label="Geometry">
        <span className="readout">
          {entities.length} entities · {constraints.length} constraints
          {dof !== null && ` · ${dof === 0 ? "fully defined" : `${dof} DOF free`}`}
        </span>
      </Field>
      {isProfile(f.profile) && (
        <Field label="Weldment">
          <span className="readout" data-testid="prop-profile">
            {f.profile.name}
            {f.profile.library ? ` · library v${f.profile.library.version}` : " · not in the library"}
          </span>
        </Field>
      )}
      <button className="primary wide" onClick={onEdit} data-testid="edit-sketch">
        Edit sketch
      </button>
      {onProfileCard && (
        <button className="wide" onClick={onProfileCard} data-testid="prop-profile-card" title="Name it, give it sizes and tags, and keep it in the section library">
          {isProfile(f.profile) ? "Profile card…" : "Save as a weldment profile…"}
        </button>
      )}
    </>
  );
}

function isProfile(p: unknown): p is { name: string; library?: { id: string; version: number } } {
  return typeof p === "object" && p !== null && typeof (p as { name?: unknown }).name === "string";
}


export function planeName(normal: Vec3, origin: Vec3): string {
  const n = normal.map((v) => Math.round(v * 1e6) / 1e6);
  const at = (k: number) => (origin[k] ? ` at ${"XYZ"[k]} = ${Math.round(origin[k] * 1e4) / 1e4}` : "");
  if (n[0] === 0 && n[1] === 0) return `Top (XY${n[2] < 0 ? ", flipped" : ""})${at(2)}`;
  if (n[0] === 0 && n[2] === 0) return `Front (XZ${n[1] > 0 ? ", flipped" : ""})${at(1)}`;
  if (n[1] === 0 && n[2] === 0) return `Right (YZ${n[0] < 0 ? ", flipped" : ""})${at(0)}`;
  return `normal [${n.join(", ")}] through [${origin.map((v) => Math.round(v * 1e4) / 1e4).join(", ")}]`;
}

function ExtrudeProps({ f, before, update }: { f: Raw; before: Raw[]; update(p: Raw): void }) {
  const sketches = before.filter((g) => g.op === "sketch").map((g) => String(g.id));
  const sketch = before.find((g) => g.id === f.sketch);
  const normal = ((sketch?.plane as { normal?: Vec3 })?.normal ?? [0, 0, 1]) as Vec3;
  const extent = (f.extent as string) ?? "blind";
  const dir = f.direction as Vec3 | undefined;
  const reversed = dir && dir.every((c, i) => Math.abs(c + normal[i]) < 1e-9);
  const mode = !dir ? "normal" : reversed ? "reversed" : "custom";
  return (
    <>
      <Field label="Sketch">
        <Select value={String(f.sketch)} options={sketches.map((s) => [s, s])} onChange={(v) => update({ sketch: v })} testId="prop-sketch" />
      </Field>
      <Field label="End">
        <Select
          value={extent as "blind" | "midplane" | "throughAll"}
          testId="prop-extent"
          options={[
            ["blind", "Blind"],
            ["midplane", "Mid-plane"],
            ["throughAll", "Through all"],
          ]}
          onChange={(v) =>
            update(v === "throughAll" ? { extent: v, distance: null } : { extent: v === "blind" ? null : v, distance: (f.distance as number) ?? 10 })
          }
        />
      </Field>
      {extent !== "throughAll" && (
        <Field label={extent === "midplane" ? "Total depth" : "Depth"}>
          <NumberInput value={(f.distance as number) ?? 10} min={0} onCommit={(v) => update({ distance: v })} testId="prop-distance" />
        </Field>
      )}
      <Field label="Direction">
        <Select
          value={mode}
          testId="prop-direction-mode"
          options={[
            ["normal", "Sketch normal"],
            ["reversed", "Reversed"],
            ["custom", "Custom"],
          ]}
          onChange={(v) => update({ direction: v === "normal" ? null : v === "reversed" ? normal.map((c) => -c) : normal })}
        />
      </Field>
      {mode === "custom" && dir && (
        <Field label="Vector">
          <Vec3Input value={dir} onCommit={(v) => update({ direction: v })} />
        </Field>
      )}
    </>
  );
}

function HoleProps({
  f,
  resolved,
  update,
  selection,
  view,
  setError,
}: {
  f: Raw;
  resolved: Raw;
  update(p: Raw): string | null | void;
  selection: Selection;
  view: RebuildView | null;
  setError(e: string | null): void;
}) {
  const center = f.center as [NumberValue, NumberValue];
  const through = f.depth === "through";
  const type = f.counterbore ? "counterbore" : f.countersink ? "countersink" : "simple";
  const d = resolved.diameter as number;
  return (
    <>
      <Field label="Face">
        <span className="readout">{describeWanted(f.face as FaceSelector, 1).replace(/^1 /, "")}</span>
      </Field>
      <button
        disabled={selection.faces.length !== 1 || !view}
        onClick={() => {
          const s = faceSelectorFor(view!.faces, selection.faces[0]);
          if (!s.ok) setError(s.error);
          else update({ face: s.selector });
        }}
      >
        Use selected face
      </button>
      <Field label="Centre X">
        <NumberInput value={center[0]} onCommit={(v) => update({ center: [v, center[1]] })} testId="prop-center-x" />
      </Field>
      <Field label="Centre Y">
        <NumberInput value={center[1]} onCommit={(v) => update({ center: [center[0], v] })} testId="prop-center-y" />
      </Field>
      <Field label="Diameter">
        <NumberInput value={f.diameter as NumberValue} min={0} onCommit={(v) => update({ diameter: v })} testId="prop-diameter" />
      </Field>
      <Field label="Depth">
        <span className="inline">
          <label className="check">
            <input
              type="checkbox"
              checked={through}
              data-testid="prop-through"
              onChange={(e) => update({ depth: e.target.checked ? "through" : 10 })}
            />
            Through
          </label>
          {!through && <NumberInput value={f.depth as number} min={0} onCommit={(v) => update({ depth: v })} testId="prop-depth" />}
        </span>
      </Field>
      <Field label="Type">
        <Select
          value={type}
          testId="prop-hole-type"
          options={[
            ["simple", "Simple"],
            ["counterbore", "Counterbore"],
            ["countersink", "Countersink"],
          ]}
          onChange={(v) =>
            update({
              counterbore: v === "counterbore" ? { diameter: round(d * 1.8), depth: through ? 2 : Math.min(2, (resolved.depth as number) / 2) } : null,
              countersink: v === "countersink" ? { diameter: round(d * 2), angle: 90 } : null,
            })
          }
        />
      </Field>
      {type === "counterbore" && (
        <>
          <Field label="C'bore Ø">
            <NumberInput
              value={(f.counterbore as { diameter: number }).diameter}
              onCommit={(v) => update({ counterbore: { ...(f.counterbore as object), diameter: v } })}
            />
          </Field>
          <Field label="C'bore depth">
            <NumberInput
              value={(f.counterbore as { depth: number }).depth}
              onCommit={(v) => update({ counterbore: { ...(f.counterbore as object), depth: v } })}
            />
          </Field>
        </>
      )}
      {type === "countersink" && (
        <>
          <Field label="C'sink Ø">
            <NumberInput
              value={(f.countersink as { diameter: number }).diameter}
              onCommit={(v) => update({ countersink: { ...(f.countersink as object), diameter: v } })}
            />
          </Field>
          <Field label="Angle">
            <NumberInput
              value={(f.countersink as { angle: number }).angle}
              onCommit={(v) => update({ countersink: { ...(f.countersink as object), angle: v } })}
            />
          </Field>
        </>
      )}
    </>
  );
}

function EdgeTreatmentProps({
  f,
  update,
  selection,
  view,
  setError,
}: {
  f: Raw;
  update(p: Raw): string | null | void;
  selection: Selection;
  view: RebuildView | null;
  setError(e: string | null): void;
}) {
  const fillet = f.op === "fillet";
  const edges = f.edges as EdgeSelector | EdgeSelector[];
  const list = Array.isArray(edges) ? edges : [edges];
  return (
    <>
      <Field label="Edges">
        <span className="readout">
          {list.map((e, i) => (
            <span key={i} className="selector-line">
              {describeEdgeSelector(e)}
            </span>
          ))}
        </span>
      </Field>
      <button
        disabled={selection.edges.length === 0 || !view}
        onClick={() => {
          const s = edgesSelectorFor(view!.edges, view!.faces, selection.edges);
          if (!s.ok) setError(s.error);
          else update({ edges: s.selector });
        }}
      >
        Use selected edges
      </button>
      <Field label={fillet ? "Radius" : "Distance"}>
        <NumberInput
          value={(fillet ? f.radius : f.distance) as number}
          min={0}
          testId={fillet ? "prop-radius" : "prop-chamfer-distance"}
          onCommit={(v) => update(fillet ? { radius: v } : { distance: v })}
        />
      </Field>
    </>
  );
}

function PatternProps({ f, before, update }: { f: Raw; before: Raw[]; update(p: Raw): void }) {
  const seeds = before.filter((g) => ["extrude", "cut", "hole", "member"].includes(String(g.op))).map((g) => String(g.id));
  const linear = f.op === "linearPattern";
  const axis = f.axis as { origin: Vec3; direction: Vec3 } | undefined;
  const two = f.direction2 !== undefined;
  return (
    <>
      <Field label="Feature">
        <Select value={String(f.feature)} options={seeds.map((s) => [s, s])} onChange={(v) => update({ feature: v })} testId="prop-pattern-feature" />
      </Field>
      {linear ? (
        <>
          <Field label="Direction">
            <DirectionInput value={f.direction as Vec3} onCommit={(v) => update({ direction: v })} testId="prop-pattern-direction" />
          </Field>
          <Field label="Spacing">
            <NumberInput value={f.spacing as number} min={0} onCommit={(v) => update({ spacing: v })} testId="prop-spacing" />
          </Field>
          <Field label="Count">
            <NumberInput value={f.count as number} min={2} step={1} onCommit={(v) => update({ count: v })} testId="prop-count" />
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={two}
              onChange={(e) =>
                update(e.target.checked ? { direction2: [0, 1, 0], spacing2: f.spacing, count2: 2 } : { direction2: null, spacing2: null, count2: null })
              }
            />
            Second direction
          </label>
          {two && (
            <>
              <Field label="Direction 2">
                <DirectionInput value={f.direction2 as Vec3} onCommit={(v) => update({ direction2: v })} />
              </Field>
              <Field label="Spacing 2">
                <NumberInput value={f.spacing2 as number} min={0} onCommit={(v) => update({ spacing2: v })} />
              </Field>
              <Field label="Count 2">
                <NumberInput value={f.count2 as number} min={2} step={1} onCommit={(v) => update({ count2: v })} />
              </Field>
            </>
          )}
        </>
      ) : (
        axis && (
          <>
            <Field label="Axis through">
              <Vec3Input value={axis.origin} onCommit={(v) => update({ axis: { ...axis, origin: v } })} />
            </Field>
            <Field label="Axis direction">
              <DirectionInput value={axis.direction} onCommit={(v) => update({ axis: { ...axis, direction: v } })} />
            </Field>
            <Field label="Count">
              <NumberInput value={f.count as number} min={2} step={1} onCommit={(v) => update({ count: v })} testId="prop-count" />
            </Field>
            <Field label="Total angle">
              <NumberInput value={(f.angle as number) ?? 360} min={0} onCommit={(v) => update({ angle: v === 360 ? null : v })} />
            </Field>
          </>
        )
      )}
    </>
  );
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

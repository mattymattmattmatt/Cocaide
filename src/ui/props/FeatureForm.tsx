// A feature's property editor from a field list (src/ui/props/spec.ts): each
// field one control, each commit one updateFeature. "Use selected" buttons
// turn what is picked in the view into selectors and references, so the
// feature follows the geometry through later edits.

import type { ReactNode } from "react";
import type { DatumPlane, EdgeSelector, FaceSelector, RefPlane, Vec3 } from "../../doc/types";
import { frameAsDatumPlane } from "../../features/datum";
import { round9 } from "../model/names";
import { planeSpecFrameIn } from "../model/sketchPlane";
import { describeEdgeSelector, describeWanted, selectEdges, selectFaces } from "../../kernel/selectors";
import { edgesSelectorFor, faceSelectorFor, facesSelectorFor } from "../../kernel/synthesize";
import { DirectionInput, Field, NumberInput, Select, Vec3Input, type NumberValue } from "../fields";
import { selectionSize, type PickTarget } from "../model/selection";
import type { PickField } from "./picking";
import { isPickSpec, pickFieldFor, type EdgeOptions } from "./pickFields";
import { usePickField, usePickHost } from "./pickHost";
import { datumChoices, describeRef, isDatum, refFromSelection, type DatumKind, type DatumRef } from "./datumRef";
import {
  acceptsOf,
  asList,
  commitPatch,
  featureChoices,
  fieldTestId,
  fieldValue,
  selectOptions,
  sketchLineChoices,
  toggled,
  valueAt,
  visibleFields,
  type FieldProps,
  type FieldSpec,
} from "./spec";

/** The select value of a reference picked in the view (a face or an edge), which has no id. */
const PICKED = "__picked";
/** The select value of an inline plane (a point and a normal). */
const CUSTOM = "__custom";

/**
 * `order`: where these fields sit among the panel's selection fields (Tab
 * goes through them in order), for an editor that shows several forms.
 */
export function FeatureForm({ fields, order = 0, ...p }: FieldProps & { fields: FieldSpec[]; order?: number }) {
  return (
    <>
      {visibleFields(fields, p.f, p).map((spec, i) => (
        <FieldView key={`${spec.kind}:${spec.key}`} spec={spec} p={p} order={order + i} />
      ))}
    </>
  );
}

/**
 * A selection field during a session: active (outlined, what the view's
 * clicks go into) or not; a click on it or focus makes it active. Its pick
 * field goes to the session's host.
 */
function PickWrap({ field, children, tid }: { field: PickField | null; children: ReactNode; tid: string }) {
  const host = usePickHost();
  usePickField(field);
  if (!host || !field) return <>{children}</>;
  const active = host.active === field.key;
  return (
    <div
      className={`pick-field${active ? " active" : ""}${field.count ? "" : " empty"}`}
      data-testid={`${tid}-pick`}
      data-active={active || undefined}
      onPointerDown={() => !active && host.setActive(field.key)}
      onFocus={() => !active && host.setActive(field.key)}
    >
      {children}
      {active && (
        <span className="pick-prompt" data-testid="pick-prompt">
          {field.takes.length ? `${field.prompt}: click in the view (again to take it out)` : field.prompt}
        </span>
      )}
    </div>
  );
}

/** For an edge field in a session: tangent propagation (on by default) and which corners it takes. */
function EdgeOptionsRow({ tid }: { tid: string }) {
  const host = usePickHost();
  if (!host) return null;
  const { edge, setEdge } = host;
  return (
    <span className="pick-options">
      <label className="check" title="Picking an edge takes the edges that run on smoothly from it too (a fillet's boundary, a slot's outline)">
        <input type="checkbox" checked={edge.propagate} onChange={(e) => setEdge({ ...edge, propagate: e.target.checked })} data-testid={`${tid}-propagate`} />
        Tangent propagation
      </label>
      <Select
        value={edge.kinds}
        options={[
          ["all", "All edges"],
          ["convex", "Outside corners only"],
          ["concave", "Inside corners only"],
        ]}
        onChange={(v) => setEdge({ ...edge, kinds: v as EdgeOptions["kinds"] })}
        testId={`${tid}-corners`}
      />
    </span>
  );
}

/** A select that shows a placeholder while its value is none of its options. */
function Choice({ value, options, placeholder, onChange, testId }: { value: string; options: [string, string][]; placeholder: string; onChange(v: string): void; testId: string }) {
  const all: [string, string][] = options.some(([v]) => v === value) ? options : [[value, value === "" ? placeholder : `${value} (not available here)`], ...options];
  return <Select value={value} options={all} onChange={onChange} testId={testId} />;
}

function FieldView({ spec, p, order }: { spec: FieldSpec; p: FieldProps; order: number }) {
  const v = fieldValue(spec, p.f, p);
  // A field's own `set` may refuse a value with an Error that says what to do (a mode that needs something selected first).
  const commit = (value: unknown) => {
    let patch: Record<string, unknown>;
    try {
      patch = commitPatch(spec, value, p.f, p);
    } catch (e) {
      return p.setError(e instanceof Error ? e.message : String(e));
    }
    p.setError(null);
    return p.update(patch);
  };
  const tid = fieldTestId(spec);
  // In a session, a selection field is live: the view's clicks go into it while it is active.
  const host = usePickHost();
  const field =
    host && isPickSpec(spec)
      ? pickFieldFor(spec, p.f, p, order, { view: host.view, before: p.before, bodies: p.bodies, edge: host.edge, chainOf: host.chainOf, passes: host.passes }, (value) => {
          let patch: Record<string, unknown>;
          try {
            patch = commitPatch(spec, value, p.f, p);
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
          const r = p.update(patch);
          return typeof r === "string" ? r : null;
        })
      : null;
  const view = renderField(spec, p, v, commit, tid, field);
  return field ? (
    <PickWrap field={field} tid={tid}>
      {view}
    </PickWrap>
  ) : (
    view
  );
}

function renderField(spec: FieldSpec, p: FieldProps, v: unknown, commit: (value: unknown) => string | null | void, tid: string, field: PickField | null): ReactNode {
  switch (spec.kind) {
    case "number":
      return (
        <Field label={spec.label} unit={spec.unit} hint={spec.hint}>
          <NumberInput value={(v ?? "") as NumberValue} min={spec.min} onCommit={commit} testId={tid} />
        </Field>
      );
    case "select":
      return (
        <Field label={spec.label} hint={spec.hint}>
          <Choice value={String(v ?? "")} options={selectOptions(spec, p.f, p)} placeholder="Choose…" onChange={commit} testId={tid} />
        </Field>
      );
    case "bool":
      return (
        <label className="check" title={spec.hint}>
          <input type="checkbox" checked={v === true} onChange={(e) => commit(e.target.checked)} data-testid={tid} />
          {spec.label}
        </label>
      );
    case "vec3":
      return (
        <Field label={spec.label} unit={spec.unit} hint={spec.hint}>
          <Vec3Input value={(v as NumberValue[] | undefined) ?? [0, 0, 0]} onCommit={commit} testId={tid} />
        </Field>
      );
    case "direction":
      return (
        <Field label={spec.label} hint={spec.hint}>
          <DirectionInput value={(v as NumberValue[] | undefined) ?? [0, 0, 1]} onCommit={commit} testId={tid} />
        </Field>
      );
    case "plane":
      return <PlaneField spec={spec} value={v} commit={commit} tid={tid} p={p} />;
    case "datumRef":
      return <DatumRefField spec={spec} value={v} commit={commit} tid={tid} p={p} />;
    case "face":
    case "faces":
    case "edges":
      return <SelectorField spec={spec} value={v} commit={commit} tid={tid} p={p} field={field} />;
    case "feature":
    case "sketch": {
      const options = featureChoices(p.before, spec.kind === "sketch" ? ["sketch"] : spec.ops);
      const optional = spec.kind === "feature" && spec.optional;
      return (
        <Field label={spec.label} hint={spec.hint}>
          <Choice
            value={typeof v === "string" ? v : ""}
            options={optional ? [["", "None"], ...options] : options}
            placeholder="Choose…"
            onChange={(id) => id !== "" ? commit(id) : optional && commit(null)}
            testId={tid}
          />
        </Field>
      );
    }
    case "sketchLine": {
      const options = sketchLineChoices(p.before, valueAt(p.f, spec.sketchKey ?? "sketch"));
      return (
        <Field label={spec.label} hint={spec.hint ?? (options.length ? undefined : "The sketch has no lines: draw one, or a centreline")}>
          <Choice value={typeof v === "string" ? v : ""} options={options} placeholder="Choose a line…" onChange={(id) => id && commit(id)} testId={tid} />
        </Field>
      );
    }
    case "features":
      return (
        <Checks
          label={spec.label}
          hint={spec.hint}
          tid={tid}
          choices={featureChoices(p.before, spec.ops)}
          list={Array.isArray(v) ? (v as string[]) : []}
          allowEmpty
          onChange={(next) => commit(next.length ? next : null)}
        />
      );
    case "bodies":
      return (
        <Checks
          label={spec.label}
          hint={spec.hint}
          tid={tid}
          choices={p.bodies.map((b): [string, string] => [b, b])}
          list={Array.isArray(v) ? (v as string[]) : []}
          allowEmpty={spec.allowEmpty === true}
          emptyHint={spec.emptyHint}
          onChange={(next) => commit(next.length ? next : null)}
        />
      );
    case "custom":
      return <>{spec.render(p)}</>;
  }
}

/** Ticked items of a list (features, bodies), kept in the list's order. */
function Checks({ label, hint, tid, choices, list, allowEmpty, emptyHint, onChange }: { label: string; hint?: string; tid: string; choices: [string, string][]; list: string[]; allowEmpty: boolean; emptyHint?: string; onChange(next: string[]): void }) {
  const order = choices.map(([id]) => id);
  return (
    <Field label={label} hint={hint} block>
      <span className="body-checks" data-testid={tid}>
        {choices.map(([id, text]) => (
          <label key={id} className="check">
            <input
              type="checkbox"
              checked={list.includes(id)}
              onChange={(e) => {
                const next = toggled(list, id, e.target.checked, order, allowEmpty);
                if (next) onChange(next);
              }}
              data-testid={`${tid}-${id}`}
            />
            {text}
          </label>
        ))}
        {!choices.length && <span className="muted small">none before this feature</span>}
        {emptyHint && !list.length && <span className="muted small">{emptyHint}</span>}
      </span>
    </Field>
  );
}

/** A written-out plane with its numbers as the document keeps them (9 decimals, no -0). */
function roundPlane(p: DatumPlane): DatumPlane {
  const r = (v: Vec3) => v.map(round9) as Vec3;
  return { type: "datum", normal: r(p.normal), origin: r(p.origin), ...(p.xDir ? { xDir: r(p.xDir) } : {}) };
}

/** A plane referred to, as a plane field with `refs` holds it (DESIGN §2.3). */
type PlaneRef = { type: "ref"; ref: DatumRef; offset?: NumberValue; flip?: boolean; xDir?: Vec3 };

/** A plane: inline (a point it passes through and its normal) or, with `refs`, a reference to a plane. */
function PlaneField({ spec, value, commit, tid, p }: { spec: Extract<FieldSpec, { kind: "plane" }>; value: unknown; commit(v: unknown): void; tid: string; p: FieldProps }) {
  const fallback = spec.default ?? ({ type: "datum", normal: [1, 0, 0], origin: [0, 0, 0] } as DatumPlane);
  const asRef = spec.refs && (value as { type?: unknown } | undefined)?.type === "ref" ? (value as PlaneRef) : null;
  const plane = (!asRef && (value as DatumPlane | undefined)?.normal ? value : fallback) as DatumPlane;
  // Without undefined keys: the document refuses fields it does not know, even empty ones.
  const withRef = (r: PlaneRef, change: Partial<Omit<PlaneRef, "type" | "ref">>): PlaneRef => {
    const out: PlaneRef = { type: "ref", ref: r.ref };
    const next = { offset: r.offset, flip: r.flip, xDir: r.xDir, ...change };
    if (next.offset !== undefined && next.offset !== 0) out.offset = next.offset;
    if (next.flip) out.flip = true;
    if (next.xDir) out.xDir = next.xDir;
    return out;
  };
  const choices = spec.refs ? datumChoices(p.before, ["plane"]) : [];
  const current = !asRef ? CUSTOM : isDatum(asRef.ref) ? asRef.ref.datum : PICKED;
  return (
    <>
      {spec.refs && (
        <Field label={spec.label} hint={spec.hint} block>
          <span className="datum-ref">
            <Choice
              value={current}
              options={[[CUSTOM, "Through a point (custom)"], ...choices.map((c): [string, string] => [c.id, c.label]), ...(current === PICKED ? [[PICKED, "Picked in the view"] as [string, string]] : [])]}
              placeholder="Choose a plane…"
              onChange={(id) => {
                if (id === PICKED) return;
                if (id !== CUSTOM) return commit({ type: "ref", ref: { datum: id } });
                // Written out where the reference is now, so the plane does not jump.
                const now = asRef ? planeSpecFrameIn(asRef as RefPlane, p.view) : null;
                commit(now && typeof now !== "string" ? roundPlane(frameAsDatumPlane(now)) : plane);
              }}
              testId={tid}
            />
            <button
              type="button"
              className="use-selected"
              disabled={selectionSize(p.selection) === 0 || !p.view}
              title="Use the flat face or the plane selected: the plane follows it when the part changes"
              onClick={() => {
                const r = refFromSelection(p.selection, p.view, ["plane"], p.before);
                if (!r.ok) return p.setError(r.error);
                p.setError(null);
                commit({ type: "ref", ref: r.ref });
              }}
              data-testid={`${tid}-use`}
            >
              Use selected
            </button>
          </span>
        </Field>
      )}
      {asRef ? (
        <>
          <span className="ref-chip" data-testid={`${tid}-ref`}>
            {describeRef(asRef.ref, p.before)}
          </span>
          <Field label="Offset" unit="mm">
            <NumberInput value={asRef.offset ?? 0} onCommit={(offset) => commit(withRef(asRef, { offset }))} testId={`${tid}-offset`} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={asRef.flip === true} onChange={(e) => commit(withRef(asRef, { flip: e.target.checked }))} data-testid={`${tid}-flip`} />
            Flip the normal
          </label>
        </>
      ) : (
        <>
          <Field label={`${spec.label} through`} unit="mm" hint={spec.refs ? undefined : spec.hint}>
            <Vec3Input value={plane.origin} onCommit={(origin) => commit({ ...plane, type: "datum", origin })} testId={`${tid}-origin`} />
          </Field>
          <Field label={`${spec.label} normal`}>
            <DirectionInput value={plane.normal} onCommit={(normal) => commit({ ...plane, type: "datum", normal: normal as Vec3 })} testId={`${tid}-normal`} />
          </Field>
        </>
      )}
    </>
  );
}

const AT_OPTIONS: [string, string][] = [
  ["", "the whole edge"],
  ["start", "its start"],
  ["end", "its end"],
  ["mid", "its midpoint"],
  ["center", "its centre (round edge)"],
];

/** A plane, axis or point: a default one or a reference feature from the list, or what is picked in the view. */
function DatumRefField({ spec, value, commit, tid, p }: { spec: Extract<FieldSpec, { kind: "datumRef" }>; value: unknown; commit(v: unknown): void; tid: string; p: FieldProps }) {
  const ref = value as DatumRef | undefined;
  const accepts = acceptsOf(spec, p.f, p);
  // A field that takes only picked geometry (a cylinder's face) offers no planes, axes or points to choose.
  const choices = spec.forms && !spec.forms.includes("datum") ? [] : datumChoices(p.before, accepts);
  const picked = ref !== undefined && ref !== null && !isDatum(ref);
  const current = ref === undefined || ref === null ? "" : isDatum(ref) ? ref.datum : PICKED;
  const options: [string, string][] = [...(spec.optional ? [["", "None"] as [string, string]] : []), ...choices.map((c): [string, string] => [c.id, c.label]), ...(picked ? [[PICKED, "Picked in the view"] as [string, string]] : [])];
  const edge = ref && "edge" in ref ? ref : null;
  const someSelected = selectionSize(p.selection) > 0;
  return (
    <>
      <Field label={spec.label} hint={spec.hint} block>
        <span className="datum-ref">
          <Choice
            value={current}
            options={options}
            placeholder={`Choose ${accepts.join(" or ")}…`}
            onChange={(id) => {
              if (id === PICKED) return;
              if (id === "") return spec.optional && commit(null);
              commit({ datum: id });
            }}
            testId={tid}
          />
          <button
            type="button"
            className="use-selected"
            disabled={!someSelected || !p.view}
            title={`Use the face, edge, vertex or plane selected as ${accepts.join(" or ")}`}
            onClick={() => {
              if (spec.pick) {
                let picked: DatumRef;
                try {
                  picked = spec.pick(p.f, p);
                } catch (e) {
                  return p.setError(e instanceof Error ? e.message : String(e));
                }
                p.setError(null);
                return commit(picked);
              }
              const r = refFromSelection(p.selection, p.view, accepts, p.before);
              if (!r.ok) return p.setError(r.error);
              p.setError(null);
              commit(r.ref);
            }}
            data-testid={`${tid}-use`}
          >
            Use selected
          </button>
        </span>
      </Field>
      {ref !== undefined && ref !== null && (
        <span className="ref-chip" data-testid={`${tid}-ref`} title="What this refers to; picked geometry is found again after every rebuild">
          {describeRef(ref, p.before)}
        </span>
      )}
      {edge && accepts.includes("point") && (
        <Field label="Point on it">
          <Select
            value={edge.at ?? ""}
            options={AT_OPTIONS}
            onChange={(at) => commit(at ? { edge: edge.edge, at } : { edge: edge.edge })}
            testId={`${tid}-at`}
          />
        </Field>
      )}
    </>
  );
}

/** Faces or edges picked in the view, as selectors: listed in words, replaced by "Use selected". */
function SelectorField({ spec, value, commit, tid, p, field }: { spec: Extract<FieldSpec, { kind: "face" | "faces" | "edges" }>; value: unknown; commit(v: unknown): void; tid: string; p: FieldProps; field: PickField | null }) {
  const { selection, view } = p;
  const host = usePickHost();
  const session = !!host && !!field;
  /** In a session each selector is a chip: hovered, what it finds lights up in the view. */
  const chip = (items: () => PickTarget[]) =>
    session ? { className: "selector-line pick-chip", onPointerEnter: () => host!.peek(items()), onPointerLeave: () => host!.peek(null) } : { className: "selector-line" };
  const lines: ReactNode[] = [];
  let use: { label: string; disabled: boolean; run(): void };
  if (spec.kind === "edges") {
    const list = asList<EdgeSelector>(value);
    // An optional list (a fillet that may name faces instead) can be emptied one selector at a time.
    const removable = spec.optional === true;
    const pickView = host?.view ?? view;
    list.forEach((e, i) =>
      lines.push(
        <span key={i} {...chip(() => (pickView ? selectEdges(pickView.edges, pickView.faces, e).matches.map((m) => ({ kind: "edge" as const, index: m.index, point: m.mid })) : []))}>
          {describeEdgeSelector(e)}
          {removable && (
            <button
              type="button"
              className="selector-remove"
              aria-label={`Leave out edges ${i + 1}`}
              title="Leave these edges out"
              onClick={() => {
                const rest = list.filter((_, k) => k !== i);
                commit(rest.length === 0 ? null : rest.length === 1 ? rest[0] : rest);
              }}
              data-testid={`${tid}-remove-${i}`}
            >
              ×
            </button>
          )}
        </span>,
      ),
    );
    use = {
      label: "Use selected edges",
      disabled: selection.edges.length === 0 || !view,
      run: () => {
        const s = edgesSelectorFor(view!.edges, view!.faces, selection.edges);
        if (!s.ok) return p.setError(s.error);
        commit(s.selector);
      },
    };
  } else {
    const list = asList<FaceSelector>(value);
    const removable = spec.kind === "faces" && (spec.optional || list.length > 1);
    const pickView = host?.view ?? view;
    list.forEach((s, i) =>
      lines.push(
        <span key={i} {...chip(() => (pickView ? selectFaces(pickView.faces, s).matches.map((m) => ({ kind: "face" as const, index: m.index, point: m.centroid })) : []))}>
          {describeWanted(s, 1).replace(/^1 /, "")}
          {removable && (
            <button type="button" className="selector-remove" aria-label={`Leave out face ${i + 1}`} title="Leave this face out" onClick={() => commit(list.filter((_, k) => k !== i))} data-testid={`${tid}-remove-${i}`}>
              ×
            </button>
          )}
        </span>,
      ),
    );
    use =
      spec.kind === "face"
        ? {
            label: "Use selected face",
            disabled: selection.faces.length !== 1 || !view,
            run: () => {
              const s = faceSelectorFor(view!.faces, selection.faces[0]);
              if (!s.ok) return p.setError(s.error);
              commit(s.selector);
            },
          }
        : {
            label: selection.faces.length > 1 ? `Use the ${selection.faces.length} selected faces` : "Use selected faces",
            disabled: selection.faces.length === 0 || !view,
            run: () => {
              const s = facesSelectorFor(view!.faces, selection.faces);
              if (!s.ok) return p.setError(s.error);
              commit(s.selector);
            },
          };
  }
  return (
    <>
      <Field label={spec.label} hint={spec.hint} block>
        <span className={`readout${session ? " pick-box" : ""}`} data-testid={tid} tabIndex={session ? 0 : undefined}>
          {lines.length ? lines : session ? <span className="muted">none yet</span> : <span className="muted">none: select in the view (Ctrl-click for more), then {use.label}</span>}
        </span>
      </Field>
      {session && spec.kind === "edges" && spec.propagation && <EdgeOptionsRow tid={tid} />}
      <button
        type="button"
        disabled={use.disabled}
        onClick={() => {
          p.setError(null);
          use.run();
        }}
        data-testid={`${tid}-use`}
      >
        {use.label}
      </button>
    </>
  );
}

export type { DatumKind };

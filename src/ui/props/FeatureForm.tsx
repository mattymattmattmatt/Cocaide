// A feature's property editor from a field list (src/ui/props/spec.ts): each
// field one control, each commit one updateFeature. "Use selected" buttons
// turn what is picked in the view into selectors and references, so the
// feature follows the geometry through later edits.

import type { ReactNode } from "react";
import type { DatumPlane, EdgeSelector, FaceSelector, Vec3 } from "../../doc/types";
import { describeEdgeSelector, describeWanted } from "../../kernel/selectors";
import { edgesSelectorFor, faceSelectorFor, facesSelectorFor } from "../../kernel/synthesize";
import { DirectionInput, Field, NumberInput, Select, Vec3Input, type NumberValue } from "../fields";
import { datumChoices, describeRef, isDatum, refFromSelection, type DatumKind, type DatumRef } from "./datumRef";
import {
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

export function FeatureForm({ fields, ...p }: FieldProps & { fields: FieldSpec[] }) {
  return (
    <>
      {visibleFields(fields, p.f, p).map((spec) => (
        <FieldView key={`${spec.kind}:${spec.key}`} spec={spec} p={p} />
      ))}
    </>
  );
}

/** A select that shows a placeholder while its value is none of its options. */
function Choice({ value, options, placeholder, onChange, testId }: { value: string; options: [string, string][]; placeholder: string; onChange(v: string): void; testId: string }) {
  const all: [string, string][] = options.some(([v]) => v === value) ? options : [[value, value === "" ? placeholder : `${value} (not available here)`], ...options];
  return <Select value={value} options={all} onChange={onChange} testId={testId} />;
}

function FieldView({ spec, p }: { spec: FieldSpec; p: FieldProps }) {
  const v = fieldValue(spec, p.f, p);
  const commit = (value: unknown) => p.update(commitPatch(spec, value, p.f, p));
  const tid = fieldTestId(spec);
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
      return <SelectorField spec={spec} value={v} commit={commit} tid={tid} p={p} />;
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
                commit(id === CUSTOM ? plane : { type: "ref", ref: { datum: id } });
              }}
              testId={tid}
            />
            <button
              type="button"
              className="use-selected"
              disabled={p.selection.faces.length + p.selection.edges.length === 0 || !p.view}
              title="Use the flat face selected in the view: the plane follows it when the part changes"
              onClick={() => {
                const r = refFromSelection(p.selection, p.view, ["plane"]);
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
  const choices = datumChoices(p.before, spec.accepts);
  const picked = ref !== undefined && ref !== null && !isDatum(ref);
  const current = ref === undefined || ref === null ? "" : isDatum(ref) ? ref.datum : PICKED;
  const options: [string, string][] = [...(spec.optional ? [["", "None"] as [string, string]] : []), ...choices.map((c): [string, string] => [c.id, c.label]), ...(picked ? [[PICKED, "Picked in the view"] as [string, string]] : [])];
  const edge = ref && "edge" in ref ? ref : null;
  const someSelected = p.selection.faces.length + p.selection.edges.length > 0;
  return (
    <>
      <Field label={spec.label} hint={spec.hint} block>
        <span className="datum-ref">
          <Choice
            value={current}
            options={options}
            placeholder={`Choose ${spec.accepts.join(" or ")}…`}
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
            title={`Use the face or edge selected in the view as ${spec.accepts.join(" or ")}`}
            onClick={() => {
              const r = refFromSelection(p.selection, p.view, spec.accepts);
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
      {edge && spec.accepts.includes("point") && (
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
function SelectorField({ spec, value, commit, tid, p }: { spec: Extract<FieldSpec, { kind: "face" | "faces" | "edges" }>; value: unknown; commit(v: unknown): void; tid: string; p: FieldProps }) {
  const { selection, view } = p;
  const lines: ReactNode[] = [];
  let use: { label: string; disabled: boolean; run(): void };
  if (spec.kind === "edges") {
    const list = asList<EdgeSelector>(value);
    list.forEach((e, i) => lines.push(<span key={i} className="selector-line">{describeEdgeSelector(e)}</span>));
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
    list.forEach((s, i) =>
      lines.push(
        <span key={i} className="selector-line">
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
        <span className="readout" data-testid={tid}>
          {lines.length ? lines : <span className="muted">none: select in the view (Ctrl-click for more), then {use.label}</span>}
        </span>
      </Field>
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

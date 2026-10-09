// The multibody tools' properties (Phase M): mirror, split, move/copy and
// delete/keep. Each field is one updateFeature; naming a new body is a
// renameBody, so whatever names it follows.

import { DERIVED_SUFFIX, type Vec3 } from "../doc/types";
import { DirectionInput, Field, NumberInput, Select, TextInput, Vec3Input } from "./fields";
import { FeatureForm } from "./props/FeatureForm";
import type { FieldProps } from "./props/spec";

type Raw = Record<string, unknown>;

interface ToolProps {
  f: Raw;
  /** The bodies there are before this feature. */
  bodies: string[];
  update(p: Raw): unknown;
  rename(from: string, to: string): unknown;
}

/**
 * A mirror's or split's plane: a default plane, a plane feature or a flat
 * face picked (by reference, so it follows the model), or written out
 * through a point with a normal.
 */
function PlaneFields({ form, testId }: { form: FieldProps; testId: string }) {
  return <FeatureForm fields={[{ kind: "plane", key: "plane", label: "Plane", refs: true, testId }]} {...form} />;
}

function BodyChecks({ list, bodies, onChange, testId, hint }: { list: string[]; bodies: string[]; onChange(next: string[]): void; testId: string; hint?: string }) {
  return (
    <span className="body-checks" data-testid={testId}>
      {bodies.map((b) => (
        <label key={b} className="check">
          <input
            type="checkbox"
            checked={list.includes(b)}
            onChange={(e) => {
              const next = e.target.checked ? [...list, b] : list.filter((x) => x !== b);
              if (next.length) onChange(bodies.filter((x) => next.includes(x)));
            }}
            data-testid={`${testId}-${b}`}
          />
          {b}
        </label>
      ))}
      {hint && <span className="muted small">{hint}</span>}
    </span>
  );
}

/** The name of the one new body a tool makes: shown, and renamed through renameBody. */
function NewBodyName({ name, rename, testId }: { name: string; rename(from: string, to: string): unknown; testId: string }) {
  return (
    <Field label="New body">
      <TextInput value={name} onCommit={(to) => to !== name && rename(name, to)} testId={testId} />
    </Field>
  );
}

export function MirrorProps({ f, bodies, update, rename, seeds, form }: ToolProps & { seeds: { id: string; body?: string }[]; form: FieldProps }) {
  const byBodies = Array.isArray(f.bodies);
  const listed = byBodies ? (f.bodies as string[]) : [];
  const seed = seeds.find((s) => s.id === f.feature);
  const made = typeof f.newBody === "string" ? f.newBody : byBodies ? (listed.length === 1 && !f.merge ? `${listed[0]}${DERIVED_SUFFIX.mirror}` : null) : seed?.body ? `${seed.body}${DERIVED_SUFFIX.mirror}` : null;
  return (
    <>
      <Field label="Mirror">
        <Select
          value={byBodies ? "bodies" : "feature"}
          options={[
            ["feature", "a feature"],
            ["bodies", "bodies"],
          ]}
          onChange={(v) => update(v === "bodies" ? { feature: null, newBody: null, bodies: bodies.slice(-1) } : { bodies: null, merge: null, newBody: null, feature: seeds.at(-1)?.id ?? null })}
          testId="prop-mirror-what"
        />
      </Field>
      {byBodies ? (
        <>
          <Field label="Bodies">
            <BodyChecks list={listed} bodies={bodies} onChange={(next) => update({ bodies: next, ...(next.length > 1 ? { newBody: null } : {}) })} testId="prop-mirror-bodies" />
          </Field>
          <label className="check">
            <input type="checkbox" checked={f.merge === true} onChange={(e) => update({ merge: e.target.checked || null, ...(e.target.checked ? { newBody: null } : {}) })} data-testid="prop-mirror-merge" />
            Merge each into itself
          </label>
        </>
      ) : (
        <Field label="Feature">
          <Select value={String(f.feature)} options={seeds.map((s): [string, string] => [s.id, s.id])} onChange={(v) => update({ feature: v, newBody: null })} testId="prop-mirror-feature" />
        </Field>
      )}
      <PlaneFields form={form} testId="prop-mirror-plane" />
      {made && <NewBodyName name={made} rename={rename} testId="prop-mirror-name" />}
      {byBodies && listed.length > 1 && !f.merge && <p className="muted small">Each makes a new body: {listed.map((b) => `${b}${DERIVED_SUFFIX.mirror}`).join(", ")}.</p>}
    </>
  );
}

export function SplitProps({ f, bodies, update, rename, form }: ToolProps & { form: FieldProps }) {
  const body = String(f.body);
  const piece = typeof f.newBody === "string" ? f.newBody : `${body}${DERIVED_SUFFIX.split}`;
  return (
    <>
      <Field label="Body">
        <Select value={body} options={bodies.map((b): [string, string] => [b, b])} onChange={(v) => update({ body: v, newBody: null })} testId="prop-split-body" />
      </Field>
      <PlaneFields form={form} testId="prop-split-plane" />
      <NewBodyName name={piece} rename={rename} testId="prop-split-name" />
      <p className="muted small">The piece the normal points to becomes {piece}; the other stays {body}.</p>
    </>
  );
}

export function MoveProps({ f, bodies, update, rename }: ToolProps) {
  const listed = Array.isArray(f.bodies) ? (f.bodies as string[]) : [];
  const rotate = f.rotate as { axis: { origin: Vec3; direction: Vec3 }; angle: number } | undefined;
  const copy = f.copy === true;
  const made = copy && listed.length === 1 ? (typeof f.newBody === "string" ? f.newBody : `${listed[0]}${DERIVED_SUFFIX.move}`) : null;
  return (
    <>
      <Field label="Bodies">
        <BodyChecks list={listed} bodies={bodies} onChange={(next) => update({ bodies: next, ...(next.length > 1 ? { newBody: null } : {}) })} testId="prop-move-bodies" />
      </Field>
      <label className="check">
        <input type="checkbox" checked={copy} onChange={(e) => update({ copy: e.target.checked || null, ...(e.target.checked ? {} : { newBody: null }) })} data-testid="prop-move-copy" />
        Copy (keep the originals)
      </label>
      <Field label="Move by" unit="mm">
        <Vec3Input value={(f.translate as Vec3) ?? [0, 0, 0]} onCommit={(v) => update({ translate: v.every((x) => x === 0) && rotate ? null : v })} testId="prop-move-translate" />
      </Field>
      <label className="check">
        <input
          type="checkbox"
          checked={!!rotate}
          onChange={(e) => update({ rotate: e.target.checked ? { axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, angle: 90 } : null, ...(!e.target.checked && !f.translate ? { translate: [0, 0, 0] } : {}) })}
          data-testid="prop-move-turn"
        />
        Turn first
      </label>
      {rotate && (
        <>
          <Field label="About axis through" unit="mm">
            <Vec3Input value={rotate.axis.origin} onCommit={(origin) => update({ rotate: { ...rotate, axis: { ...rotate.axis, origin } } })} testId="prop-move-axis-origin" />
          </Field>
          <Field label="Axis direction">
            <DirectionInput value={rotate.axis.direction} onCommit={(direction) => update({ rotate: { ...rotate, axis: { ...rotate.axis, direction } } })} testId="prop-move-axis" />
          </Field>
          <Field label="Angle" unit="°">
            <NumberInput value={rotate.angle} onCommit={(angle) => update({ rotate: { ...rotate, angle } })} testId="prop-move-angle" />
          </Field>
        </>
      )}
      {made && <NewBodyName name={made} rename={rename} testId="prop-move-name" />}
    </>
  );
}

export function DeleteBodyProps({ f, bodies, update }: ToolProps) {
  const keep = Array.isArray(f.keep);
  const listed = ((keep ? f.keep : f.bodies) as string[]) ?? [];
  return (
    <>
      <Field label="Bodies">
        <Select
          value={keep ? "keep" : "delete"}
          options={[
            ["delete", "Delete these"],
            ["keep", "Keep only these"],
          ]}
          onChange={(v) => update(v === "keep" ? { bodies: null, keep: listed } : { keep: null, bodies: listed })}
          testId="prop-delete-mode"
        />
      </Field>
      <Field label={keep ? "Keep" : "Delete"}>
        <BodyChecks list={listed} bodies={bodies} onChange={(next) => update(keep ? { keep: next } : { bodies: next })} testId="prop-delete-bodies" />
      </Field>
    </>
  );
}

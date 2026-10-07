// Properties of a frame's features (Phases I and J): members, joints, end caps
// and gussets. Each field commits one command; a change that touches several
// features (every member of a size) is one undo step.

import type { Command, RawDocument } from "../doc/commands";
import { nextId } from "../doc/commands";
import type { MemberFeature, ProfileDef, Vec3 } from "../doc/types";
import { memberAtNode, validateDocument } from "../doc/validate";
import type { RebuildView } from "../worker/protocol";
import { anglesText } from "../weldment/cutlist";
import { Field, NumberInput, Select, TextInput, Vec3Input, type NumberValue } from "./fields";

type Raw = Record<string, unknown>;

export interface FrameActions {
  /** Adds a feature and selects it. */
  onCreate(feature: Raw): void;
  /** Several commands as one undo step; the problem, or null. */
  onBatch(cmds: Command[]): string | null;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** The members at a node, from the validated document: those that end there, and those that pass through. */
function membersAt(doc: RawDocument, node: string): { ending: MemberFeature[]; passing: MemberFeature[] } {
  const v = validateDocument(doc);
  const at = v.nodes[node];
  const members = v.features.flatMap((x) => (x.feature?.op === "member" ? [x.feature] : []));
  if (!at) return { ending: [], passing: [] };
  return {
    ending: members.filter((m) => memberAtNode(m, node, at) === "ends"),
    passing: members.filter((m) => memberAtNode(m, node, at) === "passes"),
  };
}

const bodyOf = (m: { id: string; newBody?: string }) => m.newBody ?? m.id;

/** The next free weld id: w1, w2, ... */
export function nextWeldId(doc: RawDocument): string {
  const taken = new Set((Array.isArray(doc.welds) ? doc.welds : []).map((w) => (w as { id?: unknown }).id));
  for (let k = 1; ; k++) if (!taken.has(`w${k}`)) return `w${k}`;
}

// ------------------------------------------------------------------ member

export function MemberProps({
  f,
  resolved,
  doc,
  view,
  update,
  rename,
  actions,
}: {
  f: Raw;
  resolved: Raw;
  doc: RawDocument;
  view: RebuildView | null;
  update(p: Raw): unknown;
  rename(from: string, to: string): unknown;
  actions?: FrameActions;
}) {
  const profiles = (doc.profiles ?? {}) as Record<string, ProfileDef>;
  const profile = profiles[String(f.profile)];
  const sizes = profile?.sizes.map((s) => s.designation) ?? [];
  const nodes = validateDocument(doc).nodes;
  const point = (end: unknown): Vec3 | null => (typeof end === "string" ? (nodes[end] ?? null) : (end as Vec3));
  const from = point(resolved.from);
  const to = point(resolved.to);
  const d = from && to ? (to.map((c, i) => c - from[i]) as Vec3) : null;
  const length = d ? Math.hypot(...d) : 0;
  const body = typeof f.newBody === "string" ? f.newBody : String(f.id);
  const measured = view?.measurements?.members.find((m) => m.id === f.id);
  const alike = doc.features.filter((g) => g.op === "member" && g.profile === f.profile && g.size === f.size);
  const onNodes = typeof f.from === "string" || typeof f.to === "string";
  return (
    <>
      <Field label="Profile">
        <Select
          value={String(f.profile)}
          options={Object.keys(profiles).map((p): [string, string] => [p, p])}
          testId="prop-profile-name"
          onChange={(v) => update({ profile: v, size: profiles[v].sizes[0].designation })}
        />
      </Field>
      <Field label="Size">
        <Select value={String(f.size)} options={sizes.map((s): [string, string] => [s, s])} testId="prop-size" onChange={(v) => update({ size: v })} />
      </Field>
      {alike.length > 1 && actions && (
        <Field label="All like it" hint={`Every ${alike.length} members of ${String(f.size)}, as one change`}>
          <select
            value=""
            data-testid="prop-size-all"
            onChange={(e) => {
              const size = e.target.value;
              if (size) actions.onBatch(alike.map((g) => ({ type: "updateFeature", id: String(g.id), patch: { size } })));
            }}
          >
            <option value="">Switch all {alike.length} to…</option>
            {sizes
              .filter((s) => s !== f.size)
              .map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
          </select>
        </Field>
      )}
      <EndField label="From" value={f.from} at={from} nodes={nodes} onChange={(v) => update({ from: v })} testId="prop-from" />
      <EndField label="To" value={f.to} at={to} nodes={nodes} onChange={(v) => update({ to: v })} testId="prop-to" />
      <Field label="Length" hint={onNodes ? "Between its nodes: move a node to change it" : "Moves the end along the member"}>
        {onNodes ? (
          <span className="readout" data-testid="prop-length">
            {r2(length)}
          </span>
        ) : (
          <NumberInput
            value={Math.round(length * 1e6) / 1e6}
            min={0}
            testId="prop-length"
            onCommit={(v) => {
              const l = Number(v);
              if (!(l > 0) || !(length > 0) || !from || !d) return;
              update({ to: from.map((c, i) => Math.round((c + (d[i] * l) / length) * 1e6) / 1e6 + 0) });
            }}
          />
        )}
      </Field>
      <Field label="Rotation" hint="Degrees about the member's line">
        <NumberInput value={(f.rotation as NumberValue) ?? 0} onCommit={(v) => update({ rotation: v === 0 ? null : v })} testId="prop-rotation" />
      </Field>
      <Field label="On the line" hint="Seen from the To end: which point of the section the line runs through">
        <AlignGrid value={f.align as [number, number] | undefined} anchor={profile?.anchor ?? "centroid"} onChange={(a) => update({ align: a ?? null })} />
      </Field>
      <Field label="Body">
        <TextInput value={body} onCommit={(name) => name !== body && rename(body, name)} testId="prop-body-name" />
      </Field>
      {measured && (
        <Field label="Measured">
          <span className="readout" data-testid="prop-member-measured">
            {measured.designation} · {r2(measured.length)} mm · {anglesText([r1(measured.angles[0]), r1(measured.angles[1])])} · {r2(measured.massKg)} kg
          </span>
        </Field>
      )}
      {actions && (
        <div className="row-buttons">
          {(["start", "end"] as const).map((end) => (
            <button
              key={end}
              data-testid={`prop-cap-${end}`}
              title={`A plate of the section's outline on the member's ${end === "start" ? "From" : "To"} end`}
              onClick={() => actions.onCreate({ id: nextId(doc, "cap"), op: "endCap", member: String(f.id), end, thickness: 3 })}
            >
              Cap the {end === "start" ? "From" : "To"} end
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** A member's end: a node, or a point. */
function EndField({
  label,
  value,
  at,
  nodes,
  onChange,
  testId,
}: {
  label: string;
  value: unknown;
  at: Vec3 | null;
  nodes: Record<string, Vec3>;
  onChange(v: string | NumberValue[]): void;
  testId: string;
}) {
  const names = Object.keys(nodes);
  const node = typeof value === "string" ? value : null;
  return (
    <Field label={label}>
      <span className="end-field">
        {names.length > 0 && (
          <select
            value={node ?? ""}
            data-testid={`${testId}-node`}
            onChange={(e) => onChange(e.target.value ? e.target.value : ((at ?? [0, 0, 0]) as NumberValue[]))}
          >
            <option value="">A point</option>
            {names.map((n) => (
              <option key={n} value={n}>
                Node {n}
              </option>
            ))}
          </select>
        )}
        {node ? (
          <span className="readout">[{(at ?? []).map((c) => r2(c)).join(", ")}]</span>
        ) : (
          <Vec3Input value={value as NumberValue[]} onCommit={onChange} testId={testId} />
        )}
      </span>
    </Field>
  );
}

const ALIGN_ROWS = [1, 0, -1];
const ALIGN_COLS = [-1, 0, 1];

/** Nine points of the section's envelope, as seen from the member's To end, or the profile's anchor. */
function AlignGrid({ value, anchor, onChange }: { value: [number, number] | undefined; anchor: string; onChange(a: [number, number] | undefined): void }) {
  return (
    <span className="align-grid" data-testid="prop-align">
      <span className="align-cells">
        {ALIGN_ROWS.flatMap((ay) =>
          ALIGN_COLS.map((ax) => {
            const on = value?.[0] === ax && value?.[1] === ay;
            return (
              <button
                key={`${ax},${ay}`}
                className={on ? "on" : undefined}
                aria-pressed={on}
                aria-label={`Line through ${ay === 1 ? "top" : ay === -1 ? "bottom" : "middle"} ${ax === -1 ? "left" : ax === 1 ? "right" : "centre"}`}
                onClick={() => onChange([ax, ay])}
                data-testid={`prop-align-${ax}_${ay}`}
              />
            );
          }),
        )}
      </span>
      <button className={`align-anchor${value ? "" : " on"}`} aria-pressed={!value} onClick={() => onChange(undefined)} data-testid="prop-align-anchor">
        the {anchor === "centroid" ? "centroid" : "sketch origin"}
      </button>
    </span>
  );
}

// ------------------------------------------------------------------- joint

export function JointProps({ f, doc, view, update, actions }: { f: Raw; doc: RawDocument; view: RebuildView | null; update(p: Raw): unknown; actions?: FrameActions }) {
  const node = String(f.node);
  const { ending, passing } = membersAt(doc, node);
  const ids = ending.map((m) => m.id);
  const own = f.type === "mitre" ? ((f.members as string[] | undefined) ?? ids.slice(0, 2)) : [String(f.through)];
  const butting = ending.filter((m) => !own.includes(m.id));
  const options = (list: MemberFeature[]): [string, string][] => list.map((m) => [m.id, m.id]);
  const measured = view?.measurements?.members ?? [];
  /** The length round a member's end at this node, as measured. */
  const perimeterAt = (m: MemberFeature) => {
    const x = measured.find((y) => y.id === m.id);
    return x ? x.perimeters[m.fromNode === node ? 0 : 1] : 0;
  };
  const weldLength = () => {
    const mitred = f.type === "mitre" ? ending.filter((m) => own.includes(m.id)).slice(0, 1) : [];
    return r1([...mitred, ...butting].reduce((t, m) => t + perimeterAt(m), 0));
  };
  return (
    <>
      <Field label="Node">
        <span className="readout" data-testid="prop-joint-node">
          {node}
        </span>
      </Field>
      <Field label="Joint">
        <Select
          value={f.type as "mitre" | "butt"}
          testId="prop-joint-type"
          options={[
            ["mitre", "Mitre"],
            ["butt", "Butt"],
          ]}
          onChange={(v) =>
            update(v === "mitre" ? { type: v, members: ids.length === 2 ? null : ids.slice(0, 2), through: null } : { type: v, members: null, through: (passing[0] ?? ending[0])?.id ?? null })
          }
        />
      </Field>
      {f.type === "mitre" ? (
        [0, 1].map((i) => (
          <Field key={i} label={i === 0 ? "Mitres" : "with"}>
            <Select
              value={own[i] ?? ""}
              options={options(ending)}
              testId={`prop-joint-member-${i}`}
              onChange={(v) => {
                const next = [...own];
                next[i] = v;
                if (next[0] !== next[1]) update({ members: next });
              }}
            />
          </Field>
        ))
      ) : (
        <Field label="Runs through">
          <Select value={String(f.through)} options={options([...ending, ...passing])} testId="prop-joint-through" onChange={(v) => update({ through: v })} />
        </Field>
      )}
      <Field label="Gap" hint="Left between the cut faces, mm">
        <NumberInput value={(f.gap as NumberValue) ?? 0} min={0} onCommit={(v) => update({ gap: v === 0 ? null : v })} testId="prop-joint-gap" />
      </Field>
      <Field label="Butting">
        <span className="readout" data-testid="prop-joint-butting">
          {butting.length ? butting.map((m) => m.id).join(", ") : "nothing else ends here"}
        </span>
      </Field>
      {actions && (
        <div className="row-buttons">
          <button
            data-testid="prop-joint-gusset"
            title="A triangular plate in the inside corner"
            onClick={() => {
              const pair = butting.length ? [butting[0].id, own[0]] : own.slice(0, 2);
              actions.onCreate({ id: nextId(doc, "gusset"), op: "gusset", node, members: pair, size: 100, thickness: 6, chamfer: 10 });
            }}
          >
            Add a gusset
          </button>
          <button
            data-testid="prop-joint-weld"
            title="A fillet weld all round the joint, in the weld table"
            onClick={() => {
              const id = nextWeldId(doc);
              const between = [...new Set([...ending, ...passing].filter((m) => own.includes(m.id) || butting.includes(m)).map(bodyOf))];
              const length = weldLength();
              actions.onBatch([{ type: "setWeld", id, weld: { id, between, type: "fillet", size: 3, length: length > 0 ? length : 1, allRound: true, note: `joint ${String(f.id)} at ${node}` } }]);
            }}
          >
            Add a weld
          </button>
        </div>
      )}
    </>
  );
}

// ----------------------------------------------------------------- end cap

export function EndCapProps({ f, doc, update }: { f: Raw; doc: RawDocument; update(p: Raw): unknown }) {
  const members = doc.features.filter((g) => g.op === "member").map((g): [string, string] => [String(g.id), String(g.id)]);
  return (
    <>
      <Field label="Member">
        <Select value={String(f.member)} options={members} testId="prop-cap-member" onChange={(v) => update({ member: v })} />
      </Field>
      <Field label="End">
        <Select
          value={f.end as "start" | "end"}
          testId="prop-cap-end"
          options={[
            ["start", "From end"],
            ["end", "To end"],
          ]}
          onChange={(v) => update({ end: v })}
        />
      </Field>
      <Field label="Thickness">
        <NumberInput value={f.thickness as NumberValue} min={0} onCommit={(v) => update({ thickness: v })} testId="prop-cap-thickness" />
      </Field>
    </>
  );
}

// ------------------------------------------------------------------ gusset

export function GussetProps({ f, doc, update }: { f: Raw; doc: RawDocument; update(p: Raw): unknown }) {
  const node = String(f.node);
  const { ending, passing } = membersAt(doc, node);
  const pair = (f.members as string[]) ?? [];
  const options = [...ending, ...passing].map((m): [string, string] => [m.id, m.id]);
  return (
    <>
      <Field label="Node">
        <span className="readout">{node}</span>
      </Field>
      {[0, 1].map((i) => (
        <Field key={i} label={i === 0 ? "Between" : "and"}>
          <Select
            value={pair[i] ?? ""}
            options={options}
            testId={`prop-gusset-member-${i}`}
            onChange={(v) => {
              const next = [...pair];
              next[i] = v;
              if (next[0] !== next[1]) update({ members: next });
            }}
          />
        </Field>
      ))}
      <Field label="Size" hint="Along each member from the inside corner">
        <NumberInput value={f.size as NumberValue} min={0} onCommit={(v) => update({ size: v })} testId="prop-gusset-size" />
      </Field>
      <Field label="Thickness">
        <NumberInput value={f.thickness as NumberValue} min={0} onCommit={(v) => update({ thickness: v })} testId="prop-gusset-thickness" />
      </Field>
      <Field label="Chamfer" hint="Clips the corner for the weld">
        <NumberInput value={(f.chamfer as NumberValue) ?? 0} min={0} onCommit={(v) => update({ chamfer: v === 0 ? null : v })} testId="prop-gusset-chamfer" />
      </Field>
    </>
  );
}

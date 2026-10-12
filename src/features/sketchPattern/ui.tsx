// Sketch-driven pattern's properties: the features it copies, the sketch whose
// points are the places (or a table of positions in that sketch's plane),
// which point the seed sits at, and which instances it makes.

import { Field, NumberInput, Select, type NumberValue } from "../../ui/fields";
import type { FieldProps, FieldSpec } from "../../ui/props/spec";
import { InstanceChecks, seedsField } from "../linearPattern/fields";
import { placeRows, seedsOf } from "../linearPattern/instances";
import type { UiOp } from "../uiDefs";
import { copyPlaces } from "./doc";

type Raw = Record<string, unknown>;
type Vec2 = [number, number];

/** The point entities of a sketch among `before`, in order: [entity id, where]. */
export function sketchPointList(before: Raw[], sketch: unknown): [string, Vec2][] {
  const sk = before.find((g) => g.id === sketch && g.op === "sketch");
  const entities = (Array.isArray(sk?.entities) ? sk.entities : []) as Raw[];
  return entities.flatMap((e) => (e.type === "point" && Array.isArray(e.at) && e.at.every((x) => typeof x === "number") ? [[String(e.id), e.at as Vec2] as [string, Vec2]] : []));
}

/** The places the pattern uses, as numbers: its table, or its sketch's points. */
export function placesOf(f: Raw, before: Raw[]): Vec2[] {
  if (Array.isArray(f.positions)) return (f.positions as unknown[]).filter((p): p is Vec2 => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "number"));
  return sketchPointList(before, f.sketch).map(([, at]) => at);
}

/** Where the seed sits: its `from`, else the first place. */
function fromOf(f: Raw, places: Vec2[]): Vec2 | undefined {
  return Array.isArray(f.from) && f.from.every((x) => typeof x === "number") ? (f.from as Vec2) : places[0];
}

const same = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9;

/** The seed's place: the first point (the default), or another point of the sketch, or a table position. */
function SeedAt(p: FieldProps) {
  const places = placesOf(p.resolved, p.before);
  const from = fromOf(p.resolved, places);
  const named: [string, Vec2][] = Array.isArray(p.resolved.positions) ? places.map((at, i) => [`position ${i + 1}`, at]) : sketchPointList(p.before, p.resolved.sketch);
  const k = Array.isArray(p.f.from) ? named.findIndex(([, at]) => from !== undefined && same(at, from)) : 0;
  const value = k <= 0 ? "" : String(k);
  const options: [string, string][] = [["", named.length ? `the first (${named[0][0]})` : "the first point"], ...named.slice(1).map(([id, at], i): [string, string] => [String(i + 1), `${id} at [${at.join(", ")}]`])];
  return (
    <Field label="The seed is at" hint="Where the original sits: it gets no copy; every other place does">
      <Select value={value} options={options} onChange={(v) => p.update({ from: v === "" ? null : named[Number(v)][1] })} testId="prop-sketch-pattern-from" />
    </Field>
  );
}

/** The places: the sketch's points, or a table of [x, y] in its plane (edited row by row). */
function Places(p: FieldProps) {
  const table = Array.isArray(p.f.positions) ? (p.f.positions as NumberValue[][]) : null;
  const points = sketchPointList(p.before, p.resolved.sketch);
  // Fewer places: the skips past the new last instance go (the pattern stays valid).
  const set = (rows: NumberValue[][]) => {
    const places = rows.map((r) => r.map((x) => (typeof x === "number" ? x : NaN)) as Vec2);
    p.update({ positions: rows, ...keptSkips(p.f, copyPlaces(places, fromOf(p.resolved, places)).length) });
  };
  return (
    <>
      <Field label="Places">
        <Select
          value={table ? "table" : "points"}
          options={[
            ["points", `The sketch's points (${points.length})`],
            ["table", "A table of positions"],
          ]}
          // A new table starts from the sketch's points as they are, so nothing moves.
          onChange={(v) => p.update(v === "table" ? { positions: points.length ? points.map(([, at]) => at) : [[0, 0], [10, 0]] } : { positions: null, from: null, ...keptSkips(p.f, copyPlaces(points.map(([, at]) => at), undefined).length) })}
          testId="prop-sketch-pattern-places"
        />
      </Field>
      {table && (
        <Field label="Positions" block hint="[x, y] in the sketch's plane, mm">
          <span className="readout hole-centres" data-testid="prop-sketch-pattern-positions">
            {table.map((row, i) => (
              <span key={i} className="selector-line">
                <span className="set-text">{i + 1}.</span>
                <NumberInput value={row[0]} onCommit={(v) => set(table.map((r, k) => (k === i ? [v, r[1]] : r)))} testId={`prop-position-x-${i}`} ariaLabel={`Position ${i + 1} x`} />
                <NumberInput value={row[1]} onCommit={(v) => set(table.map((r, k) => (k === i ? [r[0], v] : r)))} testId={`prop-position-y-${i}`} ariaLabel={`Position ${i + 1} y`} />
                <button type="button" className="selector-remove" aria-label={`Remove position ${i + 1}`} disabled={table.length <= 2} onClick={() => set(table.filter((_, k) => k !== i))} data-testid={`prop-position-remove-${i}`}>
                  ×
                </button>
              </span>
            ))}
          </span>
        </Field>
      )}
      {table && (
        <button type="button" onClick={() => set([...table, nextPlace(table)])} data-testid="prop-position-add">
          Add a position
        </button>
      )}
    </>
  );
}

/**
 * The `skip` patch for a pattern that now makes `copies` copies (instances 2 ... copies + 1):
 * the skips that still exist, or none when they would leave no copy. Empty when nothing changes.
 */
export function keptSkips(f: Raw, copies: number): Raw {
  if (!Array.isArray(f.skip)) return {};
  const kept = (f.skip as unknown[]).filter((n): n is number => typeof n === "number" && n >= 2 && n <= copies + 1);
  if (kept.length === f.skip.length && kept.length < copies) return {};
  return { skip: kept.length && kept.length < copies ? kept : null };
}

/** A new table row: one step on from the last, by the step between the last two. */
function nextPlace(table: NumberValue[][]): NumberValue[] {
  const nums = table.map((r) => r.map((x) => (typeof x === "number" ? x : 0)));
  const last = nums[nums.length - 1] ?? [0, 0];
  const before = nums[nums.length - 2] ?? [last[0] - 10, last[1]];
  return [last[0] + (last[0] - before[0]), last[1] + (last[1] - before[1])];
}

function Skips(p: FieldProps) {
  const places = placesOf(p.resolved, p.before);
  const copies = copyPlaces(places, fromOf(p.resolved, places));
  return <InstanceChecks p={p} rows={placeRows(copies, p.f.skip)} testId="prop-pattern-skip" />;
}

export const SKETCH_PATTERN_FIELDS: FieldSpec[] = [
  seedsField("prop-pattern-features"),
  { kind: "sketch", key: "sketch", label: "Sketch", testId: "prop-sketch-pattern-sketch", hint: "Its points are where the copies go, moved in its plane", set: (id) => ({ sketch: id, from: null, skip: null }) },
  { kind: "custom", key: "positions", label: "Places", render: (p) => <Places {...p} /> },
  { kind: "custom", key: "from", label: "The seed is at", render: (p) => <SeedAt {...p} /> },
  { kind: "custom", key: "skip", label: "Instances", render: (p) => <Skips {...p} /> },
];

export const ui: UiOp = {
  op: "sketchPattern",
  label: "Sketch-driven pattern",
  icon: "sketchPattern",
  fields: SKETCH_PATTERN_FIELDS,
  summary: (f) => {
    const seeds = seedsOf(f).length;
    const table = Array.isArray(f.positions) ? `${f.positions.length} positions` : typeof f.sketch === "string" ? `at ${f.sketch}` : null;
    return [table, ...(seeds > 1 ? [`${seeds} features`] : [])].filter(Boolean).join(" ") || null;
  },
  sketchOf: (f) => (typeof f.sketch === "string" ? f.sketch : null),
};

// Table pattern's properties: the features it copies, the plane or coordinate
// system the table is in, the table (edited row by row, or pasted as CSV from
// a spreadsheet), which row the seed is at, and which instances it makes.

import { useState } from "react";
import { Field, NumberInput, Select, type NumberValue } from "../../ui/fields";
import type { FieldProps, FieldSpec } from "../../ui/props/spec";
import { InstanceChecks, seedsField } from "../linearPattern/fields";
import { placeRows, seedsOf } from "../linearPattern/instances";
import { copyPlaces } from "../sketchPattern/doc";
import { keptSkips } from "../sketchPattern/ui";
import type { UiOp } from "../uiDefs";
import { parseTable, tableText } from "./doc";

type Raw = Record<string, unknown>;
type Vec2 = [number, number];

const numbersOf = (f: Raw): Vec2[] => (Array.isArray(f.positions) ? (f.positions as unknown[]).filter((p): p is Vec2 => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "number")) : []);
const fromOf = (f: Raw, places: Vec2[]): Vec2 | undefined => (Array.isArray(f.from) && f.from.every((x) => typeof x === "number") ? (f.from as Vec2) : places[0]);

/** The table: a row per position, and a box to paste CSV into (it replaces the table). */
function Table(p: FieldProps) {
  const rows = (Array.isArray(p.f.positions) ? p.f.positions : []) as NumberValue[][];
  const [paste, setPaste] = useState<string | null>(null);
  const set = (next: NumberValue[][]) => {
    const places = next.map((r) => (r.every((x) => typeof x === "number") ? (r as Vec2) : ([NaN, NaN] as Vec2)));
    p.update({ positions: next, ...keptSkips(p.f, copyPlaces(places, fromOf(p.resolved, places)).length) });
  };
  const take = () => {
    const got = parseTable(paste ?? "");
    if (typeof got === "string") return p.setError(`The table: ${got}.`);
    p.setError(null);
    setPaste(null);
    set(got);
  };
  return (
    <>
      <Field label="Positions" block hint="[x, y] along the plane's axes, mm. The seed is at the first unless you say otherwise">
        <span className="readout hole-centres" data-testid="prop-table-positions">
          {rows.map((row, i) => (
            <span key={i} className="selector-line">
              <span className="set-text">{i + 1}.</span>
              <NumberInput value={row[0]} onCommit={(v) => set(rows.map((r, k) => (k === i ? [v, r[1]] : r)))} testId={`prop-table-x-${i}`} ariaLabel={`Position ${i + 1} x`} />
              <NumberInput value={row[1]} onCommit={(v) => set(rows.map((r, k) => (k === i ? [r[0], v] : r)))} testId={`prop-table-y-${i}`} ariaLabel={`Position ${i + 1} y`} />
              <button type="button" className="selector-remove" aria-label={`Remove position ${i + 1}`} disabled={rows.length <= 2} onClick={() => set(rows.filter((_, k) => k !== i))} data-testid={`prop-table-remove-${i}`}>
                ×
              </button>
            </span>
          ))}
        </span>
      </Field>
      <span className="inline-buttons">
        <button type="button" onClick={() => set([...rows, nextRow(rows)])} data-testid="prop-table-add">
          Add a position
        </button>
        <button type="button" onClick={() => setPaste(paste === null ? tableText(rows) : null)} data-testid="prop-table-paste-toggle">
          {paste === null ? "Paste a table…" : "Close the table text"}
        </button>
      </span>
      {paste !== null && (
        <Field label="Table text" block hint='One "x, y" per line (from a spreadsheet: comma, tab or space between); a header line is skipped'>
          <textarea className="table-paste" rows={6} value={paste} onChange={(e) => setPaste(e.target.value)} data-testid="prop-table-paste" spellCheck={false} />
          <button type="button" onClick={take} data-testid="prop-table-paste-use">
            Use this table
          </button>
        </Field>
      )}
    </>
  );
}

/** The next row: one step on from the last, by the step between the last two. */
function nextRow(rows: NumberValue[][]): NumberValue[] {
  const nums = rows.map((r) => r.map((x) => (typeof x === "number" ? x : 0)));
  const last = nums[nums.length - 1] ?? [0, 0];
  const before = nums[nums.length - 2] ?? [last[0] - 10, last[1]];
  return [last[0] + (last[0] - before[0]), last[1] + (last[1] - before[1])];
}

function SeedAt(p: FieldProps) {
  const places = numbersOf(p.resolved);
  const from = fromOf(p.resolved, places);
  const k = Array.isArray(p.f.from) ? places.findIndex((q) => from && Math.hypot(q[0] - from[0], q[1] - from[1]) < 1e-9) : 0;
  return (
    <Field label="The seed is at" hint="The row the original sits at: it gets no copy; every other row does">
      <Select
        value={k <= 0 ? "" : String(k)}
        options={places.map((q, i): [string, string] => [i === 0 ? "" : String(i), `row ${i + 1} [${q.join(", ")}]`])}
        onChange={(v) => {
          const at = v === "" ? null : places[Number(v)];
          const next = at ?? places[0];
          p.update({ from: at, ...keptSkips(p.f, copyPlaces(places, next).length) });
        }}
        testId="prop-table-from"
      />
    </Field>
  );
}

function Skips(p: FieldProps) {
  const places = numbersOf(p.resolved);
  return <InstanceChecks p={p} rows={placeRows(copyPlaces(places, fromOf(p.resolved, places)), p.f.skip)} testId="prop-pattern-skip" />;
}

export const TABLE_PATTERN_FIELDS: FieldSpec[] = [
  seedsField("prop-pattern-features"),
  {
    kind: "datumRef",
    key: "system",
    label: "In",
    accepts: ["plane"],
    optional: true,
    testId: "prop-table-system",
    hint: "A coordinate system (its XY plane), a plane or a flat face: x and y run along its axes. None: Top",
    prompt: "Pick the coordinate system or plane the table is in",
  },
  { kind: "custom", key: "positions", label: "Positions", render: (p) => <Table {...p} /> },
  { kind: "custom", key: "from", label: "The seed is at", render: (p) => <SeedAt {...p} /> },
  { kind: "custom", key: "skip", label: "Instances", render: (p) => <Skips {...p} /> },
];

export const ui: UiOp = {
  op: "tablePattern",
  label: "Table-driven pattern",
  icon: "tablePattern",
  fields: TABLE_PATTERN_FIELDS,
  summary: (f) => {
    const n = Array.isArray(f.positions) ? f.positions.length : 0;
    const seeds = seedsOf(f).length;
    return [`${n} positions`, ...(seeds > 1 ? [`${seeds} features`] : [])].join(" ");
  },
};

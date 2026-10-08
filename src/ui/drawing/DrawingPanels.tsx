// The drawing's panels (Phase L): on the left, the views and what is in each,
// with forms to add a view, a dimension, a balloon or a note; on the right,
// the drawing checks, the selected view or annotation, and the sheet with its
// title block. Every edit is one command through the document, so undo,
// scope and validation work as they do for features.

import { useEffect, useState } from "react";
import type { Command, RawDocument } from "../../doc/commands";
import { STANDARD_SCALES } from "../../doc/drawing";
import {
  DIMENSION_DIRECTIONS,
  OUTLINE_SIDES,
  SHEET_SIZES,
  VIEW_LOOKS,
  type Annotation,
  type Drawing,
  type DrawingView,
  type ViewLook,
} from "../../doc/types";
import { validateDocument } from "../../doc/validate";
import type { ComposedSheet } from "../../drafting/compose";
import type { Check } from "../../intent/critic";
import type { SheetTarget } from "./SheetView";
import { Icon, type IconName } from "../icons";

type Dispatch = (cmd: Command) => string | null;

/** The next free id with this prefix: views and annotations share their ids. */
export function nextDrawingId(d: Drawing, prefix: string): string {
  const used = new Set([...d.views.map((v) => v.id), ...d.annotations.map((a) => a.id)]);
  let n = 1;
  for (const id of used) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(id);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** What a dimension can run between, in this part. */
export function pointChoices(doc: RawDocument): { value: string; label: string }[] {
  const v = validateDocument(doc);
  const members = v.features.flatMap((f) => (f.feature?.op === "member" && !f.feature.suppressed ? [f.feature.id] : []));
  const holes = v.features.flatMap((f) => (f.feature?.op === "hole" && !f.feature.suppressed ? [f.feature.id] : []));
  return [
    ...OUTLINE_SIDES.map((s) => ({ value: s, label: `${s.slice(1)} of the view` })),
    ...Object.keys(v.nodes).map((n) => ({ value: n, label: `node ${n}` })),
    ...members.flatMap((m) => [
      { value: `${m}.start`, label: `${m} start` },
      { value: `${m}.end`, label: `${m} end` },
    ]),
    ...holes.map((h) => ({ value: h, label: `hole ${h}` })),
  ];
}

function memberIds(doc: RawDocument): string[] {
  return validateDocument(doc).features.flatMap((f) => (f.feature?.op === "member" && !f.feature.suppressed ? [f.feature.id] : []));
}

/** Each kind of annotation's picture in the list. */
const ANNOTATION_ICON: Record<Annotation["type"], IconName> = {
  dimension: "dimension",
  hole: "hole",
  balloon: "balloon",
  weld: "joint",
  table: "grid",
  note: "note",
};

const lookName = (l: ViewLook) => (l === "iso" ? "iso" : `from the ${l}`);

// ---------------------------------------------------------------- left

export function DrawingTree({
  doc,
  drawing,
  sheet,
  selected,
  dispatch,
  onError,
  onSelect,
  onAsk,
}: {
  doc: RawDocument;
  drawing: Drawing;
  sheet: ComposedSheet | null;
  selected: string | null;
  dispatch: Dispatch;
  onError(text: string): void;
  onSelect(t: SheetTarget | null): void;
  onAsk(t: SheetTarget, x: number, y: number): void;
}) {
  const [look, setLook] = useState<ViewLook>("left");
  const said = (id: string) => sheet?.annotations.find((a) => a.id === id);
  const run = (cmd: Command) => {
    const problem = dispatch(cmd);
    if (problem) onError(problem);
    return problem;
  };
  const row = (t: SheetTarget, icon: IconName, label: string, detail: string, problem?: string, nested = false) => (
    <li
      key={t.id}
      className={`drawing-row${selected === t.id ? " selected" : ""}${problem ? " failed" : ""}${nested ? " nested" : ""}`}
      onClick={() => onSelect(t)}
      onContextMenu={(e) => {
        e.preventDefault();
        onAsk(t, e.clientX, e.clientY);
      }}
      data-testid={`drawing-item-${t.id}`}
      title={problem}
    >
      <Icon name={problem ? "alert" : icon} size={14} className="drawing-icon" />
      <span className="drawing-id">{label}</span>
      <span className="muted">{problem ?? detail}</span>
    </li>
  );
  const loose = drawing.annotations.filter((a) => !("view" in a));
  return (
    <section className="panel drawing-tree" data-testid="drawing-tree">
      <h2>Views</h2>
      <ul className="drawing-list">
        {drawing.views.map((v) => {
          const cv = sheet?.views.find((x) => x.id === v.id);
          return [
            row({ kind: "view", id: v.id }, "view", v.id, `${lookName(v.look)}${cv ? `, ${cv.scaleText}` : ""}${v.at ? ", placed" : ""}`),
            ...drawing.annotations
              .filter((a) => "view" in a && a.view === v.id)
              .map((a) => row({ kind: "annotation", id: a.id }, ANNOTATION_ICON[a.type], a.id, `${a.type} ${said(a.id)?.text ?? ""}`.trim(), said(a.id)?.problem, true)),
          ];
        })}
        {loose.map((a) => row({ kind: "annotation", id: a.id }, ANNOTATION_ICON[a.type], a.id, `${a.type} ${said(a.id)?.text ?? ""}`.trim()))}
      </ul>
      <div className="drawing-form">
        <h2>Add a view</h2>
        <label className="field">
          <span className="field-label">Looking</span>
          <select value={look} onChange={(e) => setLook(e.target.value as ViewLook)} aria-label="New view looks from" data-testid="drawing-new-look">
            {VIEW_LOOKS.map((l) => (
              <option key={l} value={l}>
                {lookName(l)}
              </option>
            ))}
          </select>
        </label>
        <div className="form-actions">
          <button
            onClick={() => {
              const id = drawing.views.some((v) => v.id === look) ? nextDrawingId(drawing, `${look}_`) : look;
              if (!run({ type: "setView", id, view: { look } })) onSelect({ kind: "view", id });
            }}
            data-testid="drawing-add-view"
          >
            <Icon name="plus" size={14} />
            Add view
          </button>
        </div>
      </div>
      <AddAnnotation doc={doc} drawing={drawing} selectedView={drawing.views.find((v) => v.id === selected)?.id ?? (drawing.annotations.find((a) => a.id === selected && "view" in a) as { view?: string } | undefined)?.view} run={run} onSelect={onSelect} />
    </section>
  );
}

function AddAnnotation({
  doc,
  drawing,
  selectedView,
  run,
  onSelect,
}: {
  doc: RawDocument;
  drawing: Drawing;
  selectedView: string | undefined;
  run(cmd: Command): string | null;
  onSelect(t: SheetTarget): void;
}) {
  const [kind, setKind] = useState<"between" | "member" | "balloon" | "note">("between");
  const [view, setView] = useState(selectedView ?? drawing.views[0]?.id ?? "");
  const points = pointChoices(doc);
  const members = memberIds(doc);
  const [from, setFrom] = useState("@left");
  const [to, setTo] = useState("@right");
  const [member, setMember] = useState(members[0] ?? "");
  const [text, setText] = useState("");
  useEffect(() => {
    if (selectedView) setView(selectedView);
  }, [selectedView]);
  const add = () => {
    let a: Record<string, unknown>;
    let prefix = "d";
    if (kind === "between") a = { type: "dimension", view, from, to };
    else if (kind === "member") a = { type: "dimension", view, member };
    else if (kind === "balloon") {
      a = { type: "balloon", view, member };
      prefix = "b";
    } else {
      if (!text.trim()) return;
      a = { type: "note", text: text.trim(), at: [30, 30] };
      prefix = "n";
    }
    const id = nextDrawingId(drawing, prefix);
    if (!run({ type: "setAnnotation", id, annotation: a })) {
      onSelect({ kind: "annotation", id });
      setText("");
    }
  };
  return (
    <div className="drawing-form" data-testid="drawing-add">
      <h2>Add an annotation</h2>
      <label className="field">
        <span className="field-label">What</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="What to add" data-testid="drawing-add-kind">
          <option value="between">Dimension, two points</option>
          <option value="member">Member length</option>
          <option value="balloon">Balloon</option>
          <option value="note">Note</option>
        </select>
      </label>
      {kind !== "note" && (
        <label className="field">
          <span className="field-label">In view</span>
          <select value={view} onChange={(e) => setView(e.target.value)} aria-label="In view" data-testid="drawing-add-view-id">
            {drawing.views.map((v) => (
              <option key={v.id} value={v.id}>
                {v.id}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind === "between" && (
        <>
          <label className="field">
            <span className="field-label">From</span>
            <PointSelect value={from} points={points} onChange={setFrom} testId="drawing-add-from" />
          </label>
          <label className="field">
            <span className="field-label">To</span>
            <PointSelect value={to} points={points} onChange={setTo} testId="drawing-add-to" />
          </label>
        </>
      )}
      {(kind === "member" || kind === "balloon") && (
        <label className="field">
          <span className="field-label">Member</span>
          <select value={member} onChange={(e) => setMember(e.target.value)} aria-label="Member" data-testid="drawing-add-member">
            {members.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind === "note" && (
        <label className="field">
          <span className="field-label">Text</span>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Note text" aria-label="Note text" data-testid="drawing-add-text" />
        </label>
      )}
      <div className="form-actions">
        <button onClick={add} data-testid="drawing-add-go">
          <Icon name={kind === "balloon" ? "balloon" : kind === "note" ? "note" : "dimension"} size={14} />
          Add {kind === "between" || kind === "member" ? "dimension" : kind}
        </button>
      </div>
    </div>
  );
}

function PointSelect({ value, points, onChange, testId }: { value: string; points: { value: string; label: string }[]; onChange(v: string): void; testId: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
      {!points.some((p) => p.value === value) && <option value={value}>{value}</option>}
      {points.map((p) => (
        <option key={p.value} value={p.value}>
          {p.label}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------- right

export function DrawingSide({
  doc,
  drawing,
  sheet,
  checks,
  selected,
  dispatch,
  onError,
  onSelect,
}: {
  doc: RawDocument;
  drawing: Drawing;
  sheet: ComposedSheet | null;
  checks: Check[];
  selected: string | null;
  dispatch: Dispatch;
  onError(text: string): void;
  onSelect(t: SheetTarget | null): void;
}) {
  const run = (cmd: Command) => {
    const problem = dispatch(cmd);
    if (problem) onError(problem);
    return problem;
  };
  const view = drawing.views.find((v) => v.id === selected);
  const annotation = drawing.annotations.find((a) => a.id === selected);
  return (
    <div className="panel drawing-side">
      <h2>Checks</h2>
      <ul className="checks" data-testid="drawing-checks">
        {checks.map((c) => (
          <li key={c.label} className={c.ok ? "ok" : "bad"} title={`Expected: ${c.expected}`}>
            <span className="check-mark">{c.ok ? "✓" : "✗"}</span> {c.label}
            <span className="muted">: {c.actual}</span>
          </li>
        ))}
      </ul>
      {view && <ViewProps view={view} sheet={sheet} run={run} onSelect={onSelect} />}
      {annotation && <AnnotationProps doc={doc} drawing={drawing} a={annotation} sheet={sheet} run={run} onSelect={onSelect} />}
      <SheetProps drawing={drawing} sheet={sheet} run={run} />
    </div>
  );
}

function ViewProps({ view, sheet, run, onSelect }: { view: DrawingView; sheet: ComposedSheet | null; run(c: Command): string | null; onSelect(t: SheetTarget | null): void }) {
  const set = (patch: Partial<DrawingView>) => {
    const next: Record<string, unknown> = { ...view, ...patch };
    for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
    delete next.id;
    run({ type: "setView", id: view.id, view: next });
  };
  const cv = sheet?.views.find((v) => v.id === view.id);
  return (
    <div data-testid="drawing-props">
      <h2>
        View <span className="muted">{view.id}</span>
      </h2>
      <label className="field">
        <span className="field-label">Looks</span>
        <select value={view.look} onChange={(e) => set({ look: e.target.value as ViewLook })} data-testid="prop-view-look">
          {VIEW_LOOKS.map((l) => (
            <option key={l} value={l}>
              {lookName(l)}
            </option>
          ))}
        </select>
      </label>
      <ScaleField value={view.scale} auto={`the sheet's (${cv?.scaleText ?? "auto"})`} onChange={(scale) => set({ scale })} testId="prop-view-scale" />
      <label className="field">
        <span className="field-label">Hidden edges</span>
        <input type="checkbox" checked={!!view.hidden} onChange={(e) => set({ hidden: e.target.checked || undefined })} data-testid="prop-view-hidden" />
      </label>
      <div className="drawing-buttons">
        {view.at && (
          <button onClick={() => set({ at: undefined })} data-testid="prop-view-auto">
            Place with the others
          </button>
        )}
        <button
          className="danger"
          onClick={() => {
            if (!run({ type: "setView", id: view.id, view: null })) onSelect(null);
          }}
          data-testid="prop-view-delete"
        >
          Delete view
        </button>
      </div>
    </div>
  );
}

function AnnotationProps({
  doc,
  drawing,
  a,
  sheet,
  run,
  onSelect,
}: {
  doc: RawDocument;
  drawing: Drawing;
  a: Annotation;
  sheet: ComposedSheet | null;
  run(c: Command): string | null;
  onSelect(t: SheetTarget | null): void;
}) {
  const set = (patch: Record<string, unknown>) => {
    const next: Record<string, unknown> = { ...a, ...patch };
    for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
    delete next.id;
    run({ type: "setAnnotation", id: a.id, annotation: next });
  };
  const said = sheet?.annotations.find((x) => x.id === a.id);
  const points = pointChoices(doc);
  const members = memberIds(doc);
  return (
    <div data-testid="drawing-props">
      <h2>
        {a.type} <span className="muted">{a.id}</span>
      </h2>
      <p className={said?.problem ? "bad" : "muted"} data-testid="prop-annotation-says">
        {said?.problem ? `⚠ ${said.problem}` : said?.text ? `Reads: ${said.text}` : ""}
      </p>
      {"view" in a && (
        <label className="field">
          <span className="field-label">View</span>
          <select value={a.view} onChange={(e) => set({ view: e.target.value })} data-testid="prop-annotation-view">
            {drawing.views.map((v) => (
              <option key={v.id} value={v.id}>
                {v.id}
              </option>
            ))}
          </select>
        </label>
      )}
      {a.type === "dimension" && a.member === undefined && (
        <>
          <label className="field">
            <span className="field-label">From</span>
            <PointSelect value={a.from ?? ""} points={points} onChange={(from) => set({ from })} testId="prop-dim-from" />
          </label>
          <label className="field">
            <span className="field-label">To</span>
            <PointSelect value={a.to ?? ""} points={points} onChange={(to) => set({ to })} testId="prop-dim-to" />
          </label>
          <label className="field">
            <span className="field-label">Direction</span>
            <select value={a.direction ?? ""} onChange={(e) => set({ direction: e.target.value || undefined })} data-testid="prop-dim-direction">
              <option value="">automatic</option>
              {DIMENSION_DIRECTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {(a.type === "balloon" || (a.type === "dimension" && a.member !== undefined)) && (
        <label className="field">
          <span className="field-label">Member</span>
          <select value={a.member} onChange={(e) => set({ member: e.target.value })} data-testid="prop-annotation-member">
            {/* A copy of a member (leg_a_mirror) or a renamed body is named by its body: it is a choice too. */}
            {(a.member === undefined || members.includes(a.member) ? members : [...members, a.member]).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      )}
      {a.type === "dimension" && (
        <label className="field">
          <span className="field-label">Offset</span>
          <input
            type="text"
            defaultValue={a.offset ?? ""}
            key={String(a.offset)}
            placeholder="automatic"
            onBlur={(e) => {
              const v = e.target.value.trim();
              const n = Number(v);
              if (v === "") set({ offset: undefined });
              else if (Number.isFinite(n)) set({ offset: n });
            }}
            data-testid="prop-dim-offset"
          />
        </label>
      )}
      {a.type === "note" && (
        <textarea defaultValue={a.text} key={a.text} rows={3} onBlur={(e) => e.target.value.trim() && e.target.value !== a.text && set({ text: e.target.value })} data-testid="prop-note-text" />
      )}
      <div className="drawing-buttons">
        {"at" in a && a.at && a.type !== "note" && (
          <button onClick={() => set({ at: undefined })} data-testid="prop-annotation-auto">
            Place automatically
          </button>
        )}
        <button
          className="danger"
          onClick={() => {
            if (!run({ type: "setAnnotation", id: a.id, annotation: null })) onSelect(null);
          }}
          data-testid="prop-annotation-delete"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function ScaleField({ value, auto, onChange, testId }: { value: string | undefined; auto: string; onChange(v: string | undefined): void; testId: string }) {
  return (
    <label className="field">
      <span className="field-label">Scale</span>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} data-testid={testId}>
        <option value="">{auto}</option>
        {STANDARD_SCALES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
        {value && !STANDARD_SCALES.includes(value) && <option value={value}>{value}</option>}
      </select>
    </label>
  );
}

function SheetProps({ drawing, sheet, run }: { drawing: Drawing; sheet: ComposedSheet | null; run(c: Command): string | null }) {
  const s = drawing.sheet;
  const set = (patch: Record<string, unknown>) => run({ type: "setSheet", patch });
  const text = (key: "title" | "number" | "revision" | "drawnBy" | "date", label: string) => (
    <label className="field" key={key}>
      <span className="field-label">{label}</span>
      <input
        type="text"
        defaultValue={s[key] ?? ""}
        key={s[key] ?? ""}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v !== (s[key] ?? "")) set({ [key]: v || null });
        }}
        data-testid={`sheet-${key}`}
      />
    </label>
  );
  return (
    <div data-testid="sheet-props">
      <h2>Sheet</h2>
      <label className="field">
        <span className="field-label">Size</span>
        <select value={s.size} onChange={(e) => set({ size: e.target.value })} data-testid="sheet-size">
          {Object.keys(SHEET_SIZES).map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      <ScaleField value={s.scale} auto={`what fits (${sheet?.scaleText ?? "…"})`} onChange={(scale) => set({ scale: scale ?? null })} testId="sheet-scale" />
      <label className="field">
        <span className="field-label">Projection</span>
        <select value={s.projection} onChange={(e) => set({ projection: e.target.value })} data-testid="sheet-projection">
          <option value="third">third angle</option>
          <option value="first">first angle</option>
        </select>
      </label>
      {text("title", "Title")}
      {text("number", "Drawing no.")}
      {text("revision", "Revision")}
      {text("drawnBy", "Drawn by")}
      {text("date", "Date")}
    </div>
  );
}

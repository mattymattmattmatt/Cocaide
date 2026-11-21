// The Member command: one place to put members in a part. A size (the
// part's sections, the recent ones, the library), what they run along
// (sketch lines picked in the view, or a path of nodes), where the section
// sits on its line (outside the frame, centred, or any of the nine points,
// turned), and how their corners are joined. Every change shows in the view
// (the members are built as they will be); OK keeps them as one undo step,
// Cancel takes them away. The pin keeps it open for the next group.

import { useEffect, useMemo, useRef, useState } from "react";
import type { SketchLine } from "../../weldment/sketchFrame";
import { AlignGrid } from "../FrameProps";
import { NumberInput } from "../fields";
import { Icon } from "../icons";
import type { SizeChoice } from "../NodesPanel";

export type MemberPlacement = "outside" | "centre" | "custom";
export type MemberCorners = "mitre" | "butt" | "none";
export type MemberRunThrough = "posts" | "rails" | "longer";

export interface MemberCommandState {
  /** "part|<profile>|<size>" or "lib|<library id>|<size>" (a SizeChoice's value). */
  size: string;
  source: "lines" | "nodes" | "points";
  lines: SketchLine[];
  /** Node names; a comma starts another path: "A B C D A, A E". */
  path: string;
  /** points: one member between two points (absent: 1000 mm along X, beside the members already there). */
  from?: number[];
  to?: number[];
  placement: MemberPlacement;
  /** custom: the point of the section on the line, as a member's align ([0, 0] the middle). */
  align?: [number, number];
  rotation: number;
  corners: MemberCorners;
  runThrough: MemberRunThrough;
}

/** What the preview made, for the panel to say. */
export interface MemberSummary {
  members: number;
  joints: number;
  /** mm of section, all the members together. */
  length: number;
  warnings: string[];
  /** Why nothing could be made from what is picked. */
  error?: string;
  /** Lines picked that already had a member (left out). */
  skipped: string[];
}

interface Props {
  state: MemberCommandState;
  onChange(patch: Partial<MemberCommandState>): void;
  sizes: SizeChoice[];
  /** Sizes used lately, newest first (SizeChoice values). */
  recent: string[];
  /** The library family a library size is of ("UB (AS/NZS 3679.1)"), to group them by. */
  familyOf(value: string): string | undefined;
  /** Each sketch's own lines, for "All of". */
  sketches: { sketch: string; lines: string[] }[];
  /** The part's nodes, for the path. */
  nodes: string[];
  /** How a picked line runs (for Keep: upright, level, sloped); undefined when not known yet. */
  lineKind?(l: SketchLine): "upright" | "level" | "sloped" | undefined;
  /** The profile's anchor ("centroid" or "origin"), for the grid's anchor button. */
  anchor: string;
  summary: MemberSummary | null;
  /** The preview is being built. */
  busy: boolean;
  pinned: boolean;
  onPin(on: boolean): void;
  onOk(): void;
  onCancel(): void;
  /** Opens the Sections tab (to find or make a size). */
  onBrowse(): void;
}

const ROTATIONS = [0, 90, 180, 270];

/** "12.45 m". */
const metres = (mm: number) => `${(Math.round(mm / 10) / 100).toFixed(2)} m`;

export function MemberCommand({ state, onChange, sizes, recent, familyOf, sketches, nodes, lineKind, anchor, summary, busy, pinned, onPin, onOk, onCancel, onBrowse }: Props) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(false);
  const [openSketches, setOpenSketches] = useState<string[]>([]);
  const box = useRef<HTMLDivElement | null>(null);
  // The size picker closes on a click elsewhere.
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [open]);
  const chosen = sizes.find((s) => s.value === state.size);
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const hit = (s: SizeChoice) => !q || s.label.toLowerCase().includes(q);
    const recentList = recent.map((v) => sizes.find((s) => s.value === v)).filter((s): s is SizeChoice => !!s && hit(s));
    // The library by family, in the library's order.
    const families = new Map<string, SizeChoice[]>();
    for (const s of sizes) {
      if (!s.value.startsWith("lib|") || !hit(s) || recentList.includes(s)) continue;
      const f = familyOf(s.value) ?? "Section library";
      families.set(f, [...(families.get(f) ?? []), s]);
    }
    return [
      { title: "Recent", items: recentList },
      { title: "In this part", items: sizes.filter((s) => s.value.startsWith("part|") && hit(s) && !recentList.includes(s)) },
      ...[...families].map(([title, items]) => ({ title, items })),
    ].filter((g) => g.items.length);
  }, [sizes, recent, filter, familyOf]);
  const picked = state.lines;
  const bySketch = new Map<string, string[]>();
  for (const p of picked) bySketch.set(p.sketch, [...(bySketch.get(p.sketch) ?? []), p.entity]);
  const ready = !!summary && summary.members > 0 && !summary.error;

  return (
    <div className="member-cmd" data-testid="member-cmd" onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLElement).tagName !== "INPUT" && ready && onOk()}>
      <div className="session-bar">
        <span className="session-title mc-title">
          <Icon name="member" size={15} /> Add members
        </span>
        <span className="session-actions">
          <button type="button" className={`session-pin${pinned ? " on" : ""}`} aria-pressed={pinned} onClick={() => onPin(!pinned)} title={pinned ? "Stays open for the next group after OK" : "Keep open after OK, for the next group"} data-testid="member-cmd-pin">
            <Icon name="pin" size={14} />
          </button>
          <button type="button" className="session-cancel" onClick={onCancel} data-testid="member-cmd-cancel" title="Take the members away (Esc)">
            <Icon name="x" size={13} /> Cancel
          </button>
          <button type="button" className="session-ok" onClick={onOk} disabled={!ready || busy} data-testid="member-cmd-ok" title="Keep them, as one undo step (Enter)">
            <Icon name="check" size={13} /> OK
          </button>
        </span>
      </div>

      {/* ---------------------------------------------------------------- size */}
      <section className="mc-section">
        <h3>Size</h3>
        <div className="mc-size" ref={box}>
          <button type="button" className="mc-size-button" onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid="member-cmd-size">
            <span className="mc-size-name">{chosen ? chosen.label.replace(/ \((in this part|library)\)$/, "") : sizes.length ? "Pick a size" : "No sections yet"}</span>
            <span className="muted small">{chosen ? (chosen.value.startsWith("lib|") ? "library" : "in this part") : ""}</span>
            <Icon name="chevron" size={12} />
          </button>
          {open && (
            <div className="mc-size-list" role="listbox" data-testid="member-cmd-size-list">
              <input autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a size: SHS 50, RHS, angle…" aria-label="Find a size" data-testid="member-cmd-size-filter" />
              <div className="mc-size-scroll">
                {groups.map((g) => (
                  <div key={g.title}>
                    <div className="mc-size-group">{g.title}</div>
                    {g.items.map((s) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={s.value === state.size}
                        key={s.value}
                        className={s.value === state.size ? "on" : ""}
                        onClick={() => {
                          onChange({ size: s.value });
                          setOpen(false);
                          setFilter("");
                        }}
                        data-testid={`member-cmd-size-${s.value}`}
                      >
                        {s.label.replace(/ \((in this part|library)\)$/, "")}
                      </button>
                    ))}
                  </div>
                ))}
                {!groups.length && <div className="muted small mc-empty">No size matches.</div>}
              </div>
              <button type="button" className="link-button small" onClick={onBrowse} data-testid="member-cmd-browse">
                Browse or make sections…
              </button>
            </div>
          )}
        </div>
      </section>

      {/* ---------------------------------------------------------------- path */}
      <section className="mc-section">
        <h3>Along</h3>
        <div className="seg" role="radiogroup" aria-label="What the members run along">
          {(
            [
              ["lines", "Sketch lines"],
              ["nodes", "Nodes"],
              ["points", "Two points"],
            ] as const
          ).map(([v, label]) => (
            <button type="button" key={v} role="radio" aria-checked={state.source === v} className={state.source === v ? "on" : ""} onClick={() => onChange({ source: v })} data-testid={`member-cmd-source-${v}`}>
              {label}
            </button>
          ))}
        </div>
        {state.source === "lines" ? (
          <>
            <div className={`mc-picked${picked.length ? "" : " empty"}`} data-testid="member-cmd-picked">
              {picked.length === 0 ? (
                <span className="muted">Click sketch lines in the view, or drag a box across them (right to left takes any it touches). Click one again to take it out.</span>
              ) : (
                [...bySketch].map(([sk, ids]) =>
                  // A long pick (every line of a wall) folds to one row per sketch; open it to take single lines out.
                  picked.length > 12 && !openSketches.includes(sk) ? (
                    <div key={sk} className="mc-chips mc-chips-folded" data-testid={`member-cmd-picked-${sk}`}>
                      <button type="button" className="mc-fold" aria-expanded={false} onClick={() => setOpenSketches([...openSketches, sk])} title="Show the lines">
                        <Icon name="chevron" size={11} />
                        <span className="mc-chip-sketch">{sk}</span>
                        <span className="muted">
                          {ids.length} {ids.length === 1 ? "line" : "lines"}
                        </span>
                      </button>
                      <button type="button" className="mc-fold-x" aria-label={`Take ${sk}'s lines out`} onClick={() => onChange({ lines: picked.filter((p) => p.sketch !== sk) })}>
                        <Icon name="x" size={10} />
                      </button>
                    </div>
                  ) : (
                  <div key={sk} className="mc-chips">
                    {picked.length > 12 && (
                      <button type="button" className="mc-fold" aria-expanded={true} onClick={() => setOpenSketches(openSketches.filter((x) => x !== sk))} title="Fold the lines">
                        <Icon name="down" size={11} />
                      </button>
                    )}
                    <span className="mc-chip-sketch">{sk}</span>
                    {ids.map((id) => (
                      <span key={id} className="mc-chip">
                        {id}
                        <button type="button" aria-label={`Take ${id} out`} onClick={() => onChange({ lines: picked.filter((p) => !(p.sketch === sk && p.entity === id)) })}>
                          <Icon name="x" size={10} />
                        </button>
                      </span>
                    ))}
                  </div>
                  ),
                )
              )}
            </div>
            <div className="mc-row">
              <select
                value=""
                onChange={(e) => {
                  const s = sketches.find((x) => x.sketch === e.target.value);
                  if (s) onChange({ lines: [...picked.filter((p) => p.sketch !== s.sketch), ...s.lines.map((entity) => ({ sketch: s.sketch, entity }))] });
                }}
                aria-label="Take all of a sketch's lines"
                data-testid="member-cmd-all"
                disabled={!sketches.length}
              >
                <option value="">{sketches.length ? "All lines of…" : "No sketches with lines"}</option>
                {sketches.map((s) => (
                  <option key={s.sketch} value={s.sketch}>
                    {s.sketch} ({s.lines.length})
                  </option>
                ))}
              </select>
              <button type="button" className="link-button small" disabled={!picked.length} onClick={() => onChange({ lines: [] })} data-testid="member-cmd-clear">
                Clear
              </button>
            </div>
            {picked.length > 1 && lineKind && (
              <div className="mc-row mc-keep">
                <span className="muted small">Keep only</span>
                <div className="seg small">
                  {(
                    [
                      ["upright", "Upright"],
                      ["level", "Level"],
                      ["sloped", "Sloped"],
                    ] as const
                  ).map(([k, label]) => {
                    const n = picked.filter((p) => lineKind(p) === k).length;
                    return (
                      <button type="button" key={k} disabled={!n || n === picked.length} onClick={() => onChange({ lines: picked.filter((p) => lineKind(p) === k) })} title={`Keep the ${n} ${label.toLowerCase()} line${n === 1 ? "" : "s"}, drop the rest`} data-testid={`member-cmd-keep-${k}`}>
                        {label} <span className="muted">{n}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        ) : state.source === "points" ? (
          <div className="mc-points">
            {(["from", "to"] as const).map((k) => {
              const v = state[k];
              return (
                <label key={k} className="mc-point">
                  <span className="muted small">{k === "from" ? "From" : "To"}</span>
                  <span className="vec">
                    {[0, 1, 2].map((i) => (
                      <NumberInput
                        key={i}
                        value={v ? v[i] : k === "to" && i === 0 ? 1000 : 0}
                        ariaLabel={`${k} ${"xyz"[i]}`}
                        testId={`member-cmd-${k}-${"xyz"[i]}`}
                        onCommit={(x) => {
                          const base = state[k] ?? (k === "to" ? [1000, 0, 0] : [0, 0, 0]);
                          const other = k === "from" ? (state.to ?? [1000, 0, 0]) : (state.from ?? [0, 0, 0]);
                          onChange({ [k]: base.map((c, j) => (j === i ? Number(x) : c)), [k === "from" ? "to" : "from"]: other });
                        }}
                      />
                    ))}
                  </span>
                </label>
              );
            })}
            <p className="muted small">{state.from || state.to ? `${Math.round(Math.hypot(...[0, 1, 2].map((i) => (state.to ?? [1000, 0, 0])[i] - (state.from ?? [0, 0, 0])[i])))} mm long. Its ends can go on nodes later, in its properties.` : "1000 mm along X, beside the members already there: change its ends here or in its properties after."}</p>
          </div>
        ) : (
          <>
            <input value={state.path} onChange={(e) => onChange({ path: e.target.value })} placeholder={nodes.length >= 2 ? `${nodes.slice(0, 4).join(" ")}${nodes.length > 4 ? " …" : ""}` : "A B C D A, A E"} aria-label="Path of nodes" data-testid="member-cmd-path" />
            <p className="muted small">{nodes.length ? `Nodes: ${nodes.slice(0, 12).join(", ")}${nodes.length > 12 ? "…" : ""}. A comma starts another path.` : "The part has no nodes yet: add them in Nodes, or draw a sketch."}</p>
          </>
        )}
      </section>

      {/* ---------------------------------------------------------------- placement */}
      <section className="mc-section">
        <h3>On the line</h3>
        <div className="seg" role="radiogroup" aria-label="Where the section sits on its line">
          {(
            [
              ["outside", "Outside of frame", "The lines are the frame's outside edges: each section sits on the side away from the middle"],
              ["centre", "Centred", "The profile's anchor on the line"],
              ["custom", "Custom", "Any of nine points of the section on the line, turned"],
            ] as const
          ).map(([v, label, title]) => (
            <button type="button" key={v} role="radio" aria-checked={state.placement === v} className={state.placement === v ? "on" : ""} onClick={() => onChange({ placement: v, ...(v === "custom" && !state.align ? { align: [0, 0] as [number, number] } : {}) })} title={title} data-testid={`member-cmd-place-${v}`}>
              {label}
            </button>
          ))}
        </div>
        {state.placement === "custom" && (
          <div className="mc-custom">
            <AlignGrid value={state.align} anchor={anchor} onChange={(a) => onChange({ align: a })} testId="member-cmd-align" />
            <div className="mc-rotation">
              <span className="muted small">Turned</span>
              <div className="seg small">
                {ROTATIONS.map((r) => (
                  <button type="button" key={r} className={state.rotation === r ? "on" : ""} aria-pressed={state.rotation === r} onClick={() => onChange({ rotation: r })} data-testid={`member-cmd-rot-${r}`}>
                    {r}°
                  </button>
                ))}
              </div>
            </div>
            <p className="muted small">Seen from each member's end: which point of the section its line runs through.</p>
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------------- corners */}
      <section className="mc-section">
        <h3>Corners</h3>
        <div className="seg" role="radiogroup" aria-label="How the corners are joined">
          {(
            [
              ["mitre", "Mitre"],
              ["butt", "Butt"],
              ["none", "None"],
            ] as const
          ).map(([v, label]) => (
            <button type="button" key={v} role="radio" aria-checked={state.corners === v} className={state.corners === v ? "on" : ""} onClick={() => onChange({ corners: v })} data-testid={`member-cmd-corners-${v}`}>
              <CornerGlyph kind={v} />
              {label}
            </button>
          ))}
        </div>
        {state.corners === "butt" && (
          <div className="mc-row">
            <span className="muted small">Runs through</span>
            <div className="seg small">
              {(
                [
                  ["posts", "Posts"],
                  ["rails", "Rails"],
                  ["longer", "Longer"],
                ] as const
              ).map(([v, label]) => (
                <button type="button" key={v} className={state.runThrough === v ? "on" : ""} aria-pressed={state.runThrough === v} onClick={() => onChange({ runThrough: v })} data-testid={`member-cmd-through-${v}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
        <p className="muted small">A member ending on another's side is butted to it. Click a corner in the view later to change it or its arrangement order.</p>
      </section>

      {/* ---------------------------------------------------------------- what it makes */}
      <div className={`mc-summary${summary?.error ? " bad" : summary?.warnings.length ? " warn" : ""}`} data-testid="member-cmd-summary" aria-live="polite">
        {busy ? (
          <span className="muted">Building…</span>
        ) : !summary ? (
          <span className="muted">{state.source === "lines" ? "Pick lines to see the members." : state.source === "nodes" ? "Type a path to see the members." : "…"}</span>
        ) : summary.error ? (
          <span>{summary.error}</span>
        ) : (
          <>
            <div className="mc-summary-line">
              <strong>
                {summary.members} member{summary.members === 1 ? "" : "s"}
              </strong>
              <span>
                {summary.joints} joint{summary.joints === 1 ? "" : "s"}
              </span>
              <span>{metres(summary.length)}</span>
            </div>
            {summary.skipped.length > 0 && <div className="muted small">Already on {summary.skipped.length === 1 ? `${summary.skipped[0]}: left out` : `${summary.skipped.length} of the lines: left out`}.</div>}
            {summary.warnings.map((w) => (
              <div key={w} className="mc-warning">
                <Icon name="warning" size={12} /> {w}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/** A small picture of a corner: mitred, butted, or two loose ends. */
export function CornerGlyph({ kind }: { kind: "mitre" | "butt" | "none" }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="corner-glyph">
      {kind === "mitre" && <path d="M2 14V5l3-3h9v4H6v8z M2 5l4 1" fill="currentColor" fillOpacity="0.18" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />}
      {kind === "butt" && <path d="M2 14V2h4v12z M6 2h8v4H6" fill="currentColor" fillOpacity="0.18" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />}
      {kind === "none" && <path d="M2 14V7h4v7z M8 2h6v4H8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 1.5" />}
    </svg>
  );
}

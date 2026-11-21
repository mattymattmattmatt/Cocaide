// Members from a layout sketch, the usual way to model a frame: draw the
// frame as a sketch, pick a size, pick its lines (in the view, or all of a
// sketch's at once), and each line becomes a member, the corners joined.
// The members follow the sketch: edit it and the frame moves with it.

import { useEffect, useState } from "react";
import type { FrameTemplate, TemplateSpec } from "../weldment/frameTemplates";
import type { RawDocument } from "../doc/commands";
import { ownLines, type SketchLine } from "../weldment/sketchFrame";
import type { SizeChoice } from "./NodesPanel";
import { Section } from "./Section";
import { Icon } from "./icons";

export interface SketchMembersRequest {
  size: string;
  lines: SketchLine[];
  line: "centre" | "outside";
  corners: "mitre" | "butt" | "none";
  runThrough: "longer" | "posts" | "rails";
}

interface Props {
  doc: RawDocument | null;
  sizes: SizeChoice[];
  /** The lines picked so far, or null when the view isn't picking lines. */
  picking: SketchLine[] | null;
  onPicking(lines: SketchLine[] | null): void;
  onCreate(req: SketchMembersRequest): boolean;
  /** A starter layout (parameters and its sketch): its sketch's id, or null when it couldn't be made. */
  onTemplate(spec: TemplateSpec): string | null;
  onError(text: string): void;
}


/** Each sketch's own lines (not construction), in the order they are listed. */
export function sketchLines(doc: RawDocument | null): { sketch: string; lines: string[] }[] {
  if (!doc) return [];
  return doc.features.flatMap((f) => {
    if ((f.op !== "sketch" && f.op !== "sketch3d") || f.suppressed === true) return [];
    const lines = ownLines(f);
    return lines.length ? [{ sketch: String(f.id), lines }] : [];
  });
}

/** A starter layout's form: which, and its sizes. */
function NewLayout({ onTemplate, onMade }: { onTemplate(spec: TemplateSpec): string | null; onMade(sketch: string): void }) {
  const [kind, setKind] = useState<FrameTemplate>("wall");
  const [n, setN] = useState({ width: 2000, height: 1200, depth: 600, posts: 1, rise: 400, bays: 2, bay: 1500 });
  const field = (key: keyof typeof n, label: string, step = 10) => (
    <label className="layout-field" key={key}>
      <span>{label}</span>
      <input type="number" min={key === "posts" ? 0 : 1} step={step} value={n[key]} onChange={(e) => setN({ ...n, [key]: Number(e.target.value) })} data-testid={`layout-${key}`} />
    </label>
  );
  return (
    <details className="new-layout" data-testid="new-layout">
      <summary>New layout…</summary>
      <div className="layout-form">
        <select value={kind} onChange={(e) => setKind(e.target.value as FrameTemplate)} aria-label="Layout" data-testid="layout-kind">
          <option value="wall">Wall or panel (rectangle with posts)</option>
          <option value="box">Box (table, stand)</option>
          <option value="portal">Pitched portal frame</option>
        </select>
        <div className="layout-fields">
          {field("width", "Width")}
          {field("height", kind === "portal" ? "To eaves" : "Height")}
          {kind === "box" && field("depth", "Depth")}
          {kind === "wall" && field("posts", "Posts between", 1)}
          {kind === "portal" && field("rise", "Ridge rise")}
          {kind === "portal" && field("bays", "Bays", 1)}
          {kind === "portal" && field("bay", "Bay")}
        </div>
        <button
          type="button"
          onClick={() => {
            const id = onTemplate({ kind, ...n });
            if (id) onMade(id);
          }}
          data-testid="layout-add"
          title="Adds parameters for its sizes (frame_w, frame_h, ...) and a layout sketch driven by them; its lines are picked, ready for a size"
        >
          <Icon name="plus" size={13} />
          Add layout
        </button>
      </div>
    </details>
  );
}

export function SketchMembersPanel({ doc, sizes, picking, onPicking, onCreate, onTemplate, onError }: Props) {
  const [size, setSize] = useState("");
  const [line, setLine] = useState<SketchMembersRequest["line"]>("outside");
  const [corners, setCorners] = useState<SketchMembersRequest["corners"]>("mitre");
  /** A layout just added, whose lines are picked once the document has it. */
  const [pending, setPending] = useState<string | null>(null);
  const fresh = pending ? sketchLines(doc).find((x) => x.sketch === pending) : undefined;
  useEffect(() => {
    if (!fresh) return;
    onPicking(fresh.lines.map((entity) => ({ sketch: fresh.sketch, entity })));
    setPending(null);
  }, [fresh]); // eslint-disable-line react-hooks/exhaustive-deps
  const [runThrough, setRunThrough] = useState<SketchMembersRequest["runThrough"]>("posts");
  const all = sketchLines(doc);
  if (!doc) return null;
  // A new layout: its lines picked, ready for a size.
  const made = (sketch: string) => {
    onPicking([]);
    setPending(sketch);
  };
  const chosen = sizes.some((s) => s.value === size) ? size : (sizes[0]?.value ?? "");
  const picked = picking ?? [];
  const create = () => {
    if (!chosen) return onError("Pick a section size first: save a profile to the section library, or put one in the part.");
    if (!picked.length) return onError("Pick the sketch lines the members run along: click them in the view, or take all of a sketch's.");
    if (onCreate({ size: chosen, lines: picked, line, corners, runThrough })) onPicking(null);
  };
  const bySketch = new Map<string, string[]>();
  for (const p of picked) bySketch.set(p.sketch, [...(bySketch.get(p.sketch) ?? []), p.entity]);

  return (
    <Section title="Members from sketch" className="nodes sketch-members" testId="sketch-members" count={picked.length} open autoOpen={picking !== null}>
      <p className="muted small">{all.length ? "Pick a size, then the sketch lines: a member on each, the corners joined. Edit the sketch and the frame follows." : "Draw the frame as a sketch (or start from a layout below), then put members on its lines."}</p>
      <NewLayout onTemplate={onTemplate} onMade={made} />
      {all.length > 0 && (
      <div className="path-tool first">
        <select value={chosen} onChange={(e) => setSize(e.target.value)} aria-label="Member size" data-testid="sketch-members-size">
          {sizes.length === 0 && <option value="">No sections yet</option>}
          {sizes.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <div className="path-options">
          <button
            type="button"
            className={picking ? "on" : ""}
            aria-pressed={picking !== null}
            onClick={() => onPicking(picking ? null : [])}
            title={picking ? "Stop picking lines" : "Click sketch lines in the view to add them (click again to take one out)"}
            data-testid="sketch-members-pick"
          >
            <Icon name={picking ? "check" : "plus"} size={13} />
            {picking ? "Picking lines…" : "Pick lines"}
          </button>
          <select
            value=""
            onChange={(e) => {
              const s = all.find((x) => x.sketch === e.target.value);
              if (!s) return;
              const keep = picked.filter((p) => p.sketch !== s.sketch);
              onPicking([...keep, ...s.lines.map((entity) => ({ sketch: s.sketch, entity }))]);
            }}
            aria-label="Take all of a sketch's lines"
            data-testid="sketch-members-all"
          >
            <option value="">All lines of…</option>
            {all.map((s) => (
              <option key={s.sketch} value={s.sketch}>
                {s.sketch} ({s.lines.length})
              </option>
            ))}
          </select>
        </div>
        <div className="sketch-members-picked" data-testid="sketch-members-picked">
          {picked.length === 0 ? (
            <span className="muted">{picking ? "Click lines in the view." : "No lines picked."}</span>
          ) : (
            <>
              <span>
                {picked.length} line{picked.length === 1 ? "" : "s"}:{" "}
                <span className="muted">{[...bySketch].map(([s, ids]) => `${ids.join(", ")} (${s})`).join("; ")}</span>
              </span>
              <button type="button" className="link-button small" onClick={() => onPicking(picking ? [] : null)} data-testid="sketch-members-clear">
                Clear
              </button>
            </>
          )}
        </div>
        <div className="path-options">
          <select value={line} onChange={(e) => setLine(e.target.value as SketchMembersRequest["line"])} aria-label="Where the lines run" data-testid="sketch-members-line">
            <option value="outside">Lines on the outside</option>
            <option value="centre">Lines on the centrelines</option>
          </select>
          <select value={corners} onChange={(e) => setCorners(e.target.value as SketchMembersRequest["corners"])} aria-label="Corners" data-testid="sketch-members-corners">
            <option value="mitre">Mitre corners</option>
            <option value="butt">Butt corners</option>
            <option value="none">No joints</option>
          </select>
        </div>
        {corners === "butt" && (
          <select value={runThrough} onChange={(e) => setRunThrough(e.target.value as SketchMembersRequest["runThrough"])} aria-label="Which member runs through at a corner" data-testid="sketch-members-through">
            <option value="posts">Posts run through</option>
            <option value="rails">Rails run through</option>
            <option value="longer">The longer runs through</option>
          </select>
        )}
        <button type="button" className="primary" disabled={!picked.length || !chosen} onClick={create} data-testid="sketch-members-add">
          {picked.length ? `Add ${picked.length} member${picked.length === 1 ? "" : "s"}` : "Add members"}
        </button>
      </div>
      )}
    </Section>
  );
}

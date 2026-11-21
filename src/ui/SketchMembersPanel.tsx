// Members from a layout sketch, the usual way to model a frame: draw the
// frame as a sketch, pick a size, pick its lines (in the view, or all of a
// sketch's at once), and each line becomes a member, the corners joined.
// The members follow the sketch: edit it and the frame moves with it.

import { useState } from "react";
import type { RawDocument } from "../doc/commands";
import type { SketchLine } from "../weldment/sketchFrame";
import type { SizeChoice } from "./NodesPanel";
import { Section } from "./Section";
import { Icon } from "./icons";

export interface SketchMembersRequest {
  size: string;
  lines: SketchLine[];
  line: "centre" | "outside";
  corners: "mitre" | "butt" | "none";
}

interface Props {
  doc: RawDocument | null;
  sizes: SizeChoice[];
  /** The lines picked so far, or null when the view isn't picking lines. */
  picking: SketchLine[] | null;
  onPicking(lines: SketchLine[] | null): void;
  onCreate(req: SketchMembersRequest): boolean;
  onError(text: string): void;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Each sketch's own lines (not construction), in the order they are listed. */
export function sketchLines(doc: RawDocument | null): { sketch: string; lines: string[] }[] {
  if (!doc) return [];
  return doc.features.flatMap((f) => {
    if (f.op !== "sketch" || f.suppressed === true) return [];
    const lines = (Array.isArray(f.entities) ? f.entities : []).filter((e) => isObject(e) && e.type === "line" && e.construction !== true && !e.ref).map((e) => String((e as { id: unknown }).id));
    return lines.length ? [{ sketch: String(f.id), lines }] : [];
  });
}

export function SketchMembersPanel({ doc, sizes, picking, onPicking, onCreate, onError }: Props) {
  const [size, setSize] = useState("");
  const [line, setLine] = useState<SketchMembersRequest["line"]>("outside");
  const [corners, setCorners] = useState<SketchMembersRequest["corners"]>("mitre");
  const all = sketchLines(doc);
  if (!doc || all.length === 0) return null;
  const chosen = sizes.some((s) => s.value === size) ? size : (sizes[0]?.value ?? "");
  const picked = picking ?? [];
  const create = () => {
    if (!chosen) return onError("Pick a section size first: save a profile to the section library, or put one in the part.");
    if (!picked.length) return onError("Pick the sketch lines the members run along: click them in the view, or take all of a sketch's.");
    if (onCreate({ size: chosen, lines: picked, line, corners })) onPicking(null);
  };
  const bySketch = new Map<string, string[]>();
  for (const p of picked) bySketch.set(p.sketch, [...(bySketch.get(p.sketch) ?? []), p.entity]);

  return (
    <Section title="Members from sketch" className="nodes sketch-members" testId="sketch-members" count={picked.length} open autoOpen={picking !== null}>
      <p className="muted small">Pick a size, then the sketch lines: a member on each, the corners joined. Edit the sketch and the frame follows.</p>
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
        <button type="button" className="primary" disabled={!picked.length || !chosen} onClick={create} data-testid="sketch-members-add">
          {picked.length ? `Add ${picked.length} member${picked.length === 1 ? "" : "s"}` : "Add members"}
        </button>
      </div>
    </Section>
  );
}

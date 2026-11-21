// A corner of a frame: where members meet at a node, and how. Its type
// (mitre for two members at an angle, butt, or none: the members left as they
// are), its arrangement order for a butt (the first runs through, each next
// one is trimmed to every one before it), the gap, and a gusset or a weld.
// One change per edit; Cycle (or C in the view) steps through the usual
// arrangements. Hovering a member's row lights it up in the view.

import type { Command, RawDocument } from "../../doc/commands";
import { nextId } from "../../doc/commands";
import { memberAtNode, validateDocument } from "../../doc/validate";
import type { MemberFeature } from "../../doc/types";
import { dot3, sub3 } from "../../geom/vec";
import { framesOf } from "../../weldment/sketchNodes";
import type { RebuildView } from "../../worker/protocol";
import { NumberInput, type NumberValue } from "../fields";
import { Icon } from "../icons";
import { CornerGlyph } from "./MemberCommand";

type Raw = Record<string, unknown>;

export interface CornerInfo {
  node: string;
  /** Members that end at the node, and those whose lines pass through it. */
  ending: MemberFeature[];
  passing: MemberFeature[];
  /** The joint at the node, as the document holds it. */
  joint?: Raw;
  /** What it is now. */
  kind: "mitre" | "butt" | "none";
  /** The arrangement order now (butt): the member that runs through first. */
  order: string[];
  /** Two members ending at an angle: it can be mitred. */
  canMitre: boolean;
}

/** Every corner of the frame: a node where two or more members meet. */
export function framesCorners(doc: RawDocument, view: RebuildView | null): CornerInfo[] {
  const v = validateDocument(doc, { sketchFrames: framesOf(view?.sketches) });
  const members = v.features.flatMap((x) => (x.feature?.op === "member" ? [x.feature as MemberFeature] : []));
  if (members.length < 2) return [];
  const joints = new Map<string, Raw>();
  for (const f of doc.features) if (f.op === "joint" && typeof f.node === "string") joints.set(f.node, f as Raw);
  const out: CornerInfo[] = [];
  for (const [node, at] of Object.entries(v.nodes)) {
    const ending = members.filter((m) => memberAtNode(m, node, at) === "ends");
    const passing = members.filter((m) => memberAtNode(m, node, at) === "passes");
    if (ending.length + passing.length < 2 || !ending.length) continue;
    out.push(cornerOf(node, ending, passing, joints.get(node)));
  }
  return out;
}

function cornerOf(node: string, ending: MemberFeature[], passing: MemberFeature[], joint?: Raw): CornerInfo {
  const dir = (m: MemberFeature) => {
    const d = m.fromNode === node ? sub3(m.to, m.from) : sub3(m.from, m.to);
    const l = Math.hypot(...d);
    return d.map((x) => x / l) as [number, number, number];
  };
  const canMitre = ending.length === 2 && !passing.length && Math.abs(dot3(dir(ending[0]), dir(ending[1]))) < 0.996;
  const kind = !joint ? "none" : joint.type === "mitre" ? "mitre" : "butt";
  let order: string[] = [];
  if (joint?.type === "butt") {
    const listed = Array.isArray(joint.order) ? (joint.order as string[]) : [String(joint.through)];
    order = [...listed, ...ending.map((m) => m.id).filter((id) => !listed.includes(id))];
  } else order = [...passing, ...ending].map((m) => m.id);
  return { node, ending, passing, joint, kind, order, canMitre };
}

/** The commands that make a corner this kind (and order): one change. */
export function cornerCommands(doc: RawDocument, c: CornerInfo, kind: "mitre" | "butt" | "none", order?: string[]): Command[] | string {
  const id = c.joint ? String(c.joint.id) : nextId(doc, `corner_${c.node}`.replace(/[^A-Za-z0-9_]/g, "_"));
  if (kind === "none") return c.joint ? [{ type: "deleteFeature", id }] : [];
  if (kind === "mitre") {
    if (!c.canMitre) return "a mitre joins two members that end at an angle";
    const members = c.ending.map((m) => m.id);
    return c.joint ? [{ type: "updateFeature", id, patch: { type: "mitre", members, through: null, order: null } }] : [{ type: "addFeature", feature: { id, op: "joint", node: c.node, type: "mitre", members } }];
  }
  const o = order ?? c.order;
  const through = o[0];
  // Only the members after the first that end here can be trimmed; one member left over needs no order of its own.
  const rest = o.slice(1).filter((x) => c.ending.some((m) => m.id === x));
  const patch = { type: "butt", through, members: null, order: rest.length > 1 ? [through, ...rest] : null };
  if (c.joint) return [{ type: "updateFeature", id, patch }];
  const { members: _m, order: ord, ...add } = patch;
  return [{ type: "addFeature", feature: { id, op: "joint", node: c.node, ...add, ...(ord ? { order: ord } : {}) } }];
}

/** The next of the usual arrangements: mitre (when it can be), then butt with each member running through in turn, then none. */
export function cycleCorner(c: CornerInfo): { kind: "mitre" | "butt" | "none"; order?: string[] } {
  const firsts = [...c.passing, ...c.ending].map((m) => m.id);
  const options: { kind: "mitre" | "butt" | "none"; order?: string[] }[] = [
    ...(c.canMitre ? [{ kind: "mitre" as const }] : []),
    ...firsts.map((f) => ({ kind: "butt" as const, order: [f, ...c.ending.map((m) => m.id).filter((x) => x !== f)] })),
    { kind: "none" as const },
  ];
  const now = options.findIndex((o) => o.kind === c.kind && (o.kind !== "butt" || o.order![0] === c.order[0]));
  return options[(now + 1) % options.length];
}

interface Props {
  doc: RawDocument;
  corner: CornerInfo;
  /** One change of the document; the problem, or null. */
  onBatch(cmds: Command[]): string | null;
  onError(text: string): void;
  /** A member's row under the pointer: lit up in the view (null: none). */
  onHoverMember?(id: string | null): void;
  /** Adds a gusset or a weld at the corner (the joint's actions). */
  extras?: React.ReactNode;
}

export function CornerPanel({ doc, corner: c, onBatch, onError, onHoverMember, extras }: Props) {
  const set = (kind: "mitre" | "butt" | "none", order?: string[]) => {
    const cmds = cornerCommands(doc, c, kind, order);
    if (typeof cmds === "string") return onError(cmds);
    if (!cmds.length) return;
    const problem = onBatch(cmds);
    if (problem) onError(problem);
  };
  const move = (i: number, by: -1 | 1) => {
    const o = [...c.order];
    const j = i + by;
    if (j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j], o[i]];
    // Only one that ends here can be trimmed: a member passing through can only be first.
    if (o.slice(1).some((id) => c.passing.some((m) => m.id === id))) return onError("a member passing through the corner can't be trimmed there: it can only run through");
    set("butt", o);
  };
  const role = (id: string, i: number) => {
    if (c.kind !== "butt") return c.passing.some((m) => m.id === id) ? "passes through" : "ends here";
    if (i === 0) return "runs through";
    return i === 1 ? `trimmed to ${c.order[0]}` : `trimmed to the ${i} above`;
  };
  const cyc = cycleCorner(c);
  const cycText = cyc.kind === "none" ? "none" : cyc.kind === "mitre" ? "mitre" : `butt, ${cyc.order![0]} through`;

  return (
    <div className="corner-panel" data-testid="corner-panel">
      <div className="corner-head">
        <span className="corner-title">
          <CornerGlyph kind={c.kind} /> Corner <strong>{c.node}</strong>
        </span>
        <button type="button" className="corner-cycle" onClick={() => set(cyc.kind, cyc.order)} title={`Next arrangement: ${cycText} (C)`} data-testid="corner-cycle">
          <Icon name="repeat" size={13} /> Cycle
        </button>
      </div>
      <div className="seg" role="radiogroup" aria-label="Corner type">
        {(
          [
            ["mitre", "Mitre"],
            ["butt", "Butt"],
            ["none", "None"],
          ] as const
        ).map(([k, label]) => (
          <button
            type="button"
            key={k}
            role="radio"
            aria-checked={c.kind === k}
            className={c.kind === k ? "on" : ""}
            disabled={k === "mitre" && !c.canMitre}
            title={k === "mitre" && !c.canMitre ? "A mitre joins two members that end at an angle" : k === "none" ? "No joint: the members are left as they are (they may overlap)" : undefined}
            onClick={() => c.kind !== k && set(k)}
            data-testid={`corner-type-${k}`}
          >
            <CornerGlyph kind={k} />
            {label}
          </button>
        ))}
      </div>
      <div className="corner-list-head">
        <h3>{c.kind === "butt" ? "Arrangement" : "Members"}</h3>
        {c.kind === "butt" && <span className="muted small">first runs through · each next is trimmed to those above</span>}
      </div>
      <ol className={`corner-list${c.kind === "butt" ? " ordered" : ""}`}>
        {c.order.map((id, i) => {
          const passes = c.passing.some((m) => m.id === id);
          return (
            <li key={id} onPointerEnter={() => onHoverMember?.(id)} onPointerLeave={() => onHoverMember?.(null)} data-testid={`corner-member-${id}`} className={c.kind === "butt" && i === 0 ? "through" : ""}>
              {c.kind === "butt" && <span className="corner-rank">{i + 1}</span>}
              <span className="corner-member">
                <span className="mono">{id}</span>
                <span className="muted small">{role(id, i)}</span>
              </span>
              {c.kind === "butt" ? (
                <span className="corner-moves">
                  {i > 0 && !passes && (
                    <button type="button" className="icon" onClick={() => set("butt", [id, ...c.order.filter((x) => x !== id)])} title="Make it run through" aria-label={`${id} runs through`} data-testid={`corner-first-${id}`}>
                      <Icon name="pin" size={12} />
                    </button>
                  )}
                  {passes && i > 0 && (
                    <button type="button" className="icon" onClick={() => set("butt", [id, ...c.order.filter((x) => x !== id)])} title="It passes through the corner: make it the one that runs through" data-testid={`corner-first-${id}`}>
                      <Icon name="pin" size={12} />
                    </button>
                  )}
                  <button type="button" className="icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`${id} up`} data-testid={`corner-up-${id}`}>
                    <Icon name="up" size={12} />
                  </button>
                  <button type="button" className="icon" disabled={i === c.order.length - 1} onClick={() => move(i, 1)} aria-label={`${id} down`} data-testid={`corner-down-${id}`}>
                    <Icon name="down" size={12} />
                  </button>
                </span>
              ) : (
                <span />
              )}
            </li>
          );
        })}
      </ol>
      {c.joint && (
        <label className="corner-gap">
          <span>Gap</span>
          <NumberInput value={(c.joint.gap as NumberValue) ?? 0} min={0} onCommit={(v) => onBatch([{ type: "updateFeature", id: String(c.joint!.id), patch: { gap: v === 0 ? null : v } }])} testId="corner-gap" />
          <span className="muted small">mm between the cut faces</span>
        </label>
      )}
      {c.kind === "none" && <p className="muted small">No joint here: the members are left as they are. Pick a type to join them.</p>}
      {extras}
    </div>
  );
}

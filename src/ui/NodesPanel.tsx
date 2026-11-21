// A frame's nodes (Phase J): named points, their coordinates numbers or
// expressions. Members that name a node move with it. Below them, members
// along a path of nodes ("A B C D A"), with the corners mitred, as one change.

import { useState } from "react";
import type { Command, RawDocument } from "../doc/commands";
import { NODE_NAME } from "../doc/types";
import { nodeUsers } from "../doc/commands";
import { validateDocument } from "../doc/validate";
import { isNodeLink, linkText, type SketchFrames } from "../weldment/sketchNodes";
import { NumberInput, TextInput, Vec3Input, type NumberValue } from "./fields";
import { Section } from "./Section";
import { Icon } from "./icons";

export interface SizeChoice {
  /** "part|<profile>|<designation>" or "lib|<library id>|<designation>". */
  value: string;
  label: string;
}

export interface PathRequest {
  size: string;
  path: string;
  line: "centre" | "outside";
  mitre: boolean;
}

interface Props {
  doc: RawDocument | null;
  dispatch(cmd: Command): string | null;
  onError(text: string): void;
  /** Opens the Member command on a path of nodes. */
  onMembers(): void;
  /** Where the last rebuild put each sketch (nodes on a face sketch are placed from these). */
  frames?: SketchFrames;
}

/** The next free node name: A, B, ... Z, then N1, N2, ... */
export function nextNodeName(taken: string[]): string {
  for (let i = 0; i < 26; i++) {
    const n = String.fromCharCode(65 + i);
    if (!taken.includes(n)) return n;
  }
  for (let k = 1; ; k++) if (!taken.includes(`N${k}`)) return `N${k}`;
}

export function NodesPanel({ doc, dispatch, onError, onMembers, frames }: Props) {
  const [at, setAt] = useState<NumberValue[]>([0, 0, 0]);
  const [name, setName] = useState("");
  if (!doc) return null;
  const nodes = (doc.nodes ?? {}) as Record<string, NumberValue[]>;
  const v = Object.values(nodes).some(isNodeLink) ? validateDocument(doc, { sketchFrames: frames }) : null;
  const names = Object.keys(nodes);
  const run = (cmd: Command) => {
    const problem = dispatch(cmd);
    if (problem) onError(problem);
    return problem;
  };
  const add = () => {
    const n = name.trim() || nextNodeName(names);
    if (!NODE_NAME.test(n)) return onError(`"${n}" is not a node name: use letters, digits and _, starting with a letter`);
    if (n in nodes) return onError(`there is already a node "${n}"`);
    if (!run({ type: "setNode", name: n, at })) setName("");
  };

  return (
    <Section title="Nodes" className="nodes" testId="nodes" count={names.length} open={names.length > 0} autoOpen={names.length > 0}>
      {names.length === 0 && <p className="muted small">Points a frame is built on: members run from node to node, and move with them.</p>}
      <ul>
        {names.map((n) => {
          const users = nodeUsers(doc.features, n);
          return (
            <li key={n} data-testid={`node-${n}`}>
              <span className="node-name" title={users.length ? `used by ${users.join(", ")}` : "not used yet"}>
                <TextInput value={n} onCommit={(to) => run({ type: "renameNode", from: n, to })} testId={`node-name-${n}`} />
              </span>
              {isNodeLink(nodes[n]) ? (
                <span className={`node-link${v?.nodeProblems[n] ? " broken" : ""}`} title={v?.nodeProblems[n] ? `${n} ${v.nodeProblems[n]}` : `Follows ${linkText(nodes[n] as unknown as { sketch: string; point: string })}${v?.nodes[n] ? `, now at ${v.nodes[n].map((x) => Math.round(x * 100) / 100).join(", ")}` : ""}: it moves with the sketch`} data-testid={`node-link-${n}`}>
                  <Icon name="link" size={12} />
                  <span>{(nodes[n] as unknown as { point: string }).point}</span>
                  {v?.nodes[n] && (
                    <button type="button" className="link-button small" onClick={() => run({ type: "setNode", name: n, at: [...v.nodes[n]] })} title="Keep it where it is, no longer following the sketch" data-testid={`node-unlink-${n}`}>
                      Unlink
                    </button>
                  )}
                </span>
              ) : (
                <Vec3Input value={nodes[n]} onCommit={(at) => run({ type: "setNode", name: n, at })} testId={`node-${n}`} />
              )}
              <button className="icon" aria-label={`Delete ${n}`} title={users.length ? `Used by ${users.join(", ")}` : "Delete"} onClick={() => run({ type: "setNode", name: n, at: null })} data-testid={`node-delete-${n}`}>
                <Icon name="trash" size={14} />
              </button>
            </li>
          );
        })}
      </ul>
      <div className="node-add">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={nextNodeName(names)} aria-label="New node name" data-testid="node-new-name" />
        <span className="vec">
          {[0, 1, 2].map((k) => (
            <NumberInput key={k} value={at[k]} ariaLabel={`new node ${"xyz"[k]}`} testId={`node-new-${"xyz"[k]}`} onCommit={(v) => setAt(at.map((c, i) => (i === k ? v : c)))} />
          ))}
        </span>
        <button onClick={add} data-testid="node-add" title="Add the node">
          <Icon name="plus" size={14} />
          Add
        </button>
      </div>
      {names.length >= 2 && (
        <button type="button" className="node-members" onClick={onMembers} data-testid="nodes-members" title="The Member command, with a path of nodes (A B C D A)">
          <Icon name="member" size={14} />
          Members along nodes…
        </button>
      )}
    </Section>
  );
}

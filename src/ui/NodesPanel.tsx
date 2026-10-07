// A frame's nodes (Phase J): named points, their coordinates numbers or
// expressions. Members that name a node move with it. Below them, members
// along a path of nodes ("A B C D A"), with the corners mitred, as one change.

import { useState } from "react";
import type { Command, RawDocument } from "../doc/commands";
import { NODE_NAME } from "../doc/types";
import { nodeUsers } from "../doc/commands";
import { NumberInput, TextInput, Vec3Input, type NumberValue } from "./fields";

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
  sizes: SizeChoice[];
  onPath(req: PathRequest): boolean;
}

/** The next free node name: A, B, ... Z, then N1, N2, ... */
export function nextNodeName(taken: string[]): string {
  for (let i = 0; i < 26; i++) {
    const n = String.fromCharCode(65 + i);
    if (!taken.includes(n)) return n;
  }
  for (let k = 1; ; k++) if (!taken.includes(`N${k}`)) return `N${k}`;
}

export function NodesPanel({ doc, dispatch, onError, sizes, onPath }: Props) {
  const [at, setAt] = useState<NumberValue[]>([0, 0, 0]);
  const [name, setName] = useState("");
  const [size, setSize] = useState("");
  const [path, setPath] = useState("");
  const [line, setLine] = useState<PathRequest["line"]>("outside");
  const [mitre, setMitre] = useState(true);
  if (!doc) return null;
  const nodes = (doc.nodes ?? {}) as Record<string, NumberValue[]>;
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
  const chosen = sizes.some((s) => s.value === size) ? size : (sizes[0]?.value ?? "");

  return (
    <section className="panel nodes" data-testid="nodes">
      <h2>Nodes</h2>
      {names.length === 0 && <p className="muted small">Points a frame is built on: members run from node to node, and move with them.</p>}
      <ul>
        {names.map((n) => {
          const users = nodeUsers(doc.features, n);
          return (
            <li key={n} data-testid={`node-${n}`}>
              <span className="node-name" title={users.length ? `used by ${users.join(", ")}` : "not used yet"}>
                <TextInput value={n} onCommit={(to) => run({ type: "renameNode", from: n, to })} testId={`node-name-${n}`} />
              </span>
              <Vec3Input value={nodes[n]} onCommit={(v) => run({ type: "setNode", name: n, at: v })} testId={`node-${n}`} />
              <button aria-label={`Delete ${n}`} title={users.length ? `Used by ${users.join(", ")}` : "Delete"} onClick={() => run({ type: "setNode", name: n, at: null })} data-testid={`node-delete-${n}`}>
                ×
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
        <button onClick={add} data-testid="node-add">
          Add
        </button>
      </div>
      {names.length >= 2 && (
        <form
          className="path-tool"
          onSubmit={(e) => {
            e.preventDefault();
            if (!chosen) return onError("Pick a section size first: save a profile to the section library, or put one in the part.");
            if (onPath({ size: chosen, path, line, mitre })) setPath("");
          }}
        >
          <h3>Members along a path</h3>
          <select value={chosen} onChange={(e) => setSize(e.target.value)} aria-label="Section size" data-testid="path-size">
            {sizes.length === 0 && <option value="">No sections yet</option>}
            {sizes.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="A B C D A, A E" aria-label="Path of nodes" data-testid="path-text" />
          <div className="path-options">
            <select value={line} onChange={(e) => setLine(e.target.value as PathRequest["line"])} aria-label="Where the line runs" data-testid="path-line">
              <option value="outside">Nodes on the outside</option>
              <option value="centre">Nodes on the centrelines</option>
            </select>
            <label className="check">
              <input type="checkbox" checked={mitre} onChange={(e) => setMitre(e.target.checked)} data-testid="path-mitre" />
              Mitre corners
            </label>
          </div>
          <button type="submit" disabled={!path.trim()} data-testid="path-add">
            Add members
          </button>
        </form>
      )}
    </section>
  );
}

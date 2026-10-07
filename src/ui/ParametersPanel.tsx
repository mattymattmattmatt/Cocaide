// Document parameters: named numbers any number field can use as "=name".
// Changing one is one setParameter command, so it is one undo step and the
// sketches that use it are re-solved.

import { useState } from "react";
import type { Command, RawDocument } from "../doc/commands";
import { documentParameters, PARAMETER_NAME, parameterRefs } from "../doc/parameters";
import { NumberInput } from "./fields";

interface Props {
  doc: RawDocument | null;
  dispatch(cmd: Command): string | null;
  onError(text: string): void;
}

export function ParametersPanel({ doc, dispatch, onError }: Props) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  if (!doc) return null;
  const params = documentParameters(doc);
  const usedBy = (p: string) => doc.features.filter((f) => parameterRefs(f).has(p)).map((f) => String(f.id));
  const run = (cmd: Command) => {
    const problem = dispatch(cmd);
    if (problem) onError(problem);
    return problem;
  };
  const add = () => {
    const n = name.trim();
    const v = Number(value);
    if (!PARAMETER_NAME.test(n)) return onError(`"${n}" is not a parameter name: use letters, digits and _, starting with a letter`);
    if (n in params) return onError(`there is already a parameter "${n}"`);
    if (value.trim() === "" || !Number.isFinite(v)) return onError("a parameter's value is a number");
    if (!run({ type: "setParameter", name: n, value: v })) {
      setName("");
      setValue("");
    }
  };

  return (
    <section className="panel parameters" data-testid="parameters">
      <h2>Parameters</h2>
      {Object.keys(params).length === 0 && <p className="muted small">Name a number here, then type =name in any number field.</p>}
      <ul>
        {Object.entries(params).map(([p, v]) => {
          const users = usedBy(p);
          return (
            <li key={p} data-testid={`param-${p}`}>
              <span className="param-name" title={users.length ? `used by ${users.join(", ")}` : "not used yet"}>
                {p}
              </span>
              <NumberInput
                value={v}
                ariaLabel={p}
                testId={`param-value-${p}`}
                onCommit={(next) => {
                  if (typeof next === "number") run({ type: "setParameter", name: p, value: next });
                  else onError("a parameter's value is a number, not an expression");
                }}
              />
              <button
                className="icon"
                aria-label={`Delete ${p}`}
                disabled={users.length > 0}
                title={users.length ? `used by ${users.join(", ")}` : "Delete"}
                onClick={() => run({ type: "deleteParameter", name: p })}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
      <form
        className="param-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} aria-label="New parameter name" data-testid="param-new-name" />
        <input
          placeholder="value"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="New parameter value"
          data-testid="param-new-value"
        />
        <button type="submit" data-testid="param-add">
          Add
        </button>
      </form>
    </section>
  );
}

// Document parameters: named numbers any number field can use as "=name".
// Changing one is one setParameter command, so it is one undo step and the
// sketches that use it are re-solved.

import { useState } from "react";
import type { AskTarget } from "../ask/packet";
import type { Command, RawDocument } from "../doc/commands";
import { documentParameters, PARAMETER_NAME, parameterRefs } from "../doc/parameters";
import { photoOf } from "../doc/photo";
import { NumberInput } from "./fields";

interface Props {
  doc: RawDocument | null;
  dispatch(cmd: Command): string | null;
  onError(text: string): void;
  onAsk?(target: AskTarget, x: number, y: number): void;
}

const MARK_TITLE = {
  estimate: "Measured on the photo and scaled from its one known dimension. Set it, or keep it, to make it yours.",
  guess: "The photo doesn't show this: a placeholder. Export waits until you set it.",
  scale: "The photo's known dimension: the scale every estimate is measured from. Set it on the photo.",
};

export function ParametersPanel({ doc, dispatch, onError, onAsk }: Props) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  if (!doc) return null;
  const params = documentParameters(doc);
  const photo = photoOf(doc);
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
          // From a photo: an estimate (measured on it, scaled), a guess (it doesn't show), or the scale itself.
          const px = photo?.estimated[p];
          const mark = photo && px !== undefined ? (px === null ? "guess" : photo.scale.parameter === p ? "scale" : "estimate") : null;
          return (
            <li
              key={p}
              className={mark ? `from-photo ${mark}` : undefined}
              data-testid={`param-${p}`}
              onContextMenu={(e) => {
                if (!onAsk) return;
                e.preventDefault();
                onAsk({ kind: "parameter", name: p }, e.clientX, e.clientY);
              }}
            >
              <span className="param-name" title={users.length ? `used by ${users.join(", ")}` : "not used yet"}>
                {p}
                {mark && (
                  <span className="param-mark" data-testid={`param-mark-${p}`} title={MARK_TITLE[mark]}>
                    {mark === "estimate" ? "≈ photo" : mark}
                  </span>
                )}
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
              {mark ? (
                <button className="icon keep" aria-label={`Keep ${p}`} title="Keep this value: it becomes yours, not the photo's" onClick={() => run({ type: "setParameter", name: p, value: v })}>
                  ✓
                </button>
              ) : (
                <button
                  className="icon"
                  aria-label={`Delete ${p}`}
                  disabled={users.length > 0}
                  title={users.length ? `used by ${users.join(", ")}` : "Delete"}
                  onClick={() => run({ type: "deleteParameter", name: p })}
                >
                  ×
                </button>
              )}
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

// Document parameters: named numbers any number field can use as "=name".
// A parameter may itself be an "=expression" over the others and the
// sketches' named dimensions ("=sketch_1.width / 2"): the part's equations.
// Changing one is one setParameter command, so it is one undo step and the
// sketches that use it are re-solved. Double-click a name to rename it (every
// expression that reads it follows). The named dimensions are listed beneath,
// as expressions read them.

import { useRef, useState } from "react";
import type { AskTarget } from "../ask/packet";
import type { Command, RawDocument } from "../doc/commands";
import { evaluate, isExpression, PARAMETER_NAME, parameterRefs, parameterValues, rawParameters } from "../doc/parameters";
import { documentSymbols } from "../doc/dimensions";
import { photoOf } from "../doc/photo";
import { NumberInput } from "./fields";
import { Section } from "./Section";
import { Icon } from "./icons";

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
  const [renaming, setRenaming] = useState<string | null>(null);
  if (!doc) return null;
  const params = rawParameters(doc);
  const values = parameterValues(doc);
  const symbols = documentSymbols(doc);
  /** The sketch dimensions given a name of their own: what expressions read as <sketch>.<name>. */
  const named = [...symbols.entries].filter(([full, e]) => {
    if (e.kind !== "dimension") return false;
    const f = doc.features.find((x) => x.id === e.sketch) as { constraints?: { name?: unknown }[] } | undefined;
    return typeof f?.constraints?.[e.index!]?.name === "string" && full in symbols.values;
  });
  const photo = photoOf(doc);
  /** The features, and the other parameters, whose expressions read p. */
  const usedBy = (p: string) => [
    ...doc.features.filter((f) => parameterRefs(f).has(p)).map((f) => String(f.id)),
    ...Object.entries(params).flatMap(([q, raw]) => (q !== p && parameterRefs(raw).has(p) ? [q] : [])),
  ];
  const run = (cmd: Command) => {
    const problem = dispatch(cmd);
    if (problem) onError(problem);
    return problem;
  };
  const add = () => {
    const n = name.trim();
    const t = value.trim();
    if (!PARAMETER_NAME.test(n)) return onError(`"${n}" is not a parameter name: use letters, digits and _, starting with a letter`);
    if (n in params) return onError(`there is already a parameter "${n}"`);
    // A number, or "=expression" (kept, so it follows what it reads).
    const v = isExpression(t) ? t : Number(t);
    if (t === "" || (typeof v === "number" && !Number.isFinite(v))) return onError('a parameter\'s value is a number, or "=expression" such as =sketch_1.width / 2');
    if (typeof v === "string") {
      const r = evaluate(v, { ...symbols.values });
      if (!r.ok) return onError(r.error);
    }
    if (!run({ type: "setParameter", name: n, value: v })) {
      setName("");
      setValue("");
    }
  };

  return (
    <Section title="Parameters" className="parameters" testId="parameters" count={Object.keys(params).length}>
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
              {renaming === p ? (
                <span className="param-name">
                  <RenameInput
                    value={p}
                    testId={`param-rename-${p}`}
                    onDone={(to) => {
                      setRenaming(null);
                      if (to && to !== p) run({ type: "renameParameter", from: p, to });
                    }}
                  />
                </span>
              ) : (
              <span
                className="param-name"
                title={`${users.length ? `used by ${users.join(", ")}` : "not used yet"} · double-click to rename`}
                onDoubleClick={() => setRenaming(p)}
              >
                {p}
                {mark && (
                  <span className="param-mark" data-testid={`param-mark-${p}`} title={MARK_TITLE[mark]}>
                    {mark === "estimate" ? "≈ photo" : mark}
                  </span>
                )}
              </span>
              )}
              <NumberInput
                value={v}
                ariaLabel={p}
                testId={`param-value-${p}`}
                onCommit={(next) => {
                  run({ type: "setParameter", name: p, value: next });
                }}
              />
              {mark ? (
                <button className="icon keep" aria-label={`Keep ${p}`} title="Keep this value: it becomes yours, not the photo's" onClick={() => run({ type: "setParameter", name: p, value: values[p] ?? v })}>
                  <Icon name="check" size={14} />
                </button>
              ) : (
                <button
                  className="icon"
                  aria-label={`Delete ${p}`}
                  disabled={users.length > 0}
                  title={users.length ? `used by ${users.join(", ")}` : "Delete"}
                  onClick={() => run({ type: "deleteParameter", name: p })}
                >
                  <Icon name="trash" size={14} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {named.length > 0 && (
        <>
          <p className="muted small param-dims-title">Named dimensions (read as =sketch.name)</p>
          <ul className="param-dims" data-testid="named-dimensions">
            {named.map(([full, e]) => (
              <li key={full} data-testid={`named-dim-${full}`} title={e.driven ? "Driven: measured from the sketch" : `Set in ${e.sketch}, or by an expression`}>
                <span className="param-name">{full}</span>
                <span className="dim-value">{e.driven ? `(${Math.round(symbols.values[full] * 1e6) / 1e6})` : Math.round(symbols.values[full] * 1e6) / 1e6}</span>
              </li>
            ))}
          </ul>
        </>
      )}
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
          title='A number, or "=expression" over parameters and named dimensions, such as =sketch_1.width / 2'
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="New parameter value"
          data-testid="param-new-value"
        />
        <button type="submit" data-testid="param-add" title="Add the parameter">
          <Icon name="plus" size={14} />
          Add
        </button>
      </form>
    </Section>
  );
}

/** The name being edited in place: focused and selected; Enter or leaving it renames, Esc keeps the old name. */
function RenameInput({ value, testId, onDone }: { value: string; testId: string; onDone(to: string | null): void }) {
  const [text, setText] = useState(value);
  const done = useRef(false);
  const finish = (to: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(to?.trim() || null);
  };
  return (
    <input
      value={text}
      autoFocus
      onFocus={(e) => e.target.select()}
      aria-label={`Rename ${value}`}
      spellCheck={false}
      data-testid={testId}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish(text)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(text);
        if (e.key === "Escape") finish(null);
      }}
    />
  );
}

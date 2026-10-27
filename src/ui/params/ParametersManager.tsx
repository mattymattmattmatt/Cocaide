// The parameters manager (Phase P): every parameter and named dimension of
// the part in one table: its expression (edit it in place), its value and
// unit, where it is used (click a feature to go to it), unused ones flagged.
// Add, rename (every expression that reads it follows) and delete (only what
// nothing uses); sort by a column, filter by name, expression or user
// ("unused" shows those). Opened from the Parameters panel and the command
// palette. Every change is one command, one undo step.

import { useEffect, useMemo, useState } from "react";
import type { Command, RawDocument } from "../../doc/commands";
import { evaluate, isExpression, PARAMETER_NAME } from "../../doc/parameters";
import { documentSymbols } from "../../doc/dimensions";
import { InlineInput } from "../FeatureTree";
import { NumberInput } from "../fields";
import { Icon } from "../icons";
import { isUsed, parameterRows, sortRows, type SortKey } from "./usage";

interface Props {
  doc: RawDocument;
  dispatch(cmd: Command): string | null;
  onError(text: string): void;
  /** A click on a feature that uses it: show that feature. */
  onGoTo(id: string): void;
  onClose(): void;
}

export function ParametersManager({ doc, dispatch, onError, onGoTo, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; down: boolean }>({ key: "name", down: false });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const rows = useMemo(() => parameterRows(doc), [doc]);
  const shown = sortRows(rows, sort.key, query, sort.down);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const run = (cmd: Command) => {
    const problem = dispatch(cmd);
    if (problem) onError(problem);
    return problem;
  };
  const add = () => {
    const n = name.trim();
    const t = value.trim();
    if (!PARAMETER_NAME.test(n)) return onError(`"${n}" is not a parameter name: use letters, digits and _, starting with a letter`);
    if (rows.some((r) => r.name === n)) return onError(`there is already a parameter "${n}"`);
    const v = isExpression(t) ? t : Number(t);
    if (t === "" || (typeof v === "number" && !Number.isFinite(v))) return onError('a parameter\'s value is a number, or "=expression" such as =sketch_1.width / 2');
    if (typeof v === "string") {
      const r = evaluate(v, documentSymbols(doc).values);
      if (!r.ok) return onError(r.error);
    }
    if (!run({ type: "setParameter", name: n, value: v })) {
      setName("");
      setValue("");
    }
  };
  const header = (key: SortKey, label: string) => (
    <th>
      <button className="link-button" onClick={() => setSort((s) => ({ key, down: s.key === key ? !s.down : false }))} data-testid={`pm-sort-${key}`} aria-sort={sort.key === key ? (sort.down ? "descending" : "ascending") : undefined}>
        {label}
        {sort.key === key && <Icon name={sort.down ? "down" : "up"} size={12} />}
      </button>
    </th>
  );
  const unused = rows.filter((r) => r.kind === "parameter" && !isUsed(r)).length;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="modal params-manager" role="dialog" aria-label="Parameters manager" data-testid="params-manager">
        <header>
          <h2>
            <Icon name="parameters" /> Parameters
          </h2>
          <span className="muted small">
            {rows.filter((r) => r.kind === "parameter").length} parameters · {rows.filter((r) => r.kind === "dimension").length} named dimensions{unused ? ` · ${unused} unused` : ""}
          </span>
          <input type="search" placeholder="Filter: name, expression, feature, or unused" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter the parameters" data-testid="pm-filter" />
          <button className="icon-only" aria-label="Close" onClick={onClose} data-testid="pm-close">
            <Icon name="x" />
          </button>
        </header>
        <div className="pm-table-wrap">
          <table className="pm-table">
            <thead>
              <tr>
                {header("name", "Name")}
                <th>Expression</th>
                {header("value", "Value")}
                <th>Unit</th>
                {header("used", "Used by")}
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.name} className={`${r.kind}${isUsed(r) ? "" : " unused"}${r.problem ? " bad" : ""}`} data-testid={`pm-row-${r.name}`}>
                  <td className="pm-name">
                    {renaming === r.name ? (
                      <InlineInput
                        value={r.kind === "dimension" ? r.name.slice(r.sketch!.length + 1) : r.name}
                        testId={`pm-rename-input-${r.name}`}
                        label={`Rename ${r.name}`}
                        onDone={(to) => {
                          setRenaming(null);
                          if (!to) return;
                          if (r.kind === "parameter" && to !== r.name) run({ type: "renameParameter", from: r.name, to });
                          if (r.kind === "dimension" && `${r.sketch}.${to}` !== r.name) run({ type: "renameDimension", sketch: r.sketch!, name: r.name, to });
                        }}
                      />
                    ) : (
                      <button className="link-button" title="Rename it (double-click): every expression that reads it follows" onDoubleClick={() => setRenaming(r.name)} data-testid={`pm-name-${r.name}`}>
                        {r.name}
                      </button>
                    )}
                    {r.kind === "dimension" && <span className="muted small"> {r.driven ? "driven dimension" : "dimension"}</span>}
                  </td>
                  <td className="pm-expr">
                    {r.kind === "parameter" ? (
                      <NumberInput value={r.expression} ariaLabel={`${r.name} expression`} testId={`pm-expr-${r.name}`} onCommit={(next) => void run({ type: "setParameter", name: r.name, value: next })} />
                    ) : r.driven ? (
                      <span className="muted">(measured)</span>
                    ) : (
                      <NumberInput value={r.expression} ariaLabel={`${r.name} expression`} testId={`pm-expr-${r.name}`} onCommit={(next) => void run({ type: "setDimension", sketch: r.sketch!, name: r.name, value: next })} />
                    )}
                  </td>
                  <td className="pm-value" data-testid={`pm-value-${r.name}`} title={r.problem}>
                    {r.value === null ? <span className="expr-error">{r.problem ?? "—"}</span> : Math.round(r.value * 1e6) / 1e6}
                  </td>
                  <td className="pm-unit">{r.unit}</td>
                  <td className="pm-used">
                    {isUsed(r) ? (
                      <>
                        {r.features.map((u) => (
                          <button key={u.feature} className="chip" onClick={() => onGoTo(u.feature)} title={`${u.feature} reads it (${u.fields.join(", ")}): click to show it`} data-testid={`pm-used-${r.name}-${u.feature}`}>
                            {u.feature}
                          </button>
                        ))}
                        {r.others.map((o) => (
                          <span key={o} className="chip muted">
                            {o}
                          </span>
                        ))}
                      </>
                    ) : (
                      <span className="pm-unused" data-testid={`pm-unused-${r.name}`} title="Nothing reads it: use it as =name in any number field, or delete it">
                        unused
                      </span>
                    )}
                  </td>
                  <td className="pm-actions">
                    <button className="icon-only" aria-label={`Rename ${r.name}`} title="Rename: every expression that reads it follows" onClick={() => setRenaming(r.name)} data-testid={`pm-rename-${r.name}`}>
                      <Icon name="note" size={14} />
                    </button>
                    {r.kind === "parameter" && (
                      <button
                        className="icon-only"
                        aria-label={`Delete ${r.name}`}
                        disabled={isUsed(r)}
                        title={isUsed(r) ? `Used by ${[...r.features.map((u) => u.feature), ...r.others].join(", ")}: change what reads it first` : "Delete it"}
                        onClick={() => run({ type: "deleteParameter", name: r.name })}
                        data-testid={`pm-delete-${r.name}`}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    {rows.length ? `Nothing matches “${query}”.` : "No parameters yet: add one below, or right-click a number in a feature's properties: Create parameter from this value."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <form
          className="param-add"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            placeholder="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              // Enter on the name goes on to the value while it is empty.
              if (e.key === "Enter" && !value.trim()) {
                e.preventDefault();
                (e.currentTarget.nextElementSibling as HTMLInputElement | null)?.focus();
              }
            }}
            aria-label="New parameter name"
            data-testid="pm-add-name"
          />
          <input placeholder="value or =expression" value={value} onChange={(e) => setValue(e.target.value)} aria-label="New parameter value" data-testid="pm-add-value" />
          <button type="submit" data-testid="pm-add">
            <Icon name="plus" size={14} /> Add
          </button>
        </form>
      </section>
    </div>
  );
}

/** "Create parameter from this value": the name to give it, asked in place. */
export function NameParameter({ x, y, suggested, value, onDone }: { x: number; y: number; suggested: string; value: number | string; onDone(name: string | null): void }) {
  return (
    <div className="name-parameter" style={{ left: x, top: y }} role="dialog" aria-label="Name the parameter" data-testid="name-parameter">
      <span className="small">
        Parameter for <strong>{String(value)}</strong>:
      </span>
      <InlineInput value={suggested} testId="name-parameter-input" label="Parameter name" onDone={onDone} />
    </div>
  );
}

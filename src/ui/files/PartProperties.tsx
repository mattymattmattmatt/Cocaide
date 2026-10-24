// The part's properties, on the Document tab (Phase P): part number,
// description, revision, author, finish, and any others by name. Each edit is
// one setProperties command (one undo step). The drawing's title block, the
// cut list CSV, STEP export and export file names read them.

import { useEffect, useState } from "react";
import type { Command, RawDocument } from "../../doc/commands";
import { partProperties, PROPERTY_FIELDS } from "../../doc/properties";
import { Icon } from "../icons";

interface Props {
  doc: RawDocument | null;
  dispatch(cmd: Command): string | null;
  onError(text: string): void;
}

const OPEN_KEY = "cocaide.partProperties.open.v1";

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

/** A text box that commits on Enter or leaving it; empty removes the property. */
function PropertyInput({ value, placeholder, onCommit, testId, label }: { value: string; placeholder?: string; onCommit(v: string): void; testId: string; label: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
    else setDraft(value);
  };
  return (
    <input
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      data-testid={testId}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setDraft(value);
      }}
    />
  );
}

export function PartProperties({ doc, dispatch, onError }: Props) {
  const [open, setOpen] = useState(readOpen);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const props = partProperties(doc);
  const custom = Object.entries(props.custom ?? {});
  const set = (patch: Record<string, unknown>) => {
    const problem = dispatch({ type: "setProperties", patch });
    if (problem) onError(problem);
    return !problem;
  };
  const setCustom = (entries: [string, string][]) => set({ custom: entries.length ? Object.fromEntries(entries) : null });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(OPEN_KEY, open ? "0" : "1");
    } catch {
      // not kept: fine
    }
  };
  const addCustom = () => {
    const name = newName.trim();
    const value = newValue.trim();
    if (!name || !value) return;
    if (custom.some(([k]) => k === name)) return onError(`There is already a property "${name}": change its value in its row.`);
    if (setCustom([...custom, [name, value]])) {
      setNewName("");
      setNewValue("");
    }
  };
  return (
    <section className="panel part-properties" aria-label="Part properties" data-testid="part-props">
      <button type="button" className="part-properties-head" onClick={toggle} aria-expanded={open} data-testid="part-props-toggle">
        <Icon name="properties" />
        <h2>Part properties</h2>
        <span className="muted small">{props.partNumber ? `${props.partNumber}${props.revision ? ` rev ${props.revision}` : ""}` : "title block, cut list, STEP"}</span>
        <Icon name={open ? "up" : "down"} />
      </button>
      {open && (
        <div className="part-properties-body">
          {!doc && <p className="muted small">Fix the document's JSON to edit its properties.</p>}
          {doc &&
            PROPERTY_FIELDS.map(([key, label, example]) => (
              <label key={key} className="part-property">
                <span>{label}</span>
                <PropertyInput value={props[key] ?? ""} placeholder={example} label={label} testId={`part-prop-${key}`} onCommit={(v) => set({ [key]: v || null })} />
              </label>
            ))}
          {doc && (
            <div className="part-custom" data-testid="part-props-custom">
              {custom.map(([name, value], i) => (
                <div key={name} className="part-custom-row">
                  <PropertyInput
                    value={name}
                    label="Property name"
                    testId={`part-prop-custom-name-${i}`}
                    onCommit={(to) => {
                      if (!to) return setCustom(custom.filter((_, j) => j !== i));
                      if (to !== name && custom.some(([k]) => k === to)) return onError(`There is already a property "${to}".`);
                      setCustom(custom.map((e, j) => (j === i ? [to, e[1]] : e)));
                    }}
                  />
                  <PropertyInput value={value} label={`${name} value`} testId={`part-prop-custom-value-${i}`} onCommit={(v) => setCustom(v ? custom.map((e, j) => (j === i ? [e[0], v] : e)) : custom.filter((_, j) => j !== i))} />
                  <button type="button" className="icon-button" aria-label={`Remove ${name}`} title={`Remove ${name}`} onClick={() => setCustom(custom.filter((_, j) => j !== i))} data-testid={`part-prop-custom-remove-${i}`}>
                    <Icon name="x" />
                  </button>
                </div>
              ))}
              <div className="part-custom-row new">
                <input value={newName} placeholder="New: name" aria-label="New property name" onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addCustom()} data-testid="part-prop-custom-new-name" />
                <input value={newValue} placeholder="value" aria-label="New property value" onChange={(e) => setNewValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addCustom()} data-testid="part-prop-custom-new-value" />
                <button type="button" className="icon-button" aria-label="Add the property" title="Add the property" disabled={!newName.trim() || !newValue.trim()} onClick={addCustom} data-testid="part-prop-custom-add">
                  <Icon name="plus" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

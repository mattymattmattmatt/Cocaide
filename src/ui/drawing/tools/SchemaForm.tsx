// The property panel drawn from a schema (Phase Q wave Q2B): one row per
// field, the same for every kind of annotation. A text or number field
// commits on Enter or when it loses focus; a choice or a tick at once; a
// reference field (a GeoRef) is typed, chosen, or picked on the sheet: its
// pick button arms it, and the next click on the sheet's geometry fills it.

import { useState } from "react";
import { Icon } from "../../icons";
import { choicesOf, readField, shownFields, writeField, type PropField, type PropSchema, type SchemaEnv } from "./schema";

export interface SchemaFormProps {
  schema: PropSchema;
  value: Record<string, unknown>;
  env: SchemaEnv;
  /** The test-id prefix ("prop-dimension"). */
  prefix: string;
  /** A field's patch (null removes a key); returns the error when the document refused it. */
  onPatch(patch: Record<string, unknown>): string | null;
  /** The reference field armed to take the next pick on the sheet, and arming one (null disarms). */
  armed?: string | null;
  onArm?(field: PropField | null): void;
}

export function SchemaForm({ schema, value, env, prefix, onPatch, armed, onArm }: SchemaFormProps) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const commit = (f: PropField, input: string | boolean) => {
    const choices = f.kind === "select" ? choicesOf(f, env, value) : undefined;
    const r = writeField(value, f, input, choices);
    if ("error" in r) return setErrors((e) => ({ ...e, [f.key]: r.error }));
    if (String(readField(value, f)) === String(input)) return setErrors((e) => ({ ...e, [f.key]: "" }));
    const problem = onPatch(r.patch);
    setErrors((e) => ({ ...e, [f.key]: problem ?? "" }));
  };
  return (
    <div className="schema-form">
      {shownFields(schema, value).map((f) => {
        const id = f.testId ?? `${prefix}-${f.key.replace(/\./g, "-")}`;
        const shown = readField(value, f);
        const error = errors[f.key];
        let input: React.ReactNode;
        if (f.kind === "bool") {
          input = <input type="checkbox" checked={shown === true} onChange={(e) => commit(f, e.target.checked)} data-testid={id} />;
        } else if (f.kind === "select") {
          const choices = choicesOf(f, env, value);
          input = (
            <select value={String(shown)} onChange={(e) => commit(f, e.target.value)} data-testid={id}>
              {f.optional && <option value="">{f.placeholder ?? "automatic"}</option>}
              {!f.optional && shown === "" && <option value="">choose…</option>}
              {shown !== "" && !choices.some((c) => c.value === shown) && <option value={String(shown)}>{String(shown)}</option>}
              {choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          );
        } else if (f.kind === "textarea") {
          input = <textarea defaultValue={String(shown)} key={String(shown)} rows={3} placeholder={f.placeholder} onBlur={(e) => commit(f, e.target.value)} data-testid={id} />;
        } else {
          const choices = f.kind === "ref" ? choicesOf(f, env, value) : [];
          const list = choices.length ? `${id}-list` : undefined;
          input = (
            <span className={`schema-input${f.kind === "ref" ? " ref" : ""}`}>
              <input
                type="text"
                defaultValue={String(shown)}
                key={String(shown)}
                placeholder={f.placeholder}
                list={list}
                spellCheck={false}
                onBlur={(e) => commit(f, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") {
                    (e.target as HTMLInputElement).value = String(shown);
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                data-testid={id}
              />
              {list && (
                <datalist id={list}>
                  {choices.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </datalist>
              )}
              {f.kind === "ref" && onArm && (
                <button
                  type="button"
                  className={`schema-pick${armed === f.key ? " on" : ""}`}
                  aria-pressed={armed === f.key}
                  title={armed === f.key ? "Click the geometry on the sheet (Esc stops)" : "Pick it on the sheet"}
                  onClick={() => onArm(armed === f.key ? null : f)}
                  data-testid={`${id}-pick`}
                >
                  <Icon name="select" size={14} />
                </button>
              )}
            </span>
          );
        }
        return (
          <label className={`field schema-field${error ? " invalid" : ""}`} key={f.key} title={f.help}>
            <span className="field-label">{f.label}</span>
            {input}
            {error && (
              <span className="field-error" role="alert">
                {error}
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}

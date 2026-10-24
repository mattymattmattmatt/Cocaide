// An import's properties: the file (name, size, what wrote it) and Replace
// file…, the bodies it made, the first body's name, and where it sits: turned
// about X, then Y, then Z (quarter-turn buttons for a file drawn Y-up), then
// moved by At. The rest of the part works on these bodies as on any.

import { Field, TextInput, Vec3Input, type NumberValue } from "../../ui/fields";
import { Icon } from "../../ui/icons";
import { pickFile } from "../../ui/files/pick";
import { stepSizeProblem } from "../../ui/files/plan";
import type { FieldProps } from "../../ui/props/spec";
import type { UiOp } from "../uiDefs";
import { importBodies, importSolidCount, sizeText } from "./doc";
import { stepProblem, WARN_STEP_CHARS } from "./stepText";

type Raw = Record<string, unknown>;

/** What wrote the file and in which schema, from its header ("AP214"), when it says. */
export function stepHeader(data: string): { schema?: string; system?: string } {
  const head = data.slice(0, 4096);
  const schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/.exec(head)?.[1] ?? "";
  const ap = /AUTOMOTIVE_DESIGN/i.test(schema) ? "AP214" : /CONFIG_CONTROL_DESIGN/i.test(schema) ? "AP203" : /AP242|MANAGED_MODEL_BASED_3D_ENGINEERING/i.test(schema) ? "AP242" : schema || undefined;
  // FILE_NAME(name, time, (author), (organisation), preprocessor, originating system, authorisation)
  const fileName = /FILE_NAME\s*\(([\s\S]*?)\)\s*;/.exec(head)?.[1] ?? "";
  const strings = [...fileName.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  const system = strings[strings.length - 2] || strings[strings.length - 3] || undefined;
  return { ...(ap ? { schema: ap } : {}), ...(system ? { system } : {}) };
}

const add = (v: NumberValue[], k: number, d: number): number[] => v.map((x, i) => (i === k ? (((Number(x) || 0) + d + 180) % 360 + 360) % 360 - 180 : Number(x) || 0));

function ImportEditor(p: FieldProps) {
  const f = p.f as Raw;
  const data = typeof f.data === "string" ? f.data : "";
  const count = importSolidCount(f);
  const names = importBodies(f, count);
  const built = new Set(p.view?.bodies.map((b) => b.name) ?? []);
  const volumes = new Map((p.view?.measurements?.bodies ?? []).map((b) => [b.name, b.volume]));
  const header = stepHeader(data);
  const rotate = (Array.isArray(f.rotate) ? f.rotate : [0, 0, 0]) as NumberValue[];
  const at = (Array.isArray(f.at) ? f.at : [0, 0, 0]) as NumberValue[];
  const vec = (key: "at" | "rotate", v: NumberValue[]) => {
    const zero = v.every((x) => x === 0);
    const problem = p.update({ [key]: zero ? null : v });
    if (problem) p.setError(problem);
  };
  const replace = async () => {
    const file = await pickFile(".step,.stp,.STEP,.STP");
    if (!file) return;
    const text = await file.text();
    const size = stepSizeProblem(text.length);
    if (size.refuse) return p.setError(size.refuse);
    const problem = stepProblem(text);
    if (problem) return p.setError(`${file.name} ${problem}.`);
    const err = p.update({ data: text, fileName: file.name });
    p.setError(err ? err : null);
  };
  return (
    <>
      <Field label="File" block>
        <span className="import-file" data-testid="prop-import-file">
          <Icon name="import" />
          <span className="import-file-name">{String(f.fileName ?? "")}</span>
          <span className="muted">
            {sizeText(data.length)}
            {header.schema ? ` · STEP ${header.schema}` : ""}
            {header.system ? ` · ${header.system}` : ""}
          </span>
        </span>
        <button type="button" className="link-button" onClick={() => void replace()} data-testid="prop-import-replace" title="Read another STEP file into this import: the bodies keep their names and place, and the features after it rebuild on the new shape">
          Replace file…
        </button>
        {data.length > WARN_STEP_CHARS && <span className="hint warn">The part holds the whole file ({sizeText(data.length)}): saving, undo and rebuilds are slower. Keep imports to a few MB where you can.</span>}
      </Field>
      <Field label={count === 1 ? "Body" : `Bodies (${count})`} block hint="Each solid in the file is a body: holes, fillets, cuts, members and patterns work on it like on any body.">
        <ul className="import-bodies" data-testid="prop-import-bodies">
          {names.map((n, i) => (
            <li key={n} data-testid={`prop-import-body-${i}`} className={built.has(n) ? "" : "missing"}>
              <span>{n}</span>
              <span className="muted">{built.has(n) ? (volumes.has(n) ? `${Math.round(volumes.get(n)!).toLocaleString("en-US")} mm³` : "built") : "not built"}</span>
            </li>
          ))}
        </ul>
      </Field>
      <Field label="Body name" hint={count > 1 ? `The others are ${names[0]}_2, ${names[0]}_3 … unless renamed in Bodies` : undefined}>
        <TextInput
          value={names[0]}
          testId="prop-import-name"
          onCommit={(to) => {
            const err = p.rename(names[0], to);
            if (typeof err === "string") p.setError(err);
          }}
        />
      </Field>
      <Field label="Turn" unit="°" hint="About X, then Y, then Z, about the file's origin. A file drawn Y-up stands up with 90° about X.">
        <Vec3Input value={rotate} onCommit={(v) => vec("rotate", v)} testId="prop-import-rotate" />
      </Field>
      <div className="import-turns">
        {(["X", "Y", "Z"] as const).map((axis, k) => (
          <button key={axis} type="button" onClick={() => vec("rotate", add(rotate, k, 90))} data-testid={`prop-import-turn-${axis.toLowerCase()}`} title={`Turn a further 90° about ${axis}`}>
            +90° {axis}
          </button>
        ))}
      </div>
      <Field label="At" unit="mm" hint="Where the file's origin goes, after turning">
        <Vec3Input value={at} onCommit={(v) => vec("at", v)} testId="prop-import-at" />
      </Field>
    </>
  );
}

export const ui: UiOp = {
  op: "import",
  label: "Import",
  icon: "import",
  Editor: ImportEditor,
  summary: (f) => {
    const n = importSolidCount(f);
    return `${typeof f.fileName === "string" ? f.fileName : "STEP"}${n > 1 ? ` · ${n} bodies` : ""}`;
  },
};

// Fields every pattern's editor shares: the features it repeats (ticked; one
// is "feature", several "features") and its instances, ticked to make or
// unticked to skip. Also used by the mirror's and the sketch-driven
// pattern's editors.

import { Field } from "../../ui/fields";
import { PATTERNABLE } from "../../ui/model/tools/pattern";
import type { FieldProps, FieldSpec } from "../../ui/props/spec";
import { seedsOf, seedsPatch, skipPatch, type InstanceRow } from "./instances";

type Raw = Record<string, unknown>;

/** The features to repeat, ticked among the earlier ones a pattern can repeat. */
export function seedsField(testId: string, label = "Features"): FieldSpec {
  return {
    kind: "features",
    key: "features",
    label,
    ops: PATTERNABLE,
    testId,
    hint: "Each ticked feature is repeated the same way",
    get: (f) => seedsOf(f),
    set: (list) => {
      const patch = seedsPatch(list);
      if (typeof patch === "string") throw new Error(patch);
      return patch;
    },
  };
}

/** The instances as tick boxes: ticked ones are made, unticked ones skipped (instance 1, the original, always stays). */
export function InstanceChecks({ p, rows, testId }: { p: FieldProps; rows: InstanceRow[]; testId: string }) {
  const toggle = (n: number, on: boolean) => {
    const patch = skipPatch(p.f, rows, n, on);
    if (typeof patch === "string") return p.setError(patch);
    p.setError(null);
    p.update(patch);
  };
  const skipped = rows.filter((r) => r.skipped).length;
  return (
    <Field label="Instances" block hint={skipped ? `${skipped} skipped: untick one to leave it out, tick it to bring it back` : "Untick an instance to leave it out (1 is the original)"}>
      <span className="body-checks instance-checks" data-testid={testId}>
        {rows.map((r) => (
          <label key={r.n} className="check" title={r.n === 1 ? "The original feature" : r.skipped ? "Skipped" : "Made"}>
            <input type="checkbox" checked={!r.skipped} disabled={r.n === 1} onChange={(e) => toggle(r.n, e.target.checked)} data-testid={`${testId}-${r.n}`} />
            {r.label}
          </label>
        ))}
      </span>
    </Field>
  );
}

/** The instance tick boxes as a field, for patterns whose rows come from the feature. */
export function skipField(rowsOf: (f: Raw, p: FieldProps) => InstanceRow[], testId = "prop-pattern-skip"): FieldSpec {
  return { kind: "custom", key: "skip", label: "Instances", render: (p) => <InstanceChecks p={p} rows={rowsOf(p.resolved, p)} testId={testId} /> };
}

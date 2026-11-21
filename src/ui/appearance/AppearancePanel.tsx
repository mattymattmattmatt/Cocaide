// The Appearance section: how the part looks, how what is selected looks, and
// every colour the part sets (bodies and features), each a click from the
// picker and one from going back to what it inherits.

import type { MouseEvent } from "react";
import { asAppearance, PartAppearances } from "../../appearance";
import type { RebuildView } from "../../worker/protocol";
import { Icon } from "../icons";
import { Section } from "../Section";
import { AppearanceChip, describeAppearance, sourceWords } from "./AppearancePicker";
import { colourable, lookInfo, type LookTarget } from "./targets";

interface Props {
  doc: Record<string, unknown>;
  view: RebuildView | null;
  /** The feature selected in the tree, if any. */
  selectedFeature: string | null;
  /** The faces selected in the view. */
  selectedFaces: readonly number[];
  onOpen(target: LookTarget, x: number, y: number): void;
  onReset(target: LookTarget): void;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const key = (t: LookTarget) => (t.kind === "part" ? "part" : t.kind === "body" ? `body:${t.body}` : `feature:${t.feature}`);

export function AppearancePanel({ doc, view, selectedFeature, selectedFaces, onOpen, onReset }: Props) {
  const features = Array.isArray(doc.features) ? (doc.features as Record<string, unknown>[]) : [];
  const many = (view?.bodies.length ?? 0) > 1;
  // What the selection is about: the selected feature, else the body and the feature of the faces picked.
  const about: LookTarget[] = [];
  const add = (t: LookTarget) => !about.some((x) => key(x) === key(t)) && about.push(t);
  if (selectedFeature && colourable(features.find((f) => f.id === selectedFeature)?.op)) add({ kind: "feature", feature: selectedFeature });
  for (const i of selectedFaces.slice(0, 50)) {
    const f = view?.faces[i];
    if (!f) continue;
    if (many && f.body) add({ kind: "body", body: f.body });
    if (f.createdBy && colourable(features.find((g) => g.id === f.createdBy)?.op)) add({ kind: "feature", feature: f.createdBy });
  }
  // Every colour set: the bodies' own and the features'.
  const set: LookTarget[] = [
    ...Object.keys(isObject(doc.bodyAppearances) ? doc.bodyAppearances : {}).map((body): LookTarget => ({ kind: "body", body })),
    ...features.filter((f) => typeof f.id === "string" && asAppearance(f.appearance)).map((f): LookTarget => ({ kind: "feature", feature: f.id as string })),
  ].filter((t) => !about.some((x) => key(x) === key(t)));
  const part = new PartAppearances(doc);

  const line = (t: LookTarget, label?: string) => {
    const info = lookInfo(doc, view, t);
    const showing = info.own ?? info.inherited?.appearance ?? null;
    const open = (e: MouseEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      onOpen(t, r.left, r.bottom + 4);
    };
    const name = label ?? (t.kind === "part" ? "Part" : t.kind === "body" ? t.body : t.feature);
    const kind = t.kind === "part" ? "" : t.kind === "body" ? "body" : "feature";
    return (
      <div className="look-line" key={key(t)} data-testid={`look-line-${key(t)}`}>
        <button type="button" className="look-button" onClick={open} aria-label={`Appearance of ${t.kind === "part" ? "the part" : `${kind} ${name}`}`} data-testid={`look-open-${key(t)}`}>
          <AppearanceChip look={showing} fallback={info.fallback} inherited={!info.own} size={18} />
        </button>
        <button type="button" className="look-name link-like" onClick={open} style={{ border: "none", background: "none", padding: 0, textAlign: "left", cursor: "pointer", color: "inherit" }}>
          <span>
            {name}
            {kind && <span className="muted"> · {kind}</span>}
          </span>
          <span className="muted">{info.own ? describeAppearance(info.own) : `From ${sourceWords(info.inherited)}`}</span>
        </button>
        {info.own ? (
          <button type="button" className="icon" onClick={() => onReset(t)} title={`Use ${sourceWords(info.inherited)} again`} aria-label={`Clear the colour of ${name}`} data-testid={`look-clear-${key(t)}`}>
            <Icon name="x" size={13} />
          </button>
        ) : (
          <span />
        )}
      </div>
    );
  };

  return (
    <Section title="Appearance" className="appearance-panel" testId="appearance-panel" aside={part.any ? undefined : <span className="muted small">default colours</span>}>
      {line({ kind: "part" })}
      {about.length > 0 && (
        <>
          <h2>Selected</h2>
          {about.map((t) => line(t))}
        </>
      )}
      {set.length > 0 && (
        <>
          <h2>Coloured</h2>
          {set.map((t) => line(t))}
        </>
      )}
    </Section>
  );
}

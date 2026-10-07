// The profile card (Phase I): opens when a sketch ticked "Weldment profile"
// is finished. It names the profile, lists its sizes (the parameters its
// dimensions use are the size parameters), says what sits on a member's line,
// and tags it. Every size is measured here: area, kg/m and the envelope.

import { useMemo, useState } from "react";
import type { RawDocument } from "../doc/commands";
import type { ProfileDef, ProfileSize } from "../doc/types";
import { kgPerMetre, sectionAt, sizedEntities, STEEL_DENSITY, suggestTags } from "../geom/section";
import { designationFor, nameTaken, profileFromSketch, sketchParameters, type LibraryEntry } from "../weldment/library";
import { ProfileDrawing } from "./ProfileDrawing";

interface Props {
  doc: RawDocument;
  sketchId: string;
  library: LibraryEntry[];
  onSave(def: ProfileDef, favourite: boolean, previous: LibraryEntry | undefined): void;
  onClose(): void;
}

const n = (x: number, digits = 3) => x.toLocaleString("en-US", { maximumFractionDigits: digits });

/** A row of the sizes table: its values as typed, so "4." can become "4.5". */
interface Row {
  key: number;
  designation: string;
  text: Record<string, string>;
}

let rowKey = 0;
const row = (designation: string, values: Record<string, number>): Row => ({
  key: ++rowKey,
  designation,
  text: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Number.isFinite(v) ? String(v) : ""])),
});

export function ProfileCard({ doc, sketchId, library, onSave, onClose }: Props) {
  const sketch = doc.features.find((f) => f.id === sketchId) as Record<string, unknown> | undefined;
  const mark = sketch?.profile as { name: string; library?: { id: string } } | undefined;
  const previous = library.find((e) => e.id === mark?.library?.id);
  const params = useMemo(() => (sketch ? sketchParameters(sketch, doc) : {}), [sketch, doc]);
  const names = Object.keys(params);
  const density = (doc.material as { densityKgPerM3?: number } | undefined)?.densityKgPerM3 ?? STEEL_DENSITY;

  const [name, setName] = useState(previous?.name ?? mark?.name ?? "");
  const [rows, setRows] = useState<Row[]>(() => {
    if (previous) {
      // The sketch's current values are the first size, whatever the library had. Other sizes keep the parameters the sketch still uses.
      const rest = previous.sizes.slice(1).filter((s) => names.every((k) => k in s.values));
      return [row(previous.sizes[0]?.designation ?? "", params), ...rest.map((s) => row(s.designation, Object.fromEntries(names.map((k) => [k, s.values[k]]))))];
    }
    return [row("", params)];
  });
  // The first size is the sketch's own values; the others are as typed.
  const sizes: ProfileSize[] = rows.map((r, i) => ({
    designation: r.designation,
    values: i === 0 ? params : Object.fromEntries(names.map((k) => [k, (r.text[k] ?? "").trim() === "" ? NaN : Number(r.text[k])])),
  }));
  const [anchor, setAnchor] = useState<ProfileDef["anchor"]>(previous?.anchor ?? "centroid");
  const [material, setMaterial] = useState(previous?.material ?? "");
  const [favourite, setFavourite] = useState(previous?.favourite ?? false);
  const [extraTags, setExtraTags] = useState("");
  const [shown, setShown] = useState(0);

  // A size left without a designation gets one from the name and its values.
  const named = sizes.map((s) => ({ ...s, designation: s.designation.trim() || designationFor(name.trim() || "profile", s.values) }));
  // The profile as it would be saved: every size measured.
  const draft = sketch ? profileFromSketch(sketch, doc, { name: name || "profile", sizes: named, anchor, tags: [], material }) : null;
  const measured = draft ? draft.sizes.map((s) => sectionAt(draft, s.designation)) : [];
  const first = measured[0]?.ok ? measured[0].props : null;
  const suggested = first ? suggestTags(first) : [];
  const [picked, setPicked] = useState<Set<string> | null>(previous ? new Set(previous.tags) : null);
  const chosen = picked ?? new Set(suggested);
  const tags = [...new Set([...suggested.filter((t) => chosen.has(t)), ...[...chosen].filter((t) => !suggested.includes(t)), ...extraTags.split(",").map((t) => t.trim()).filter(Boolean)])];
  const drawn = draft && draft.sizes[shown] ? sizedEntities(draft, draft.sizes[shown]) : null;

  const problems: string[] = [];
  if (!sketch) problems.push(`no sketch "${sketchId}"`);
  if (!name.trim()) problems.push("Name the profile.");
  else if (nameTaken(library, name, previous?.id)) problems.push(`The library already has a profile named ${name.trim()}: choose another name, or edit that one.`);
  const designations = named.map((s) => s.designation);
  if (new Set(designations).size !== designations.length) problems.push("Two sizes have the same designation.");
  named.forEach((s, i) => {
    const bad = names.filter((k) => !(s.values[k] > 0));
    if (bad.length) problems.push(`${s.designation}: ${bad.join(" and ")} must be more than 0.`);
    else if (measured[i] && !measured[i].ok) problems.push(`${s.designation}: ${(measured[i] as { error: string }).error}`);
  });

  const setRow = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = () => {
    if (problems.length || !sketch) return;
    onSave(profileFromSketch(sketch, doc, { name, sizes: named, anchor, tags, material }), favourite, previous);
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal profile-card"
        role="dialog"
        aria-label="Weldment profile"
        data-testid="profile-card"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="profile-card-head">
          <h2>Weldment profile</h2>
          <button type="button" className={`star${favourite ? " on" : ""}`} aria-pressed={favourite} aria-label="Favourite" onClick={() => setFavourite(!favourite)} data-testid="profile-favourite">
            {favourite ? "★" : "☆"}
          </button>
        </div>
        <div className="profile-card-top">
          {drawn?.ok ? <ProfileDrawing entities={drawn.entities} size={112} testId="profile-drawing" /> : <div className="profile-drawing empty" />}
          <div className="profile-card-fields">
            <label className="field">
              <span className="field-label">Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="SHS" autoFocus data-testid="profile-name" />
            </label>
            <div className="muted small" data-testid="profile-parameters">
              {names.length
                ? `Size parameters: ${names.map((k) => `${k} = ${n(params[k])}`).join(", ")} (from the sketch's dimensions)`
                : "One size: write a dimension as =b to make a family of sizes."}
            </div>
            {previous && <div className="muted small">Saves version {previous.version + 1} of {previous.name}.</div>}
          </div>
        </div>
        <table className="profile-sizes" data-testid="profile-sizes">
          <thead>
            <tr>
              <th>Designation</th>
              {names.map((k) => (
                <th key={k}>{k}</th>
              ))}
              <th>Area</th>
              <th>kg/m</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const m = measured[i];
              const s = sizes[i];
              return (
                <tr key={r.key} className={shown === i ? "shown" : undefined} onClick={() => setShown(i)}>
                  <td>
                    <input
                      value={r.designation}
                      placeholder={designationFor(name.trim() || "profile", s.values)}
                      onChange={(e) => setRow(i, { designation: e.target.value })}
                      aria-label={`Size ${i + 1} designation`}
                      data-testid={`profile-size-${i}`}
                    />
                  </td>
                  {names.map((k) => (
                    <td key={k}>
                      <input
                        inputMode="decimal"
                        value={i === 0 ? String(params[k]) : (r.text[k] ?? "")}
                        disabled={i === 0}
                        title={i === 0 ? "The sketch's own values: change them in the sketch" : undefined}
                        onChange={(e) => setRow(i, { text: { ...r.text, [k]: e.target.value } })}
                        aria-label={`Size ${i + 1} ${k}`}
                        data-testid={`profile-size-${i}-${k}`}
                      />
                    </td>
                  ))}
                  <td className="num" data-testid={`profile-area-${i}`}>
                    {m?.ok ? `${n(m.props.area)} mm²` : "—"}
                  </td>
                  <td className="num" data-testid={`profile-kgm-${i}`}>
                    {m?.ok ? n(kgPerMetre(m.props.area, density), 2) : "—"}
                  </td>
                  <td>
                    {i > 0 && (
                      <button
                        type="button"
                        className="icon"
                        aria-label={`Remove size ${i + 1}`}
                        onClick={() => {
                          setRows(rows.filter((_, j) => j !== i));
                          setShown(0);
                        }}
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {names.length > 0 && (
          <button type="button" className="link" onClick={() => setRows([...rows, row("", sizes[sizes.length - 1].values)])} data-testid="profile-add-size">
            + Add a size
          </button>
        )}
        <div className="profile-row">
          <span className="field-label">On the member line</span>
          {(["centroid", "origin"] as const).map((a) => (
            <label key={a} className="check">
              <input type="radio" name="anchor" checked={anchor === a} onChange={() => setAnchor(a)} data-testid={`profile-anchor-${a}`} />
              {a === "centroid" ? "the centroid" : "the sketch origin"}
            </label>
          ))}
        </div>
        <div className="profile-row">
          <span className="field-label">Tags</span>
          <span className="tag-chips" data-testid="profile-tags">
            {[...new Set([...suggested, ...chosen])].map((t) => (
              <button
                type="button"
                key={t}
                className={`chip${chosen.has(t) ? " on" : ""}`}
                aria-pressed={chosen.has(t)}
                onClick={() => {
                  const next = new Set(chosen);
                  if (next.has(t)) next.delete(t);
                  else next.add(t);
                  setPicked(next);
                }}
              >
                {t}
              </button>
            ))}
          </span>
          <input value={extraTags} onChange={(e) => setExtraTags(e.target.value)} placeholder="more tags, comma separated" data-testid="profile-extra-tags" />
        </div>
        <label className="field">
          <span className="field-label">Material note</span>
          <input value={material} onChange={(e) => setMaterial(e.target.value)} placeholder="S355 (a note: mass uses the part's density)" data-testid="profile-material" />
        </label>
        {problems.length > 0 && (
          <div className="command-error" role="alert" data-testid="profile-problems">
            {problems.join(" ")}
          </div>
        )}
        <div className="modal-buttons">
          <button type="button" onClick={onClose}>
            Not now
          </button>
          <span className="sep" />
          <button type="submit" className="primary" disabled={problems.length > 0} data-testid="profile-save">
            Save to the section library
          </button>
        </div>
      </form>
    </div>
  );
}

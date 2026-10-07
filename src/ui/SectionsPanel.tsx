// The section library (Phase I), as a tab beside Properties: every weldment
// profile saved in this browser, searchable by name, designation or tag,
// favourites first. A size's "+ Member" puts a copy of the profile in the part
// and adds a member of that size, as one undo step.

import { useMemo, useRef, useState } from "react";
import type { RawDocument } from "../doc/commands";
import type { ProfileDef } from "../doc/types";
import { kgPerMetre, sectionAt, sizedEntities } from "../geom/section";
import { searchLibrary, type LibraryEntry } from "../weldment/library";
import { ProfileDrawing } from "./ProfileDrawing";

interface Props {
  entries: LibraryEntry[];
  /** null: the library could not be read (storage blocked). */
  error: string | null;
  doc: RawDocument | null;
  density: number;
  /** The entry just saved from a sketch: shown first, outlined. */
  highlight: string | null;
  onAddMember(entry: LibraryEntry, designation: string): void;
  onFavourite(entry: LibraryEntry): void;
  onDelete(entry: LibraryEntry): void;
  onUpdatePart(entry: LibraryEntry): void;
  onExport(): void;
  onImport(file: File): void;
}

const n = (x: number, digits = 3) => x.toLocaleString("en-US", { maximumFractionDigits: digits });

export function SectionsPanel({ entries, error, doc, density, highlight, onAddMember, onFavourite, onDelete, onUpdatePart, onExport, onImport }: Props) {
  const [query, setQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const found = useMemo(() => searchLibrary(entries, query), [entries, query]);
  const copies = (doc?.profiles ?? {}) as Record<string, ProfileDef>;

  return (
    <section className="panel sections" aria-label="Section library" data-testid="sections">
      <div className="sections-head">
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, size or tag" aria-label="Search the section library" data-testid="sections-search" />
        <button onClick={onExport} disabled={!entries.length} title="Save the library as a file" data-testid="sections-export">
          Export
        </button>
        <button onClick={() => file.current?.click()} title="Merge a library file in" data-testid="sections-import">
          Import
        </button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          data-testid="sections-import-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImport(f);
            e.target.value = "";
          }}
        />
      </div>
      {error && (
        <div className="command-error" role="alert">
          {error}
        </div>
      )}
      {!entries.length && !error && (
        <p className="muted small" data-testid="sections-empty">
          No sections yet. Draw one as a normal sketch, tick <strong>Weldment profile</strong> and finish it: it goes in here, for this part and the
          next.
        </p>
      )}
      {entries.length > 0 && !found.length && <p className="muted small">Nothing matches “{query}”.</p>}
      <ul className="section-list">
        {found.map((e) => {
          const first = e.sizes[0] ? sizedEntities(e, e.sizes[0]) : null;
          const copy = Object.values(copies).find((p) => p.library?.id === e.id);
          return (
            <li key={e.id} className={`section-entry${highlight === e.id ? " highlight" : ""}`} data-testid={`section-${e.name}`}>
              <div className="section-top">
                {first?.ok ? <ProfileDrawing entities={first.entities} size={56} /> : <div className="profile-drawing empty" />}
                <div className="section-title">
                  <div>
                    <strong>{e.name}</strong> <span className="muted small">v{e.version}</span>
                  </div>
                  <div className="tag-chips small">
                    {e.tags.map((t) => (
                      <button key={t} className="chip" onClick={() => setQuery(t)} title={`Show sections tagged ${t}`}>
                        {t}
                      </button>
                    ))}
                    {e.material && <span className="muted small">{e.material}</span>}
                  </div>
                </div>
                <button className={`star${e.favourite ? " on" : ""}`} aria-pressed={e.favourite} aria-label={`Favourite ${e.name}`} onClick={() => onFavourite(e)} data-testid={`section-favourite-${e.name}`}>
                  {e.favourite ? "★" : "☆"}
                </button>
              </div>
              <table className="section-sizes">
                <tbody>
                  {e.sizes.map((s) => {
                    const m = sectionAt(e, s.designation);
                    return (
                      <tr key={s.designation} data-testid={`section-size-${s.designation}`}>
                        <td>{s.designation}</td>
                        <td className="num">{m.ok ? `${n(m.props.area, 1)} mm²` : "—"}</td>
                        <td className="num">{m.ok ? `${n(kgPerMetre(m.props.area, density), 2)} kg/m` : ""}</td>
                        <td>
                          <button className="small" onClick={() => onAddMember(e, s.designation)} disabled={!doc || !m.ok} title={m.ok ? `Add a member of ${s.designation} to the part` : m.error} data-testid={`section-add-${s.designation}`}>
                            + Member
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="section-foot muted small">
                {copy ? (
                  copy.library!.version < e.version ? (
                    <>
                      This part has v{copy.library!.version}.{" "}
                      <button className="link" onClick={() => onUpdatePart(e)} data-testid={`section-update-${e.name}`}>
                        Update the part's copy
                      </button>
                    </>
                  ) : (
                    <span>In this part</span>
                  )
                ) : (
                  <span>{e.uses ? `${e.uses} member${e.uses === 1 ? "" : "s"} made` : "Not used yet"}</span>
                )}
                <span className="sep" />
                {confirmDelete === e.id ? (
                  <>
                    <span>Parts keep their copies.</span>
                    <button className="link danger" onClick={() => onDelete(e)} data-testid={`section-delete-confirm-${e.name}`}>
                      Delete
                    </button>
                    <button className="link" onClick={() => setConfirmDelete(null)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <button className="link" onClick={() => setConfirmDelete(e.id)} data-testid={`section-delete-${e.name}`}>
                    Delete…
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

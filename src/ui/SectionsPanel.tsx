// The section library (Phase I), as a tab beside Properties: every weldment
// profile saved in this browser, searchable by name, designation or tag,
// favourites first. A size's "+ Member" puts a copy of the profile in the part
// and adds a member of that size, as one undo step.

import { useMemo, useRef, useState } from "react";
import type { RawDocument } from "../doc/commands";
import type { ProfileDef } from "../doc/types";
import { kgPerMetre, sectionAt, sizedEntities } from "../geom/section";
import {
  matchingSizes,
  searchLibrary,
  type LibraryEntry,
} from "../weldment/library";
import { STANDARD_GROUPS } from "../weldment/standard";
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

const MINE = "My sections";

/** Section properties, worked out once per entry and size. */
const measured = new WeakMap<
  LibraryEntry,
  Map<string, ReturnType<typeof sectionAt>>
>();
function propsOf(e: LibraryEntry, designation: string) {
  let m = measured.get(e);
  if (!m) measured.set(e, (m = new Map()));
  let r = m.get(designation);
  if (!r) m.set(designation, (r = sectionAt(e, designation)));
  return r;
}

const n = (x: number, digits = 3) =>
  x.toLocaleString("en-US", { maximumFractionDigits: digits });

export function SectionsPanel({
  entries,
  error,
  doc,
  density,
  highlight,
  onAddMember,
  onFavourite,
  onDelete,
  onUpdatePart,
  onExport,
  onImport,
}: Props) {
  const [query, setQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [group, setGroup] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const file = useRef<HTMLInputElement>(null);
  const found = useMemo(
    () =>
      searchLibrary(entries, query).filter(
        (e) => !group || (e.group ?? MINE) === group,
      ),
    [entries, query, group],
  );
  const groups = useMemo(() => {
    const order = [MINE, ...STANDARD_GROUPS] as string[];
    const by = new Map<string, LibraryEntry[]>();
    for (const e of found) {
      const g = e.group ?? MINE;
      if (!order.includes(g)) order.push(g);
      by.set(g, [...(by.get(g) ?? []), e]);
    }
    return order
      .filter((g) => by.has(g))
      .map((g) => ({ name: g, entries: by.get(g)! }));
  }, [found]);
  const mine = entries.filter((e) => !e.builtin);
  const toggle = (id: string) =>
    setOpen((o) => {
      const x = new Set(o);
      if (x.has(id)) x.delete(id);
      else x.add(id);
      return x;
    });
  const copies = (doc?.profiles ?? {}) as Record<string, ProfileDef>;

  return (
    <section
      className="panel sections"
      aria-label="Section library"
      data-testid="sections"
    >
      <div className="sections-head">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, size or tag"
          aria-label="Search the section library"
          data-testid="sections-search"
        />
        <select
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          aria-label="Show one standard"
          data-testid="sections-group"
        >
          <option value="">All</option>
          <option value={MINE}>{MINE}</option>
          {STANDARD_GROUPS.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <button
          onClick={onExport}
          disabled={!mine.length}
          title="Save the library as a file"
          data-testid="sections-export"
        >
          Export
        </button>
        <button
          onClick={() => file.current?.click()}
          title="Merge a library file in"
          data-testid="sections-import"
        >
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
      {!mine.length && !error && (
        <p className="muted small" data-testid="sections-empty">
          No sections yet. Draw one as a normal sketch, tick{" "}
          <strong>Weldment profile</strong> and finish it: it goes in here, for
          this part and the next. The standard sections below are always here.
        </p>
      )}
      {entries.length > 0 && !found.length && (
        <p className="muted small">Nothing matches “{query}”.</p>
      )}
      {groups.map((g) => (
        <div
          key={g.name}
          className="section-group"
          data-testid={`sections-group-${g.name}`}
        >
          <h4 className="section-group-head muted small">{g.name}</h4>
          <ul className="section-list">
            {g.entries.map((e) => {
              const first = e.sizes[0] ? sizedEntities(e, e.sizes[0]) : null;
              const copy = Object.values(copies).find(
                (p) => p.library?.id === e.id,
              );
              const sizes = query.trim() ? matchingSizes(e, query) : e.sizes;
              const shown =
                !e.builtin ||
                open.has(e.id) ||
                (query.trim() !== "" && sizes.length <= 40);
              const kgDensity = e.density ?? density;
              return (
                <li
                  key={e.id}
                  className={`section-entry${highlight === e.id ? " highlight" : ""}`}
                  data-testid={`section-${e.name}`}
                >
                  <div className="section-top">
                    {first?.ok ? (
                      <ProfileDrawing entities={first.entities} size={56} />
                    ) : (
                      <div className="profile-drawing empty" />
                    )}
                    <div className="section-title">
                      <div>
                        <strong>{e.name}</strong>{" "}
                        <span className="muted small">v{e.version}</span>
                      </div>
                      <div className="tag-chips small">
                        {e.tags.map((t) => (
                          <button
                            key={t}
                            className="chip"
                            onClick={() => setQuery(t)}
                            title={`Show sections tagged ${t}`}
                          >
                            {t}
                          </button>
                        ))}
                        {e.material && (
                          <span className="muted small">{e.material}</span>
                        )}
                      </div>
                      {e.builtin && (
                        <button
                          className="link small"
                          onClick={() => toggle(e.id)}
                          aria-expanded={shown}
                          data-testid={`section-expand-${e.name}`}
                        >
                          {shown
                            ? "Hide sizes"
                            : `${sizes.length} size${sizes.length === 1 ? "" : "s"}`}
                        </button>
                      )}
                    </div>
                    <button
                      className={`star${e.favourite ? " on" : ""}`}
                      aria-pressed={e.favourite}
                      aria-label={`Favourite ${e.name}`}
                      onClick={() => onFavourite(e)}
                      data-testid={`section-favourite-${e.name}`}
                    >
                      {e.favourite ? "★" : "☆"}
                    </button>
                  </div>
                  {shown && (
                    <table className="section-sizes">
                      <tbody>
                        {sizes.map((s) => {
                          const m = propsOf(e, s.designation);
                          return (
                            <tr
                              key={s.designation}
                              data-testid={`section-size-${s.designation}`}
                            >
                              <td>{s.designation}</td>
                              <td className="num">
                                {m.ok ? `${n(m.props.area, 1)} mm²` : "—"}
                              </td>
                              <td className="num">
                                {m.ok
                                  ? `${n(kgPerMetre(m.props.area, kgDensity), 2)} kg/m`
                                  : ""}
                              </td>
                              <td>
                                <button
                                  className="small"
                                  onClick={() => onAddMember(e, s.designation)}
                                  disabled={!doc || !m.ok}
                                  title={
                                    m.ok
                                      ? `Add a member of ${s.designation} to the part`
                                      : m.error
                                  }
                                  data-testid={`section-add-${s.designation}`}
                                >
                                  + Member
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                  <div className="section-foot muted small">
                    {copy ? (
                      copy.library!.version < e.version ? (
                        <>
                          This part has v{copy.library!.version}.{" "}
                          <button
                            className="link"
                            onClick={() => onUpdatePart(e)}
                            data-testid={`section-update-${e.name}`}
                          >
                            Update the part's copy
                          </button>
                        </>
                      ) : (
                        <span>In this part</span>
                      )
                    ) : (
                      <span>
                        {e.uses
                          ? `${e.uses} member${e.uses === 1 ? "" : "s"} made`
                          : "Not used yet"}
                      </span>
                    )}
                    <span className="sep" />
                    {e.builtin ? (
                      <span>Standard</span>
                    ) : confirmDelete === e.id ? (
                      <>
                        <span>Parts keep their copies.</span>
                        <button
                          className="link danger"
                          onClick={() => onDelete(e)}
                          data-testid={`section-delete-confirm-${e.name}`}
                        >
                          Delete
                        </button>
                        <button
                          className="link"
                          onClick={() => setConfirmDelete(null)}
                        >
                          Keep
                        </button>
                      </>
                    ) : (
                      <button
                        className="link"
                        onClick={() => setConfirmDelete(e.id)}
                        data-testid={`section-delete-${e.name}`}
                      >
                        Delete…
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

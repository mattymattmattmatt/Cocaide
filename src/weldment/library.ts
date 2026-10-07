// The section library (Phase I): weldment profiles drawn in the sketcher and
// kept for any part. Pure: what an entry is, how one is made from a sketch,
// how the library is searched and ordered, and the copy a part keeps.

import { apply, nextId, type RawDocument } from "../doc/commands";
import { documentParameters, parameterRefs, type Parameters } from "../doc/parameters";
import type { ProfileDef, ProfileSize } from "../doc/types";
import { validateDocument } from "../doc/validate";
import { sectionAt } from "../geom/section";

export interface LibraryEntry extends ProfileDef {
  /** Stable across versions: a part's copy names it. */
  id: string;
  /** Goes up by one each time the profile is saved again. */
  version: number;
  favourite: boolean;
  /** How many members have been made with it, for ordering. */
  uses: number;
  updatedAt: string;
}

/** The parameters a sketch's dimensions use, with the part's values: its size parameters. */
export function sketchParameters(sketch: Record<string, unknown>, doc: unknown): Parameters {
  const params = documentParameters(doc);
  const out: Parameters = {};
  for (const name of parameterRefs({ entities: sketch.entities, constraints: sketch.constraints })) if (name in params) out[name] = params[name];
  return out;
}

/** A designation from a name and size values: "SHS 40x3". */
export function designationFor(name: string, values: Record<string, number>): string {
  const v = Object.values(values);
  return v.length ? `${name} ${v.map((x) => String(Math.round(x * 1000) / 1000)).join("x")}` : name;
}

/** A profile from a sketch in a part: its geometry, its dimensions as written, and the card's choices. */
export function profileFromSketch(
  sketch: Record<string, unknown>,
  doc: unknown,
  card: { name: string; sizes: ProfileSize[]; anchor: ProfileDef["anchor"]; tags: string[]; material?: string },
): ProfileDef {
  const def: ProfileDef = {
    name: card.name.trim(),
    entities: structuredClone(sketch.entities) as ProfileDef["entities"],
    parameters: sketchParameters(sketch, doc),
    sizes: card.sizes,
    anchor: card.anchor,
    tags: [...new Set(card.tags.map((t) => t.trim()).filter(Boolean))],
  };
  if (Array.isArray(sketch.constraints) && sketch.constraints.length) def.constraints = structuredClone(sketch.constraints) as ProfileDef["constraints"];
  if (card.material?.trim()) def.material = card.material.trim();
  return def;
}

/** The library entry for a profile: a new one, or the next version of the one it replaces. */
export function toEntry(def: ProfileDef, previous: LibraryEntry | undefined, id: string, now = new Date()): LibraryEntry {
  const { library: _ignored, ...rest } = def;
  return {
    ...rest,
    id: previous?.id ?? id,
    version: previous ? previous.version + 1 : 1,
    favourite: previous?.favourite ?? false,
    uses: previous?.uses ?? 0,
    updatedAt: now.toISOString(),
  };
}

/** The copy a part keeps: the profile, and which library entry and version it is. */
export function partCopy(entry: LibraryEntry): ProfileDef {
  const { id, version, favourite: _f, uses: _u, updatedAt: _t, ...def } = entry;
  return { ...def, library: { id, version } };
}

/**
 * Entries matching every word of the query, in a name, a designation or a
 * tag. Favourites first, then the most used, then by name.
 */
export function searchLibrary(entries: LibraryEntry[], query: string): LibraryEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = (e: LibraryEntry) => [e.name, ...e.sizes.map((s) => s.designation), ...e.tags, e.material ?? ""].join(" ").toLowerCase();
  return entries
    .filter((e) => words.every((w) => haystack(e).includes(w)))
    .sort((a, b) => Number(b.favourite) - Number(a.favourite) || b.uses - a.uses || a.name.localeCompare(b.name));
}

/** Another entry already has this name: names are unique in the library. */
export function nameTaken(entries: LibraryEntry[], name: string, id?: string): boolean {
  return entries.some((e) => e.id !== id && e.name.trim().toLowerCase() === name.trim().toLowerCase());
}

export interface LibraryFile {
  cocaide: "sections";
  version: 1;
  profiles: LibraryEntry[];
}

export function exportLibrary(entries: LibraryEntry[]): LibraryFile {
  return { cocaide: "sections", version: 1, profiles: entries };
}

/** Why a library entry is not a profile a part could hold, or null. */
export function entryProblem(e: unknown): string | null {
  const x = e as Partial<LibraryEntry> | null;
  if (!x || typeof x !== "object" || typeof x.id !== "string" || !x.id || typeof x.name !== "string") return "not a library entry";
  if (!Number.isInteger(x.version) || (x.version as number) < 1) return `${x.name}: version must be 1 or more`;
  const { id: _i, version: _v, favourite: _f, uses: _u, updatedAt: _t, ...def } = x;
  const errors = validateDocument({ version: 1, units: "mm", name: "check", profiles: { [x.name]: def }, features: [] }).headerErrors;
  return errors.length ? errors[0].replace(/^document: /, "") : null;
}

/** Merges an exported library in: a profile already here is replaced only by a later version of itself. */
export function mergeLibrary(
  current: LibraryEntry[],
  incoming: unknown,
): { entries: LibraryEntry[]; added: number; updated: number; skipped: string[] } | { error: string } {
  const file = incoming as Partial<LibraryFile>;
  if (!file || file.cocaide !== "sections" || !Array.isArray(file.profiles)) return { error: "not a Cocaide section library file" };
  const out = new Map(current.map((e) => [e.id, e]));
  let added = 0;
  let updated = 0;
  const skipped: string[] = [];
  for (const raw of file.profiles) {
    const problem = entryProblem(raw);
    if (problem) {
      skipped.push(problem);
      continue;
    }
    const r = raw as LibraryEntry;
    const e: LibraryEntry = { ...r, favourite: r.favourite === true, uses: Number.isInteger(r.uses) ? r.uses : 0, updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date(0).toISOString() };
    const here = out.get(e.id);
    if (!here) {
      out.set(e.id, e);
      added++;
    } else if (e.version > here.version) {
      out.set(e.id, { ...e, favourite: here.favourite, uses: here.uses });
      updated++;
    }
  }
  return { entries: [...out.values()], added, updated, skipped };
}

/**
 * The part's copy of a library profile, with a given size: the copy it has,
 * or a new one. A copy that lacks the size is brought up to the library's
 * version, and the note says so; a copy that is older but has the size is
 * kept, and the note says that too.
 */
export function ensureCopy(
  doc: RawDocument,
  entry: LibraryEntry,
  designation: string,
): { ok: true; doc: RawDocument; name: string; note?: string } | { ok: false; error: string } {
  const copies = (doc.profiles ?? {}) as Record<string, ProfileDef>;
  const held = Object.entries(copies).find(([, p]) => p.library?.id === entry.id);
  let name = held?.[0] ?? entry.name;
  if (held && held[1].sizes.some((s) => s.designation === designation)) {
    const v = held[1].library!.version;
    return v < entry.version
      ? { ok: true, doc, name, note: `This part keeps v${v} of ${name}: update its copy from Sections to use v${entry.version}.` }
      : { ok: true, doc, name };
  }
  // Not in the part yet, or the part's copy is older and lacks this size.
  if (!held) for (let k = 2; name in copies; k++) name = `${entry.name}_${k}`;
  const r = apply(doc, { type: "setProfile", name, profile: { ...partCopy(entry), name } });
  if (!r.ok) return r;
  const note = held ? `This part's copy of ${name} was v${held[1].library!.version}; it is now v${entry.version}, which has ${designation}.` : undefined;
  return { ok: true, doc: r.doc, name, ...(note ? { note } : {}) };
}

/**
 * Adds a member of a library profile to a part, with the part's copy of the
 * profile, as one change (see ensureCopy). A new member runs 1000 mm along X,
 * beside the members already there.
 */
export function addLibraryMember(
  doc: RawDocument,
  entry: LibraryEntry,
  designation: string,
): { ok: true; doc: RawDocument; id: string; note?: string } | { ok: false; error: string } {
  const copy = ensureCopy(doc, entry, designation);
  if (!copy.ok) return copy;
  const r = placeMember(copy.doc, copy.name, designation);
  return r.ok && copy.note ? { ...r, note: copy.note } : r;
}

/** A member of one of the part's own profiles: 1000 mm along X, beside the members already there. */
export function placeMember(doc: RawDocument, profile: string, designation: string): { ok: true; doc: RawDocument; id: string } | { ok: false; error: string } {
  const def = (doc.profiles as Record<string, ProfileDef> | undefined)?.[profile];
  const size = def ? sectionAt(def, designation) : null;
  const span = size?.ok ? Math.max(...size.props.envelope) : 50;
  const members = doc.features.filter((f) => f.op === "member").length;
  const y = members * Math.max(100, Math.ceil((2 * span) / 10) * 10);
  const id = nextId(doc, "member");
  const r = apply(doc, { type: "addFeature", feature: { id, op: "member", profile, size: designation, from: [0, y, 0], to: [1000, y, 0] } });
  return r.ok ? { ok: true, doc: r.doc, id } : r;
}

/** The part's copy of a profile, brought up to the library's version. Fails if a member uses a size it no longer has. */
export function updatePartCopy(doc: RawDocument, entry: LibraryEntry): { ok: true; doc: RawDocument; name: string } | { ok: false; error: string } {
  const held = Object.entries((doc.profiles ?? {}) as Record<string, ProfileDef>).find(([, p]) => p.library?.id === entry.id);
  if (!held) return { ok: false, error: `this part has no copy of ${entry.name}` };
  const [name] = held;
  const r = apply(doc, { type: "setProfile", name, profile: { ...partCopy(entry), name } });
  return r.ok ? { ok: true, doc: r.doc, name } : r;
}

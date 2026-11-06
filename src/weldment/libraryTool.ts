// addLibraryProfile: the AI's way to bring a catalogue section into the part
// (the same copy the Sections panel makes), so a weldment can be built in a
// part that has no profiles yet. It searches the standard library (and, in the
// app, the user's own library), and becomes an ordinary setProfile command, so
// it goes through the same transaction, scope ("+") and undo as any edit.
//
// A size the catalogue doesn't list is only added when asked for explicitly
// (`extraSizes`), marked "(non-catalogue)" in its designation so the cut list
// and drawings show it isn't a stock item.

import type { Command } from "../doc/commands";
import type { ProfileDef, ProfileSize } from "../doc/types";
import { partCopy, searchLibrary, type LibraryEntry } from "./library";
import { cornerRadius, standardLibrary } from "./standard";

type Raw = Record<string, unknown>;

/** The words of a size, normalised: "20 x 20 x 2.5", "20×20×2.5" and "20x20x2.50" are all "20x20x2.5". */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[×*]/g, "x")
    .replace(/\s*x\s*/g, "x")
    .replace(/(\d)\.0+(?!\d)/g, "$1")
    .replace(/(\.\d*?[1-9])0+(?!\d)/g, "$1")
    .trim();
}

/** The catalogue sizes of an entry that a requested size names (by its numbers), best first. */
function findSize(entry: LibraryEntry, wanted: string): ProfileSize | undefined {
  const w = norm(wanted);
  const bare = w.replace(/\s*[a-z]+$/, "").trim();
  return entry.sizes.find((s) => norm(s.designation) === w) ?? entry.sizes.find((s) => norm(s.designation).split(/\s+/).includes(bare));
}

/** A short list of an entry's sizes for an error message. */
function sizeList(entry: LibraryEntry, near?: string): string {
  const all = entry.sizes.map((s) => s.designation);
  if (!near) return all.slice(0, 30).join(", ") + (all.length > 30 ? `, … (${all.length} sizes)` : "");
  const lead = norm(near).split("x")[0];
  const close = all.filter((d) => norm(d).startsWith(lead + "x"));
  return (close.length ? close : all.slice(0, 20)).join(", ");
}

/**
 * The command for an addLibraryProfile call: { query: "SHS", sizes?: ["40x40x3"],
 * extraSizes?: [{ designation: "20x20x2.5", values: { b: 20, t: 2.5 } }], name? }.
 * Without `sizes` every catalogue size of the family comes in. A string is an error to hand back to the model.
 */
export function libraryProfileCommand(a: Raw, own: LibraryEntry[] = []): Command | string {
  const query = typeof a.query === "string" ? a.query.trim() : "";
  if (!query) return 'addLibraryProfile: query must name the section family, e.g. "SHS", "RHS", "CHS", "angle", "PFC", "UB", "flat bar"';
  const entries = [...own, ...standardLibrary()];
  // The family by name first ("SHS" should not pick RHS because a tag mentions hollow sections).
  const byName = entries.filter((e) => e.name.toLowerCase().split(/[\s(]/)[0] === query.toLowerCase());
  const found = byName.length ? byName : searchLibrary(entries, query);
  if (!found.length) {
    const families = [...new Set(entries.map((e) => e.name))].join(", ");
    return `addLibraryProfile: nothing in the section library matches "${query}". Families: ${families}`;
  }
  const entry = found[0];
  const def = partCopy(entry);
  const wanted = Array.isArray(a.sizes) ? a.sizes.filter((s): s is string => typeof s === "string" && s.trim() !== "") : [];
  let sizes: ProfileSize[] = entry.sizes;
  if (wanted.length) {
    const picked: ProfileSize[] = [];
    for (const w of wanted) {
      const s = findSize(entry, w);
      if (!s) {
        return `addLibraryProfile: ${entry.name} has no catalogue size "${w}". Catalogue sizes near it: ${sizeList(entry, w)}. Use one of those, or, only if the user asked for this exact size, add it with extraSizes: [{ "designation": "${w}", "values": { ${Object.keys(entry.parameters).map((k) => `"${k}": …`).join(", ")} } }] (keys: ${Object.keys(entry.parameters).join(", ")}).`;
      }
      if (!picked.includes(s)) picked.push(s);
    }
    sizes = picked;
  }
  const extras = Array.isArray(a.extraSizes) ? a.extraSizes : [];
  const keys = Object.keys(entry.parameters);
  for (const x of extras) {
    if (!x || typeof x !== "object") return "addLibraryProfile: each extraSizes entry must be { designation, values }";
    const designation = typeof (x as Raw).designation === "string" ? ((x as Raw).designation as string).trim() : "";
    const raw = (x as Raw).values;
    if (!designation || !raw || typeof raw !== "object") return "addLibraryProfile: each extraSizes entry must be { designation, values }";
    const values: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw as Raw)) if (typeof v === "number" && Number.isFinite(v) && v > 0) values[k] = v;
    // Hollow sections: the catalogue's corner radius rule fills r when it's left out.
    if (keys.includes("r") && values.r === undefined && values.t !== undefined && /SHS|RHS/i.test(entry.name)) values.r = cornerRadius(values.t);
    const missing = keys.filter((k) => values[k] === undefined);
    if (missing.length) return `addLibraryProfile: extra size "${designation}" needs values for ${missing.join(", ")} (keys: ${keys.join(", ")})`;
    const label = /non-catalogue/i.test(designation) ? designation : `${designation} (non-catalogue)`;
    sizes = [...sizes.filter((s) => s.designation !== label), { designation: label, values: Object.fromEntries(keys.map((k) => [k, values[k]])) }];
  }
  if (!sizes.length) return `addLibraryProfile: no sizes chosen for ${entry.name}`;
  const name = typeof a.name === "string" && a.name.trim() ? a.name.trim() : def.name;
  const profile: ProfileDef = { ...def, name, sizes, parameters: { ...sizes[0].values } };
  return { type: "setProfile", name, profile };
}

/** The tool's description, shared by the in-app AI and the MCP server. */
export const ADD_LIBRARY_PROFILE_HELP =
  'Bring a section from the section library into the part, so members can use it (a weldment in a part with no profiles starts here). { "query": family, e.g. "SHS", "RHS", "CHS", "EA" (equal angle), "PFC", "UB", "flat bar", "MGP"; "sizes"?: catalogue sizes to keep, e.g. ["40x40x3"] (all when left out); "extraSizes"?: [{ "designation": "20x20x2.5", "values": { "b": 20, "t": 2.5 } }] only for a size the user asked for that the catalogue does not list (it is marked "(non-catalogue)"; hollow sections fill the corner radius r themselves); "name"? }. The profile is named after the family (e.g. "SHS (AS/NZS 1163)"); a member then uses { "profile": that name, "size": a designation from it }. Prefer a catalogue size; when the asked size is not catalogued, say so and offer the nearest, or add it as an extra size if the user wants that exact one.';

/** What the AI must do when the asked size is not catalogued: ask, never decide. */
export const LIBRARY_SIZE_RULE =
  "If the part has no profile for a member, add one with addLibraryProfile. If the size the user asked for is not in the catalogue, do NOT substitute or create one on your own: change nothing, and ask the user whether to create that exact size as a non-catalogue size or use one of the nearest catalogue sizes (name them; the tool error lists them). Only after they answer, add it (extraSizes) or use their choice.";

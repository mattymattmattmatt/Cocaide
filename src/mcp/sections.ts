// The document reference in sections the agent fetches when it needs them
// (the reference tool), so its prompt stays small. Sections are cut from the
// one REFERENCE text at its "## " headings, so every op that documents itself
// (src/features/<op>/doc.ts) is a section of its own with no list to keep up.

import { REFERENCE } from "./reference";

export interface Section {
  key: string;
  /** Other names it answers to ("cut" for extrude, "chamfer" for fillet). */
  aliases: string[];
  title: string;
  text: string;
}

/** Topics that are not "## " headings of their own: a "### " part of a section. */
const SUBSECTIONS: { key: string; from: string; heading: string }[] = [
  { key: "expressions", from: "document", heading: "### Expressions" },
  { key: "dimensions", from: "document", heading: "### Dimension names, driven dimensions" },
  { key: "sketch-edits", from: "sketch", heading: "### Sketch edits the app makes" },
  { key: "sketch-references", from: "sketch", heading: "### The sketch axes, and references to the model" },
];

/** Section names that group several headings. */
const GROUPS: Record<string, string[]> = {
  selectors: ["Face selectors", "Edge selectors"],
  weldments: ["member", "frames"],
  ops: [],
};

function keyOf(heading: string): { key: string; aliases: string[] } {
  // "extrude / cut", "hole (the Hole Wizard)", "frames: nodes, ...", "Face selectors"
  const head = heading.replace(/\(.*$/, "").replace(/:.*$/, "").trim();
  const parts = head.split("/").map((p) => p.trim()).filter(Boolean);
  const key = parts[0];
  const aliases = parts.slice(1);
  if (head === "multibody tools") aliases.push("mirror", "split", "move", "deleteBody", "combine");
  if (head === "References") aliases.push("datums", "datumRef");
  if (head === "bodies") aliases.push("body");
  return { key, aliases };
}

let cache: Section[] | null = null;

/** Every section, in the reference's order: the document basics first. */
export function referenceSections(): Section[] {
  if (cache) return cache;
  const lines = REFERENCE.split("\n");
  const out: Section[] = [];
  let title = "document";
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    if (!text) return;
    const { key, aliases } = title === "document" ? { key: "document", aliases: [] } : keyOf(title);
    out.push({ key, aliases, title, text });
  };
  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      title = line.slice(3).trim();
      buf = [line];
    } else buf.push(line);
  }
  flush();
  for (const sub of SUBSECTIONS) {
    const parent = out.find((s) => s.key === sub.from);
    if (!parent) continue;
    const at = parent.text.indexOf(sub.heading);
    if (at < 0) continue;
    const rest = parent.text.slice(at);
    const end = rest.indexOf("\n### ", 1);
    out.push({ key: sub.key, aliases: [], title: sub.heading.slice(4), text: (end < 0 ? rest : rest.slice(0, end)).trim() });
  }
  cache = out;
  return out;
}

/** The ops' sections (each "## <op>" a feature op documents). */
export function opSections(): Section[] {
  const notOps = new Set(["document", "References", "Face", "Edge", "Tools", "examples", "strategy", "bodies", "frames", "multibody", "drawing", "member", "properties", "files", ...SUBSECTIONS.map((s) => s.key)]);
  return referenceSections().filter((s) => !notOps.has(s.key) && !s.key.includes(" "));
}

function find(name: string): Section[] {
  const n = name.trim().toLowerCase();
  const all = referenceSections();
  const group = Object.entries(GROUPS).find(([k]) => k === n);
  if (group) {
    if (group[0] === "ops") return opSections();
    return all.filter((s) => group[1].some((g) => s.title.startsWith(g)));
  }
  const exact = all.filter((s) => s.key.toLowerCase() === n || s.aliases.some((a) => a.toLowerCase() === n));
  if (exact.length) return exact;
  return all.filter((s) => s.title.toLowerCase().startsWith(n));
}

/** One section's text, or null with no such section. "ops" gives every op's first lines. */
export function referenceSection(name: string): string | null {
  const n = name.trim().toLowerCase();
  if (n === "ops") return opIndex();
  const found = find(name);
  return found.length ? found.map((s) => s.text).join("\n\n") : null;
}

/** The list of sections, one line each: what the reference tool can fetch. */
export function sectionIndex(): string {
  const topics = referenceSections().filter((s) => !opSections().includes(s));
  const ops = opSections().map((s) => [s.key, ...s.aliases].join("/"));
  return [
    `Topics: ${[...new Set([...topics.map((s) => s.key), "selectors", "weldments", "multibody"])].filter((k) => !k.includes(" ") && k !== "Face" && k !== "Edge").join(", ")}.`,
    `Ops (one section each): ${ops.join(", ")}.`,
    '"ops" gives every op\'s first example in one go.',
  ].join("\n");
}

/**
 * What the right-click agent's prompt carries of the reference: the document
 * basics, sketches (without the edit tools' and references' details), the
 * references and selectors, the strategy, and each op's first example. The
 * rest is a reference call away.
 */
export function coreReference(): string {
  const get = (k: string) => referenceSection(k) ?? "";
  const sketch = get("sketch");
  const cut = sketch.indexOf("### Sketch edits the app makes");
  return [
    get("document"),
    cut > 0 ? sketch.slice(0, cut).trim() : sketch,
    get("references"),
    get("selectors"),
    get("strategy"),
    `## Ops (each one's first example; reference("<op>") gives its section: every field, defaults, how it fails)\n${opIndex()}`,
    `## More, with the reference tool\n${sectionIndex()}`,
  ].join("\n\n");
}

/** Each op's heading and first example line: enough to know which op to read up on. */
export function opIndex(): string {
  return opSections()
    .map((s) => {
      const lines = s.text.split("\n");
      const example = lines.slice(1).find((l) => l.trim().startsWith("{")) ?? lines[1] ?? "";
      return `${lines[0]}\n${example.trim()}`;
    })
    .join("\n");
}

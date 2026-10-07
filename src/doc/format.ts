// Load and save .cocaide.json text.
//
// The serializer writes documents the way the spec does: one feature per
// block, one sketch entity or constraint per line, short leaf objects and
// vectors inline. Saved documents stay readable and diffs stay small.

export const FILE_EXTENSION = ".cocaide.json";
const MAX_INLINE = 100;

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

export function parseDocumentText(text: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const offset = locateJsonError(text);
    if (offset === null) return { ok: false, error: `invalid JSON: ${message}` };
    const before = text.slice(0, offset).split("\n");
    const line = before.length;
    const col = before[before.length - 1].length + 1;
    return { ok: false, error: `invalid JSON at line ${line}, column ${col}: ${message}` };
  }
}

export function formatDocument(doc: unknown): string {
  return `${format(doc, "", 0, [])}\n`;
}

/**
 * `lead` is the width already used on the line (indent and key); `path` is
 * the key path from the root, used to keep features expanded.
 */
function format(value: unknown, indent: string, lead: number, path: (string | number)[]): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    const holdsObjects = value.some((v) => v !== null && typeof v === "object" && !Array.isArray(v));
    const inline = inlineForm(value);
    if (!holdsObjects && lead + inline.length <= MAX_INLINE) return inline;
    if (value.length === 0) return "[]";
    const items = value.map((v, i) => `${inner}${format(v, inner, inner.length, [...path, i])}`);
    return `[\n${items.join(",\n")}\n${indent}]`;
  }
  const isFeature = path.length === 2 && path[0] === "features";
  const inline = inlineForm(value);
  if (path.length > 0 && !isFeature && !holdsObjectArray(value) && lead + inline.length <= MAX_INLINE) return inline;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      const key = `${inner}${JSON.stringify(k)}: `;
      return `${key}${format(v, inner, key.length, [...path, k])}`;
    });
  if (entries.length === 0) return "{}";
  return `{\n${entries.join(",\n")}\n${indent}}`;
}

function holdsObjectArray(obj: object): boolean {
  return Object.values(obj).some(
    (v) => Array.isArray(v) && v.some((x) => x !== null && typeof x === "object" && !Array.isArray(x)),
  );
}

function inlineForm(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[${value.map(inlineForm).join(", ")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return "{}";
    return `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${inlineForm(v)}`).join(", ")} }`;
  }
  return JSON.stringify(value);
}

/**
 * Offset of the first JSON syntax error, or null if the text parses. JSON.parse
 * messages do not carry a position in every engine, so find it ourselves.
 */
export function locateJsonError(text: string): number | null {
  let i = 0;
  class Stop extends Error {
    constructor(readonly at: number) {
      super();
    }
  }
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const expect = (s: string) => {
    for (const ch of s) {
      if (text[i] !== ch) throw new Stop(i);
      i++;
    }
  };
  const string = () => {
    expect('"');
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") {
        i++;
        if (text[i] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) throw new Stop(i);
          i += 4;
        } else if (!'"\\/bfnrt'.includes(text[i] ?? "")) throw new Stop(i);
      } else if (text.charCodeAt(i) < 0x20) throw new Stop(i);
      i++;
    }
    expect('"');
  };
  const number = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) throw new Stop(i);
    i += m[0].length;
  };
  const value = (): void => {
    ws();
    const ch = text[i];
    if (ch === "{") {
      i++;
      ws();
      if (text[i] === "}") return void i++;
      for (;;) {
        ws();
        string();
        ws();
        expect(":");
        value();
        ws();
        if (text[i] === ",") i++;
        else return expect("}");
      }
    }
    if (ch === "[") {
      i++;
      ws();
      if (text[i] === "]") return void i++;
      for (;;) {
        value();
        ws();
        if (text[i] === ",") i++;
        else return expect("]");
      }
    }
    if (ch === '"') return string();
    if (ch === "t") return expect("true");
    if (ch === "f") return expect("false");
    if (ch === "n") return expect("null");
    return number();
  };
  try {
    value();
    ws();
    return i < text.length ? i : null;
  } catch (e) {
    if (e instanceof Stop) return Math.min(e.at, text.length);
    throw e;
  }
}

// The cut list's settings and the notes people add to it (Phase Q): kept in
// the document as `cutList`, beside the welds. The list itself is always read
// from the rebuild (src/weldment/items.ts); what is stored here is only what
// a person or the AI typed: descriptions, finishes, notes, custom properties
// ("Supplier", "Heat no."), the stock bars and saw kerf for nesting, and the
// item numbers as they were last given, so they stay put across rebuilds.

/** Text a person typed onto an item, a member or a body. Every field optional. */
export interface CutListProps {
  /** Replaces the item's description ("SHS 40x40x3"). */
  description?: string;
  /** "Hot-dip galvanised", "Powder coat RAL 9005". Default: the part's finish. */
  finish?: string;
  notes?: string;
  /** "Bevel 30° both ends", "J prep". */
  weldPrep?: string;
  /** A member group: "Frame", "Bracing". Items can be grouped and sorted by it. */
  group?: string;
  /** User-defined: { "Supplier": "Steel & Co", "Heat no.": "H2231" }. */
  properties?: Record<string, string>;
}
export const CUT_LIST_PROP_KEYS = ["description", "finish", "notes", "weldPrep", "group", "properties"] as const;
export const CUT_LIST_TEXT_KEYS = ["description", "finish", "notes", "weldPrep", "group"] as const;

/**
 * An item's number as it was last given, with the members (or bodies) that
 * were on it then, and the item's own text. On a rebuild, an item takes the
 * number of the entry that shares the most members with it.
 */
export interface CutListItemEntry extends CutListProps {
  item: number;
  /** Member ids, or body names for plates and other bodies. */
  members: string[];
}

/** Stock bars for nesting. Lengths and kerf in mm. */
export interface StockSettings {
  /** The bar lengths you can buy (default [6000], or the part's stock_length parameter). The nesting picks among them. */
  lengths?: number[];
  /** Lost to each saw cut (default 3). */
  kerf?: number;
  /** Cut off each end of a bar before use, to square it (default 0). */
  trim?: number;
  /** An offcut at least this long is kept for later; shorter is scrap (default 300). */
  minOffcut?: number;
  /** Per profile size, by designation ("SHS 40x40x3"): its own bar lengths or kerf. */
  profiles?: Record<string, { lengths?: number[]; kerf?: number }>;
}
export const STOCK_KEYS = ["lengths", "kerf", "trim", "minOffcut", "profiles"] as const;

export interface CutListSettings {
  /** Members whose lengths differ by at most this are one item (mm, default 0.5). */
  tolerance?: number;
  stock?: StockSettings;
  /** Item numbers and item text, kept. */
  items?: CutListItemEntry[];
  /** Text on one member or body (by member id or body name). Members with different text are different items. */
  members?: Record<string, CutListProps>;
}
export const CUT_LIST_KEYS = ["tolerance", "stock", "items", "members"] as const;

export const DEFAULT_STOCK = { length: 6000, kerf: 3, trim: 0, minOffcut: 300 } as const;
export const DEFAULT_TOLERANCE = 0.5;
/** The longest typed text, as a part property. */
const TEXT_MAX = 500;
const describe = (v: unknown) => (v === undefined ? "nothing" : JSON.stringify(v));
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The settings, checked strictly. Errors name the field and say what it must
 * be ("document: cutList.stock.kerf: must be 0 to 50 mm (got 80)"). Item
 * entries and member text may name members the part no longer has: they are
 * kept (the number comes back if the member does), never an error.
 */
export function checkCutList(raw: unknown): { value: CutListSettings; errors: string[] } {
  const errors: string[] = [];
  const fail = (path: string, msg: string) => errors.push(`document: cutList${path ? `.${path}` : ""}: ${msg}`);
  const out: CutListSettings = {};
  if (!isObject(raw)) {
    fail("", `must be an object of cut list settings: tolerance, stock, items, members (got ${describe(raw)})`);
    return { value: out, errors };
  }
  unknownKeys(raw, CUT_LIST_KEYS, "", fail);
  const num = (v: unknown, path: string, lo: number, hi: number, unit = "mm", strictLo = false): number | undefined => {
    if (typeof v !== "number" || !Number.isFinite(v) || (strictLo ? v <= lo : v < lo) || v > hi) {
      fail(path, `must be a number ${strictLo ? `over ${lo}` : `from ${lo}`} to ${hi}${unit ? ` ${unit}` : ""} (got ${describe(v)})`);
      return undefined;
    }
    return v;
  };
  if (raw.tolerance !== undefined) {
    const t = num(raw.tolerance, "tolerance", 0, 50);
    if (t !== undefined) out.tolerance = t;
  }
  if (raw.stock !== undefined) {
    if (!isObject(raw.stock)) fail("stock", `must be an object: { "lengths": [6000], "kerf": 3, "trim": 0, "minOffcut": 300, "profiles": {} } (got ${describe(raw.stock)})`);
    else {
      const st = raw.stock;
      const stock: StockSettings = {};
      unknownKeys(st, STOCK_KEYS, "stock", fail);
      const lengths = (v: unknown, path: string): number[] | undefined => {
        if (!Array.isArray(v) || v.length === 0 || v.length > 10) {
          fail(path, `must be a list of 1 to 10 bar lengths in mm, like [6000, 6100] (got ${describe(v)})`);
          return undefined;
        }
        const got = v.map((x, i) => num(x, `${path}[${i}]`, 100, 100000));
        return got.every((x) => x !== undefined) ? [...new Set(got as number[])].sort((a, b) => a - b) : undefined;
      };
      if (st.lengths !== undefined) {
        const l = lengths(st.lengths, "stock.lengths");
        if (l) stock.lengths = l;
      }
      if (st.kerf !== undefined) {
        const k = num(st.kerf, "stock.kerf", 0, 50);
        if (k !== undefined) stock.kerf = k;
      }
      if (st.trim !== undefined) {
        const k = num(st.trim, "stock.trim", 0, 1000);
        if (k !== undefined) stock.trim = k;
      }
      if (st.minOffcut !== undefined) {
        const k = num(st.minOffcut, "stock.minOffcut", 0, 100000);
        if (k !== undefined) stock.minOffcut = k;
      }
      if (st.profiles !== undefined) {
        if (!isObject(st.profiles)) fail("stock.profiles", `must be an object of designation: { "lengths": [...], "kerf": n }, like { "SHS 40x40x3": { "lengths": [8000] } } (got ${describe(st.profiles)})`);
        else {
          const profiles: NonNullable<StockSettings["profiles"]> = {};
          for (const [d, p] of Object.entries(st.profiles)) {
            const path = `stock.profiles.${d}`;
            if (!isObject(p)) {
              fail(path, `must be an object: { "lengths": [6000], "kerf": 3 } (got ${describe(p)})`);
              continue;
            }
            unknownKeys(p, ["lengths", "kerf"], path, fail);
            const entry: { lengths?: number[]; kerf?: number } = {};
            if (p.lengths !== undefined) {
              const l = lengths(p.lengths, `${path}.lengths`);
              if (l) entry.lengths = l;
            }
            if (p.kerf !== undefined) {
              const k = num(p.kerf, `${path}.kerf`, 0, 50);
              if (k !== undefined) entry.kerf = k;
            }
            profiles[d] = entry;
          }
          stock.profiles = profiles;
        }
      }
      out.stock = stock;
    }
  }
  if (raw.items !== undefined) {
    if (!Array.isArray(raw.items)) fail("items", `must be a list of { "item": 1, "members": ["rail_1"], ...text } (got ${describe(raw.items)})`);
    else {
      const numbers = new Set<number>();
      const owner = new Map<string, number>();
      const items: CutListItemEntry[] = [];
      raw.items.forEach((e, i) => {
        const path = `items[${i}]`;
        if (!isObject(e)) return fail(path, `must be { "item": 1, "members": [...] } (got ${describe(e)})`);
        const before = errors.length;
        unknownKeys(e, ["item", "members", ...CUT_LIST_PROP_KEYS], path, fail);
        if (typeof e.item !== "number" || !Number.isInteger(e.item) || e.item < 1 || e.item > 9999) fail(`${path}.item`, `must be a whole number from 1 to 9999 (got ${describe(e.item)})`);
        else if (numbers.has(e.item)) fail(`${path}.item`, `item ${e.item} is listed twice; give each item its own number`);
        else numbers.add(e.item);
        if (!Array.isArray(e.members) || e.members.some((m) => typeof m !== "string" || !m)) fail(`${path}.members`, `must list member ids or body names (got ${describe(e.members)})`);
        else
          for (const m of e.members as string[]) {
            if (owner.has(m)) fail(`${path}.members`, `"${m}" is on item ${owner.get(m)} too; a member is on one item`);
            else owner.set(m, e.item as number);
          }
        const props = checkProps(e, path, fail);
        if (errors.length === before) items.push({ item: e.item as number, members: [...(e.members as string[])], ...props });
      });
      out.items = items;
    }
  }
  if (raw.members !== undefined) {
    if (!isObject(raw.members)) fail("members", `must be an object of member id or body name: text, like { "rail_1": { "notes": "check fit" } } (got ${describe(raw.members)})`);
    else {
      const members: Record<string, CutListProps> = {};
      for (const [id, p] of Object.entries(raw.members)) {
        const path = `members.${id}`;
        if (!isObject(p)) {
          fail(path, `must be an object of text: ${CUT_LIST_PROP_KEYS.join(", ")} (got ${describe(p)})`);
          continue;
        }
        unknownKeys(p, CUT_LIST_PROP_KEYS, path, fail);
        members[id] = checkProps(p, path, fail);
      }
      out.members = members;
    }
  }
  return { value: errors.length ? {} : out, errors };
}

function unknownKeys(o: Record<string, unknown>, allowed: readonly string[], path: string, fail: (path: string, msg: string) => void) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(path, `unknown field "${k}" (allowed: ${allowed.join(", ")})`);
}

function checkProps(o: Record<string, unknown>, path: string, fail: (path: string, msg: string) => void): CutListProps {
  const out: CutListProps = {};
  for (const k of CUT_LIST_TEXT_KEYS) {
    const v = o[k];
    if (v === undefined) continue;
    if (typeof v !== "string") fail(`${path}.${k}`, `must be text (got ${describe(v)})`);
    else if (v.trim() === "") fail(`${path}.${k}`, "is empty; leave it out instead");
    else if (v.length > TEXT_MAX) fail(`${path}.${k}`, `is ${v.length} characters long; keep it to ${TEXT_MAX}`);
    else out[k] = v;
  }
  if (o.properties !== undefined) {
    if (!isObject(o.properties)) fail(`${path}.properties`, `must be an object of name: text, like { "Supplier": "Steel & Co" } (got ${describe(o.properties)})`);
    else {
      const props: Record<string, string> = {};
      for (const [name, v] of Object.entries(o.properties)) {
        if (name.trim() === "" || name.length > 60) fail(`${path}.properties`, `a property name must be 1 to 60 characters (got ${describe(name)})`);
        else if (typeof v !== "string" || v.trim() === "") fail(`${path}.properties.${name}`, `must be text; to remove it, leave it out (got ${describe(v)})`);
        else if (v.length > TEXT_MAX) fail(`${path}.properties.${name}`, `is ${v.length} characters long; keep it to ${TEXT_MAX}`);
        else props[name] = v;
      }
      if (Object.keys(props).length) out.properties = props;
    }
  }
  return out;
}

/** The settings a raw document holds, leniently: what validates, else none. Never throws. */
export function cutListSettings(doc: unknown): CutListSettings {
  const raw = isObject(doc) ? doc.cutList : undefined;
  if (raw === undefined) return {};
  return checkCutList(raw).value;
}

/**
 * Merges a patch into the settings, the way `setCutList` does: top-level
 * fields replace (null removes one); "stock" merges one level (null removes
 * a stock field); "members" merges by id (null removes one member's text);
 * "itemText" ([{ item, members, ...text }]) merges text into the kept items
 * one at a time (the entry sharing its members, keeping its number), the
 * rest untouched. Throws when an itemText's number is kept for other members.
 * Empty text and empty objects are dropped, so a cleared field goes.
 */
export function mergeCutList(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else if (k === "stock" && isObject(v)) {
      const stock: Record<string, unknown> = { ...(isObject(next.stock) ? next.stock : {}) };
      for (const [sk, sv] of Object.entries(v)) {
        if (sv === null) delete stock[sk];
        else stock[sk] = structuredClone(sv);
      }
      if (Object.keys(stock).length) next.stock = stock;
      else delete next.stock;
    } else if (k === "members" && isObject(v)) {
      const members: Record<string, unknown> = { ...(isObject(next.members) ? next.members : {}) };
      for (const [id, p] of Object.entries(v)) {
        const cleaned = isObject(p) ? cleanProps(p) : null;
        if (!cleaned) delete members[id];
        else members[id] = cleaned;
      }
      if (Object.keys(members).length) next.members = members;
      else delete next.members;
    } else if (k === "itemText" && Array.isArray(v)) {
      // Text on items, merged one item at a time: the kept entry sharing its members (else its number) takes it.
      const items: Record<string, unknown>[] = Array.isArray(next.items) ? next.items.map((e) => (isObject(e) ? { ...e } : {})) : [];
      for (const t of v) {
        if (!isObject(t)) continue;
        const members = Array.isArray(t.members) ? t.members.map(String) : [];
        let e = items.find((x) => Array.isArray(x.members) && x.members.some((m) => members.includes(String(m))));
        if (!e) e = items.find((x) => x.item === t.item && !members.length);
        if (!e) {
          if (items.some((x) => x.item === t.item)) throw new Error(`itemText: item ${String(t.item)} is kept for other members (${String((items.find((x) => x.item === t.item)!.members as string[]).join(", "))}); give the members it is for`);
          e = { item: t.item, members };
          items.push(e);
        }
        if (members.length && !(Array.isArray(e.members) && e.members.length)) e.members = members;
        for (const [tk, tv] of Object.entries(t)) {
          if (tk === "item" || tk === "members") continue;
          if (tk === "properties" && isObject(tv)) {
            const props: Record<string, unknown> = { ...(isObject(e.properties) ? e.properties : {}) };
            for (const [pn, pv] of Object.entries(tv)) {
              if (pv === null || (typeof pv === "string" && !pv.trim())) delete props[pn];
              else props[pn] = pv;
            }
            if (Object.keys(props).length) e.properties = props;
            else delete e.properties;
          } else if (tv === null || (typeof tv === "string" && !tv.trim())) delete e[tk];
          else e[tk] = tv;
        }
      }
      if (items.length) next.items = items;
      else delete next.items;
    } else if (k === "items" && Array.isArray(v)) {
      const items = v.map((e) => (isObject(e) ? { ...(cleanProps(e) ?? {}), item: e.item, members: e.members } : e));
      if (items.length) next.items = items;
      else delete next.items;
    } else next[k] = structuredClone(v);
  }
  return next;
}

/** Text with blanks dropped: empty strings and empty property maps go; null when nothing is left. */
export function cleanProps(p: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === "item" || k === "members") continue;
    if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) continue;
    if (k === "properties" && isObject(v)) {
      const props = Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string" ? x.trim() !== "" : x !== null && x !== undefined));
      if (Object.keys(props).length) out.properties = props;
      continue;
    }
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

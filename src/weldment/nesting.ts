// Stock and nesting (Phase Q): which bars to buy and how to cut each one.
// One-dimensional cutting: the cut list's member pieces, per profile size,
// packed into stock bars by first-fit decreasing, then improved — bars
// emptied into the others where their pieces fit, pieces swapped to fill
// bars tighter, each bar shrunk to the shortest stock length that holds its
// pieces — and the best of several starts kept (fewest bars, then the least
// bought length, then the least scrap).
//
// A bar's space: its length less the end trim at each end. Pieces sit end
// to end with a saw kerf between them; what is left after the last piece is
// one more cut away from it (a kerf), and is an offcut kept for later when
// it is at least `minOffcut` long, else scrap. Pure; numbers in mm.

import { DEFAULT_STOCK, type CutListSettings } from "../doc/cutListSettings";
import type { CutListResult } from "./items";

export interface NestOptions {
  /** Bar lengths you can buy, mm. */
  stock: number[];
  kerf: number;
  /** Cut off each end of a bar before use. */
  trim: number;
  minOffcut: number;
}

export interface NestPiece {
  item: number;
  length: number;
}

export interface NestBar {
  /** The bar's length as bought. */
  stock: number;
  /** In cutting order, longest first. */
  pieces: NestPiece[];
  /** The pieces' lengths added up. */
  used: number;
  /** Saw cuts made (each takes a kerf): one per piece, but none after a piece that ends at the bar's end. */
  cuts: number;
  /** What is left after the last cut. */
  offcut: number;
  /** The offcut is long enough to keep. */
  kept: boolean;
  /** stock − pieces − a kept offcut: trim, kerfs and a short offcut. */
  scrap: number;
  /** scrap / stock, percent. */
  wastePct: number;
}

export interface NestResult {
  designation: string;
  options: NestOptions;
  bars: NestBar[];
  /** How many bars of each stock length, shortest first. */
  buy: { stock: number; count: number }[];
  pieces: number;
  /** mm. */
  bought: number;
  used: number;
  offcuts: number;
  scrap: number;
  /** Scrap / bought, percent: trim, kerfs and offcuts too short to keep (a kept offcut is stock, not waste). */
  wastePct: number;
  /** Pieces longer than any stock bar's usable length: they need a longer bar or a splice. */
  tooLong: NestPiece[];
}

/** The nesting options for one profile size, from the cut list's settings (and the part's stock_length parameter). */
export function nestOptions(settings: CutListSettings, designation: string, stockLength?: number): NestOptions {
  const st = settings.stock ?? {};
  const own = st.profiles?.[designation];
  const fallback = stockLength && stockLength > 0 ? [stockLength] : [DEFAULT_STOCK.length];
  return {
    stock: [...(own?.lengths ?? st.lengths ?? fallback)].sort((a, b) => a - b),
    kerf: own?.kerf ?? st.kerf ?? DEFAULT_STOCK.kerf,
    trim: st.trim ?? DEFAULT_STOCK.trim,
    minOffcut: st.minOffcut ?? DEFAULT_STOCK.minOffcut,
  };
}

/** Does a bar of this length hold these pieces? */
export function fits(stock: number, lengths: number[], o: Pick<NestOptions, "kerf" | "trim">): boolean {
  if (!lengths.length) return true;
  const total = lengths.reduce((a, b) => a + b, 0) + o.kerf * (lengths.length - 1);
  return total <= stock - 2 * o.trim + 1e-6;
}

/** A bar's figures from its pieces. */
export function barOf(stock: number, pieces: NestPiece[], o: NestOptions): NestBar {
  const sorted = [...pieces].sort((a, b) => b.length - a.length || a.item - b.item);
  const used = sorted.reduce((a, p) => a + p.length, 0);
  const usable = stock - 2 * o.trim;
  const left = usable - used - o.kerf * Math.max(0, sorted.length - 1);
  // The last piece is cut off the bar unless it reaches its end.
  const lastCut = left > 1e-6;
  const offcut = lastCut ? Math.max(0, left - o.kerf) : 0;
  const kept = offcut >= o.minOffcut && offcut > 0;
  const scrap = stock - used - (kept ? offcut : 0);
  return {
    stock,
    pieces: sorted,
    used: round(used),
    cuts: sorted.length - (lastCut ? 0 : 1) + (o.trim > 0 ? 1 : 0),
    offcut: round(offcut),
    kept,
    scrap: round(scrap),
    wastePct: round((scrap / stock) * 100, 2),
  };
}

/** Pieces packed into bars, best of several starts. */
export function nest(designation: string, pieces: NestPiece[], o: NestOptions): NestResult {
  const longest = Math.max(...o.stock);
  const tooLong = pieces.filter((p) => !fits(longest, [p.length], o));
  const ok = pieces.filter((p) => fits(longest, [p.length], o)).sort((a, b) => b.length - a.length || a.item - b.item);
  let best: number[][] | null = null;
  let bestStock: number[] = [];
  const score = (bars: number[][], stocks: number[]) => [bars.length, stocks.reduce((a, b) => a + b, 0)];
  const better = (a: number[], b: number[]) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1] - 1e-6);
  // Starts: first fit and best fit, opening bars of each stock length that holds the longest piece.
  for (const open of o.stock) {
    if (ok.length && !fits(open, [ok[0].length], o)) continue;
    for (const rule of ["first", "best"] as const) {
      const bars = pack(ok, open, rule, o);
      improve(bars, ok.map((p) => p.length), open, o);
      const stocks = bars.map((b) => shortestStock(b.map((i) => ok[i].length), o));
      if (!best || better(score(bars, stocks), score(best, bestStock))) {
        best = bars;
        bestStock = stocks;
      }
    }
  }
  const bars = (best ?? []).map((b, k) => barOf(bestStock[k], b.map((i) => ok[i]), o));
  // Cutting order: the fullest bars first.
  bars.sort((a, b) => b.used - a.used || b.stock - a.stock);
  const counts = new Map<number, number>();
  for (const b of bars) counts.set(b.stock, (counts.get(b.stock) ?? 0) + 1);
  const bought = bars.reduce((a, b) => a + b.stock, 0);
  const used = bars.reduce((a, b) => a + b.used, 0);
  return {
    designation,
    options: o,
    bars,
    buy: [...counts].map(([stock, count]) => ({ stock, count })).sort((a, b) => a.stock - b.stock),
    pieces: pieces.length,
    bought: round(bought),
    used: round(used),
    offcuts: round(bars.reduce((a, b) => a + (b.kept ? b.offcut : 0), 0)),
    scrap: round(bars.reduce((a, b) => a + b.scrap, 0)),
    wastePct: bought ? round((bars.reduce((a, b) => a + b.scrap, 0) / bought) * 100, 2) : 0,
    tooLong,
  };
}

/** Bars as lists of piece indices, by first fit or best fit (the tightest bar the piece fits). */
function pack(pieces: NestPiece[], open: number, rule: "first" | "best", o: NestOptions): number[][] {
  const bars: number[][] = [];
  const room = (b: number[]) => open - 2 * o.trim - b.reduce((a, i) => a + pieces[i].length, 0) - o.kerf * Math.max(0, b.length - 1);
  pieces.forEach((p, i) => {
    let pick = -1;
    for (let k = 0; k < bars.length; k++) {
      if (!fits(open, [...bars[k].map((j) => pieces[j].length), p.length], o)) continue;
      if (rule === "first") {
        pick = k;
        break;
      }
      if (pick < 0 || room(bars[k]) < room(bars[pick])) pick = k;
    }
    if (pick < 0) bars.push([i]);
    else bars[pick].push(i);
  });
  return bars;
}

/**
 * Improvement: empty the emptiest bar into the others where every piece fits
 * (each into the tightest bar it fits), and swap a shorter piece out of a
 * fuller bar for a longer one from an emptier bar where both still fit, so
 * the full bars fill and the empty ones empty. Until nothing changes.
 */
function improve(bars: number[][], lengths: number[], open: number, o: NestOptions): void {
  const len = (i: number) => lengths[i];
  const fill = (b: number[]) => b.reduce((a, i) => a + len(i), 0);
  const holds = (b: number[]) => fits(open, b.map(len), o);
  for (let pass = 0; pass < 50; pass++) {
    let changed = false;
    // Empty a bar.
    const byFill = bars.map((b, k) => ({ k, f: fill(b) })).sort((a, b) => a.f - b.f);
    for (const { k } of byFill) {
      const trial = bars.map((b) => [...b]);
      const moving = [...trial[k]].sort((a, b) => len(b) - len(a));
      trial[k] = [];
      let all = true;
      for (const i of moving) {
        let pick = -1;
        for (let j = 0; j < trial.length; j++) {
          if (j === k || !holds([...trial[j], i])) continue;
          if (pick < 0 || fill(trial[j]) > fill(trial[pick])) pick = j;
        }
        if (pick < 0) {
          all = false;
          break;
        }
        trial[pick].push(i);
      }
      if (all) {
        bars.splice(0, bars.length, ...trial.filter((b) => b.length));
        changed = true;
        break;
      }
    }
    if (changed) continue;
    // Swap to concentrate.
    outer: for (let a = 0; a < bars.length; a++) {
      for (let b = 0; b < bars.length; b++) {
        if (a === b || fill(bars[a]) < fill(bars[b])) continue;
        for (let x = 0; x < bars[a].length; x++) {
          for (let y = 0; y < bars[b].length; y++) {
            const p = bars[a][x];
            const q = bars[b][y];
            if (len(q) <= len(p) + 1e-9) continue;
            const na = [...bars[a]];
            const nb = [...bars[b]];
            na[x] = q;
            nb[y] = p;
            if (holds(na) && holds(nb)) {
              bars[a] = na;
              bars[b] = nb;
              changed = true;
              break outer;
            }
          }
        }
      }
    }
    if (!changed) break;
  }
}

function shortestStock(lengths: number[], o: NestOptions): number {
  for (const s of o.stock) if (fits(s, lengths, o)) return s;
  return Math.max(...o.stock);
}

function round(x: number, digits = 1): number {
  const k = 10 ** digits;
  return Math.round(x * k) / k + 0;
}

/** Every profile size's nesting, for the cut list's member items. */
export function nestCutList(list: CutListResult, stockLength?: number): NestResult[] {
  const by = new Map<string, NestPiece[]>();
  for (const i of list.items) {
    if (i.kind !== "member") continue;
    const pieces = by.get(i.designation) ?? [];
    for (let k = 0; k < i.quantity; k++) pieces.push({ item: i.item, length: i.length });
    by.set(i.designation, pieces);
  }
  return [...by]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([d, pieces]) => nest(d, pieces, nestOptions(list.settings, d, stockLength)));
}

/** The stock buy list across sizes: "SHS 40x40x3: 3 × 6000". */
export function buyList(results: NestResult[]): { designation: string; stock: number; count: number }[] {
  return results.flatMap((r) => r.buy.map((b) => ({ designation: r.designation, stock: b.stock, count: b.count })));
}

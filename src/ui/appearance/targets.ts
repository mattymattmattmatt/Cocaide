// What the appearance picker is opened on (the part, a body, the faces a
// feature makes) and what it needs about it: its title, its own look, what it
// shows without one (and from where) and the viewport's default colour for it.

import { asAppearance, PartAppearances, sameAppearance, type Appearance, type ResolvedAppearance } from "../../appearance";
import { apply, type RawDocument } from "../../doc/commands";
import type { Command } from "../../doc/commands";
import { DATUM_OPS } from "../../features/datum";
import type { RebuildView } from "../../worker/protocol";
import { BODY_COLORS } from "../Viewport";

export type LookTarget = { kind: "part" } | { kind: "body"; body: string } | { kind: "feature"; feature: string };

export interface LookInfo {
  title: string;
  own: Appearance | null;
  inherited: ResolvedAppearance | null;
  fallback: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The part's default grey (the theme's --part). */
export const PART_GREY = "#c4cad3";

/** The viewport's default colour for a body: its own in a part of several, else the part grey. */
export function bodyFallback(view: RebuildView | null, body: string | undefined): string {
  const bodies = view?.bodies ?? [];
  if (bodies.length < 2 || body === undefined) return PART_GREY;
  const i = bodies.findIndex((b) => b.name === body);
  return i < 0 ? PART_GREY : BODY_COLORS[i % BODY_COLORS.length];
}

/** The body most of a feature's faces are on (the first it made), in the view. */
export function featureBody(view: RebuildView | null, feature: string): string | undefined {
  return view?.faces.find((f) => f.createdBy === feature)?.body;
}

export function lookInfo(doc: Record<string, unknown>, view: RebuildView | null, t: LookTarget): LookInfo {
  const name = typeof doc.name === "string" ? doc.name : "part";
  if (t.kind === "part") {
    const { appearance: own, ...rest } = doc;
    return { title: `Part ${name}`, own: asAppearance(own), inherited: new PartAppearances(rest).partLook(), fallback: PART_GREY };
  }
  if (t.kind === "body") {
    const all = isObject(doc.bodyAppearances) ? doc.bodyAppearances : {};
    const { [t.body]: own, ...others } = all;
    return { title: `Body ${t.body}`, own: asAppearance(own), inherited: new PartAppearances({ ...doc, bodyAppearances: others }).body(t.body), fallback: bodyFallback(view, t.body) };
  }
  const features = Array.isArray(doc.features) ? (doc.features as Record<string, unknown>[]) : [];
  const f = features.find((x) => isObject(x) && x.id === t.feature);
  const body = featureBody(view, t.feature);
  const without = { ...doc, features: features.map((x) => (x === f ? { ...x, appearance: undefined } : x)) };
  return { title: `Feature ${t.feature}`, own: asAppearance(f?.appearance), inherited: new PartAppearances(without).body(body), fallback: bodyFallback(view, body) };
}

/** The edit that gives the target this look (null: back to what it inherits). */
export function lookCommand(t: LookTarget, a: Appearance | null): Command {
  return t.kind === "part" ? { type: "setAppearance", appearance: a } : t.kind === "body" ? { type: "setAppearance", body: t.body, appearance: a } : { type: "setAppearance", feature: t.feature, appearance: a };
}

/** Whether a feature makes faces that can be coloured (not a sketch, a datum or a joint note). */
export function colourable(op: unknown): boolean {
  return typeof op === "string" && op !== "sketch" && !Object.hasOwn(DATUM_OPS, op) && !["joint", "deleteBody"].includes(op);
}

/** What the picker needs for several targets at once: one look over them all (their own, when they all have the same one). */
export function lookInfoAll(doc: Record<string, unknown>, view: RebuildView | null, targets: readonly LookTarget[]): LookInfo {
  if (targets.length === 1) return lookInfo(doc, view, targets[0]);
  const infos = targets.map((t) => lookInfo(doc, view, t));
  const first = infos[0]?.own ?? null;
  const same = infos.every((i) => sameAppearance(i.own, first));
  const kinds = new Set(targets.map((t) => t.kind));
  const noun = kinds.size === 1 ? (targets[0].kind === "body" ? "bodies" : targets[0].kind === "feature" ? "features" : "parts") : "items";
  return { title: `${targets.length} ${noun}`, own: same ? first : null, inherited: null, fallback: infos[0]?.fallback ?? PART_GREY };
}

/** The document with these targets given this look (what a preview shows); null when it can't be made. */
export function withLook(doc: RawDocument, targets: readonly LookTarget[], a: Appearance | null): RawDocument | null {
  let next = doc;
  for (const t of targets) {
    const r = apply(next, lookCommand(t, a));
    if (!r.ok) return null;
    next = r.doc;
  }
  return next;
}


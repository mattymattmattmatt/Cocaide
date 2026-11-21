// The colours a STEP file carries: each body's (or component's) and, where a
// feature colours its own faces, those faces'. Read from the part's
// appearances (src/appearance) against its faces as built, so the next tool
// opens the part looking as it does here.

import type { TopoDS_Shape } from "replicad-opencascadejs";
import { PartAppearances, sameAppearance, type Appearance } from "../appearance";
import type { OC, Scope } from "./oc";
import type { RebuildResult } from "./rebuild";
import { faceInfo, listFaces } from "./topology";

/** How one exported shape looks: as a whole, and face by face (in its faces' order) where they differ. */
export interface ItemLook {
  look: Appearance | null;
  faces: (Appearance | null)[] | null;
}

/** Each body's look, by body name; null when the part says nothing about how it looks. */
export function partLooks(oc: OC, s: Scope, built: Pick<RebuildResult, "solid" | "bodies" | "label">, doc: unknown): Map<string, ItemLook> | null {
  const p = new PartAppearances(doc);
  if (!p.any || !built.solid) return null;
  // The faces as built, given the features that made them: the same order as the bodies' face ranges.
  const infos = listFaces(oc, s, built.solid).map((f, i) => faceInfo(oc, s, f, i));
  built.label({ faces: infos, edges: [] });
  const out = new Map<string, ItemLook>();
  for (const b of built.bodies) {
    const look = p.body(b.name)?.appearance ?? null;
    const faces = infos.slice(b.faces[0], b.faces[1]).map((f) => p.face({ createdBy: f.createdBy, body: b.name })?.appearance ?? null);
    out.set(b.name, { look, faces: faces.every((f) => sameAppearance(f, look)) ? null : faces });
  }
  return [...out.values()].some((x) => x.look || x.faces) ? out : null;
}

/** A component's look: its own colour over all of it, else its part's bodies' looks, its faces in order. */
export function componentLook(own: Appearance | null, part: Map<string, ItemLook> | null, bodies: Pick<RebuildResult, "bodies">["bodies"]): ItemLook | null {
  if (own) return { look: own, faces: null };
  if (!part) return null;
  const faces: (Appearance | null)[] = [];
  for (const b of bodies) {
    const l = part.get(b.name);
    const n = b.faces[1] - b.faces[0];
    for (let i = 0; i < n; i++) faces.push(l?.faces?.[i] ?? l?.look ?? null);
  }
  const first = faces[0] ?? null;
  return faces.every((f) => sameAppearance(f, first)) ? (first ? { look: first, faces: null } : null) : { look: null, faces };
}

/** Colours a shape's label (and its faces' where they differ) in an XCAF document. */
export function colourLabel(oc: OC, s: Scope, shapes: { AddSubShape(label: unknown, shape: TopoDS_Shape): { IsNull(): boolean } }, colours: { SetColor(label: unknown, color: unknown, type: unknown): void }, label: unknown, shape: TopoDS_Shape, look: ItemLook): void {
  const rgba = (a: Appearance) => {
    const n = Number.parseInt(a.color.slice(1), 16);
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return s.track(new oc.Quantity_ColorRGBA(lin(((n >> 16) & 255) / 255), lin(((n >> 8) & 255) / 255), lin((n & 255) / 255), a.opacity ?? 1));
  };
  const surface = oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf;
  if (look.look) colours.SetColor(label, rgba(look.look), surface);
  if (!look.faces) return;
  const faces = listFaces(oc, s, shape);
  if (faces.length !== look.faces.length) return;
  faces.forEach((f, i) => {
    const l = look.faces![i];
    if (!l || sameAppearance(l, look.look)) return;
    const sub = s.track(shapes.AddSubShape(label, f) as never) as { IsNull(): boolean };
    if (!sub.IsNull()) colours.SetColor(sub, rgba(l), surface);
  });
}

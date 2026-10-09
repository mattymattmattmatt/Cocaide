// Shell and Draft: on the faces picked in the view.
// Shell removes the selected faces and leaves 2 mm walls (nothing selected: a
// closed hollow body). Draft tapers the selected faces 3° about a neutral
// plane: a selected flat face square to all the others (the base the rest
// stand on), or a selected plane; else the part's bottom face along the pull,
// else the default plane square to every face drafted.

import type { FaceSelector, Vec3 } from "../../../doc/types";
import { dot3 } from "../../../geom/vec";
import { faceSelectorFor, facesSelectorFor } from "../../../kernel/synthesize";
import type { FaceInfo } from "../../../kernel/topology";
import { datumKindOf } from "../selection";
import type { ContextTarget, Raw, ToolCtx, ToolDef } from "../ToolContext";

const SQUARE = 1e-6;

/** The new shell of the selected faces (or of the picked body, closed), or what to do first. */
export function shellFeature(ctx: ToolCtx): Raw | string {
  const { view, selection } = ctx;
  if (!ctx.doc || !view || view.bodies.length === 0) return "Shell needs a solid: make one first.";
  const feature: Raw = { id: ctx.nextId("shell"), op: "shell", faces: [], thickness: 2 };
  if (selection.faces.length) {
    const s = facesSelectorFor(view.faces, selection.faces);
    if (!s.ok) return s.error;
    feature.faces = s.selector;
  } else if (view.bodies.length > 1) {
    const body = ctx.pickedBody();
    if (body) feature.body = body;
  }
  return feature;
}

/** The default planes, with their normals: the pull directions a draft about them has. */
const DEFAULT_PLANES: [string, Vec3][] = [
  ["Top", [0, 0, 1]],
  ["Front", [0, -1, 0]],
  ["Right", [1, 0, 0]],
];

/** The directions a face runs along: a flat face's plane; a cylinder's axis. A pull must lie in them (be square to the normal). */
function squareTo(face: FaceInfo, pull: Vec3): boolean {
  if (face.type === "plane" && face.normal) return Math.abs(dot3(face.normal, pull)) < SQUARE;
  if (face.type === "cylinder" && face.cylinder) return Math.abs(Math.abs(dot3(face.cylinder.axis, pull)) - 1) < SQUARE;
  return false;
}

/**
 * The neutral plane for drafting these faces, and the faces left to draft:
 * a selected flat face square to all the others (the base: of several, the
 * one facing up or down), else a selected plane, else the lowest flat face of the part
 * facing against the pull (its bottom), else the default plane square to
 * every face; or why none fits.
 */
export function draftNeutral(faces: FaceInfo[], all: FaceInfo[], datums: { id: string; kind?: string }[] = []): { neutral: Raw; faces: FaceInfo[] } | string {
  const flat = faces.filter((f) => f.type === "plane" && f.normal);
  // Faces square to each other could each be the base (two adjacent sides): of those, one facing up or down
  // (parts stand on Top) is clearly it; else only a single candidate is. Else the default planes decide.
  const candidates = faces.length > 1 ? flat.filter((b) => faces.every((f) => f === b || squareTo(f, b.normal!))) : [];
  const level = candidates.filter((b) => Math.abs(b.normal![2]) > 1 - SQUARE);
  const base = level.length === 1 ? level[0] : candidates.length === 1 ? candidates[0] : undefined;
  if (base) {
    const s = faceSelectorFor(all, base.index);
    if (s.ok) return { neutral: { face: s.selector }, faces: faces.filter((f) => f !== base) };
  }
  const plane = datums.find((d) => d.kind === "plane");
  if (plane) return { neutral: { datum: plane.id }, faces };
  for (const [id, n] of DEFAULT_PLANES) {
    if (!faces.every((f) => squareTo(f, n))) continue;
    // The part's bottom along this pull: the lowest flat face facing against it, if it is one face alone.
    const bottoms = all.filter((f) => f.type === "plane" && f.normal && dot3(f.normal, n) < -1 + SQUARE && f.body === faces[0]?.body);
    const lowest = bottoms.sort((a, b) => b.offset! - a.offset!)[0];
    const s = lowest && faceSelectorFor(all, lowest.index);
    if (s && s.ok) return { neutral: { face: s.selector as FaceSelector }, faces };
    return { neutral: { datum: id }, faces };
  }
  return "No default plane is square to all those faces: pick the neutral plane (a flat face or a plane) with them, or set it in Properties.";
}

/** The new draft of the selected faces, or what to do first. */
export function draftFeature(ctx: ToolCtx): Raw | string {
  const { view, selection } = ctx;
  if (!ctx.doc || !view || view.bodies.length === 0) return "Draft needs a solid: make one first.";
  if (selection.faces.length === 0) return "Click the faces to taper (Ctrl-click for more; add the base face to draft about it), then Draft.";
  const picked = [...new Set(selection.faces)].map((i) => view.faces[i]).filter((f): f is FaceInfo => !!f);
  const datums = (selection.datums ?? []).map((id) => ({ id, kind: datumKindOf(id, view.datums ?? {}) }));
  const n = draftNeutral(picked, view.faces, datums);
  if (typeof n === "string") return n;
  const s = facesSelectorFor(view.faces, n.faces.map((f) => f.index));
  if (!s.ok) return s.error;
  return { id: ctx.nextId("draft"), op: "draft", faces: s.selector, neutral: n.neutral, angle: 3 };
}

const make = (build: (ctx: ToolCtx) => Raw | string) => (ctx: ToolCtx) => {
  const f = build(ctx);
  if (typeof f === "string") ctx.notice(f);
  else ctx.create(f);
};

/** A right-clicked face a draft can taper: some default plane is square to it. */
const draftable = (ctx: ToolCtx, target: ContextTarget) => {
  if (target.kind !== "face") return false;
  const face = ctx.view?.faces[target.index];
  return !!face && DEFAULT_PLANES.some(([, n]) => squareTo(face, n));
};

export const tools: ToolDef[] = [
  {
    id: "tool.shell",
    label: "Shell",
    icon: "shell",
    tab: "features",
    group: "dress",
    title: "Hollow the part: click the faces to remove (Ctrl-click for more), then Shell; nothing selected makes a closed hollow body",
    testId: "tool-shell",
    disabled: (ctx) => (ctx.view && ctx.view.bodies.length === 0 ? "Shell needs a solid" : undefined),
    run: make(shellFeature),
    contextOn: "face",
    contextLabel: "Shell (remove this face)",
    contextTestId: "ctx-shell",
  },
  {
    id: "tool.draft",
    label: "Draft",
    icon: "draft",
    tab: "features",
    group: "dress",
    title: "Taper faces for a mould: click the faces (and the base face to draft about), then Draft",
    testId: "tool-draft",
    disabled: (ctx) => (ctx.view && ctx.view.bodies.length === 0 ? "Draft needs a solid" : undefined),
    run: make(draftFeature),
    contextOn: "face",
    contextLabel: "Draft this face",
    contextTestId: "ctx-draft",
    contextWhen: draftable,
  },
];

// The annotation kinds of wave Q2A in the sheet editor: each kind's
// property panel (made from the engine's schemas, src/drafting/annotate/
// schema.ts, turned into the panel's fields), its words in the tree, and its
// drag and grips (its text or symbol, held from its view's centre, or a
// sheet item's own place). The kinds Q2B registered keep their moves and
// gain the new fields. Registration only: the tools that make them are Q3A's.

import type { Vec2 } from "../../../doc/types";
import { ANNOTATION_SCHEMAS, TOLERANCE_SCHEMA, WELD_SIDE_SCHEMA, type FieldSchema } from "../../../drafting/annotate";
import type { IconName } from "../../icons";
import { tenth } from "../align";
import type { SnapKind } from "../snap";
import { annotationKind, registerAnnotationKind, type AnnotationKindDef, type Grip, type KindCtx } from "./kinds";
import type { PropField } from "./schema";

const PICKS: SnapKind[] = ["vertex", "centre", "quadrant", "midpoint", "edge", "circle", "arc"];

/** The engine's fields as the panel's: nested ones (a tolerance, a frame's first row, a weld side) flattened to paths. */
function fieldsOf(schema: FieldSchema[]): PropField[] {
  const out: PropField[] = [];
  for (const f of schema) {
    const common = { label: f.label, optional: !f.required, ...(f.help ? { help: f.help } : {}) };
    switch (f.kind) {
      case "text":
      case "id":
        out.push({ key: f.key, kind: "text", ...common });
        break;
      case "richText":
        out.push({ key: f.key, kind: f.key === "text" ? "textarea" : "text", ...common });
        break;
      case "number":
        out.push({ key: f.key, kind: "number", ...common });
        break;
      case "integer":
        out.push({ key: f.key, kind: "number", integer: true, ...common });
        break;
      case "boolean":
        out.push({ key: f.key, kind: "bool", ...common });
        break;
      case "enum":
        out.push({ key: f.key, kind: "select", options: f.options ?? [], ...common });
        break;
      case "georef":
        out.push({ key: f.key, kind: "ref", picks: PICKS, ...common });
        break;
      case "point":
        out.push({ key: f.key, kind: "vec2", ...common, optional: true });
        break;
      case "georefs":
        out.push({ key: `${f.key}.0`, kind: "ref", picks: PICKS, ...common, label: `${f.label} (1)` }, { key: `${f.key}.1`, kind: "ref", picks: PICKS, ...common, label: `${f.label} (2)`, optional: true });
        break;
      case "tolerance":
        for (const t of TOLERANCE_SCHEMA) out.push(...fieldsOf([{ ...t, key: `tolerance.${t.key}`, required: false, label: t.key === "kind" ? f.label : t.label }]));
        break;
      case "weldSide":
        for (const t of WELD_SIDE_SCHEMA) out.push(...fieldsOf([{ ...t, key: `${f.key}.${t.key}`, required: false, label: `${f.label}: ${t.label}` }]));
        break;
      case "gdtRows":
        out.push(
          { key: "rows.0.characteristic", kind: "select", label: "Characteristic", options: f.options ?? [] },
          { key: "rows.0.tolerance", kind: "number", label: "Tolerance", positive: true },
          { key: "rows.0.diameter", kind: "bool", label: "Ø zone", optional: true },
          { key: "rows.0.material", kind: "select", label: "Material", options: ["M", "L"], optional: true, placeholder: "none" },
          { key: "rows.0.datums.0.label", kind: "text", label: "Datum 1", optional: true },
          { key: "rows.0.datums.1.label", kind: "text", label: "Datum 2", optional: true },
          { key: "rows.0.datums.2.label", kind: "text", label: "Datum 3", optional: true },
        );
        break;
      default:
        // Lists of leaders, sketch items, points: edited by their tools and by the AI.
        break;
    }
  }
  return out;
}

/** In a view: `at` from its centre, made from where it is drawn now. On the sheet: `at` moved by the drag. */
function moveAt(a: Record<string, unknown>, delta: Vec2, ctx: KindCtx): Record<string, unknown> | null {
  const placed = (ctx.said?.at ?? a.at) as Vec2 | undefined;
  if (!placed) return null;
  const cv = typeof a.view === "string" ? ctx.sheet.views.find((v) => v.id === a.view) : undefined;
  const c: Vec2 = cv ? cv.centre : [0, 0];
  // A note's `at` is its text's start; laid out, the same.
  return { at: [tenth(placed[0] + delta[0] - c[0]), tenth(placed[1] + delta[1] - c[1])] };
}

/** Points held in a list (a cloud's outline, a line's ends): all moved. */
function movePts(a: Record<string, unknown>, delta: Vec2): Record<string, unknown> | null {
  if (!Array.isArray(a.pts)) return null;
  return { pts: (a.pts as Vec2[]).map((p) => [tenth(p[0] + delta[0]), tenth(p[1] + delta[1])]) };
}

const atGrip = (_a: Record<string, unknown>, ctx: KindCtx): Grip[] => (ctx.said?.at ? [{ id: "at", at: ctx.said.at, label: "Drag to move it" }] : []);

const NEW: { type: string; label: string; icon: IconName; prefix: string; pts?: boolean }[] = [
  { type: "gdt", label: "Feature control frame", icon: "check", prefix: "g" },
  { type: "datum", label: "Datum", icon: "datumPoint", prefix: "datum_" },
  { type: "datumTarget", label: "Datum target", icon: "x", prefix: "t" },
  { type: "surface", label: "Surface texture", icon: "check", prefix: "s" },
  { type: "cosmeticThread", label: "Thread callout", icon: "cosmeticThread", prefix: "h" },
  { type: "revisionCloud", label: "Revision cloud", icon: "warning", prefix: "r", pts: true },
  { type: "leader", label: "Leader", icon: "note", prefix: "n" },
  { type: "text", label: "Text", icon: "sketchText", prefix: "n" },
  { type: "line", label: "Line", icon: "line", prefix: "k", pts: true },
  { type: "sketch", label: "Sketch", icon: "sketch", prefix: "k" },
];

for (const k of NEW) {
  const def: AnnotationKindDef = {
    type: k.type,
    label: k.label,
    icon: k.icon,
    prefix: k.prefix,
    schema: { fields: fieldsOf(ANNOTATION_SCHEMAS[k.type as keyof typeof ANNOTATION_SCHEMAS]) },
    describe: (_a, said) => `${k.label.toLowerCase()} ${said?.text ?? ""}`.trim().slice(0, 70),
    ...(k.pts
      ? { move: (a, d) => movePts(a, d) }
      : k.type === "sketch"
        ? {}
        : { move: moveAt, grips: atGrip, dragGrip: (a: Record<string, unknown>, _g: Grip, d: Vec2, ctx: KindCtx) => moveAt(a, d, ctx) }),
  };
  registerAnnotationKind(def);
}

// The kinds Q2B registered: their moves stay, their panels gain the new fields (kind, refs, tolerance, symbols ...).
for (const type of ["dimension", "hole", "balloon", "weld", "note", "centerMark"] as const) {
  const old = annotationKind(type);
  if (!old) continue;
  const have = new Set(old.schema.fields.map((f) => f.key));
  const extra = fieldsOf(ANNOTATION_SCHEMAS[type]).filter((f) => !have.has(f.key) && !have.has(f.key.split(".")[0]));
  registerAnnotationKind({ ...old, schema: { fields: [...old.schema.fields, ...extra] } });
}

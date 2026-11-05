// A tool's annotation laid out before it is kept (Phase Q wave Q3A): the
// engine lays it out in the context the sheet was composed in (its views,
// its data, what is already where), so the preview that follows the pointer
// is exactly what OK will draw: the same arrowheads, text, tolerance stack.

import type { Annotation } from "../../../doc/types";
import { layoutAnnotation, measureDimension, type AnnotationLayout } from "../../../drafting/annotate";
import { LAYOUT_CONTEXT, type ComposedSheet } from "../../../drafting/compose";

/** The annotation as it would be drawn on the sheet, or null when the sheet has no layout context (or it can't be drawn: `problem`). */
export function previewAnnotation(sheet: ComposedSheet | null, a: Annotation): AnnotationLayout | null {
  if (!sheet) return null;
  const ctx = LAYOUT_CONTEXT.get(sheet);
  if (!ctx) return null;
  try {
    if (a.type === "dimension") {
      const cv = sheet.views.find((v) => v.id === a.view);
      if (!cv) return null;
      const m = measureDimension(a, { id: cv.id, edges: cv.edges, frame: cv.frame, outline: cv.outline, square: cv.square }, sheet.points, sheet.points.members);
      return layoutAnnotation(a, ctx, m);
    }
    return layoutAnnotation(a, ctx);
  } catch {
    // A half-made annotation the engine can't lay out yet: no preview.
    return null;
  }
}

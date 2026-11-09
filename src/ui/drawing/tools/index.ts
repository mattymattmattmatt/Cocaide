// The drawing tools (Phase Q wave Q2B): importing this registers every tool
// and annotation kind of this wave. A later wave adds its own module here
// (one import line) and registers through registry.ts and kinds.ts.

import "./kinds";
import "./viewTools";
import "./annotationTools";
import "./sheetTools";
import "./annotationKinds";
// Phase Q wave Q3A: the annotation tools (they replace Q2B's basic ones by id) and their panels.
import "./annotationKindsQ3";
import "./dimensionTools";
import "./symbolTools";
import "./noteTools";
import "./sketchTools";
import "./editing";
// Phase Q wave Q3B: AI detailing (Detail with AI…, Auto-detail, contextual asks).
import "./aiTools";

export * from "./registry";
export * from "./kinds";
export * from "./schema";
export type * from "./types";

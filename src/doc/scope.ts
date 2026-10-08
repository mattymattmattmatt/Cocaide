// writeScope: what one agent turn may change. Enforced by apply(), not by
// the prompt; a command outside the scope is rejected and changes nothing.
//
// Tokens:
//   "<featureId>"   change that feature; add a feature that references it
//                   (a pattern of it, an extrude of a sketch)
//   "<sketch>/*"    the entities and constraints of that sketch, nothing else
//   "<sketch>/<e>"  that entity of the sketch, and the constraints on it
//   "+"             add any new feature, or a new parameter
//   "param:<name>"  change that parameter
//   "name"          rename the document
//   "photo"         move or rescale the photo's scale (never confirm it: only the user can)
//   "body:<name>"   add features that touch only that body (sketches touch none); rename it
//   "node:<name>"   move or rename that node
//   "weld:<id>"     change or remove that weld in the weld table ("+" adds one)
//   "drawing"       anything in the drawing (never the part's features)
//   "view:<id>"     that view, the annotations in it, and new annotations in it
//   "annotation:<id>" that annotation, in the view it is in
//   "*"             anything (the whole part)
// A parameter change is also allowed when every feature that uses the
// parameter is in scope, and so is a node move when every feature that names
// the node is.

import type { Command, RawDocument } from "./commands";
import { nodeUsers, references } from "./commands";
import { isObject } from "./validate";
import { documentParameters, parameterRefs } from "./parameters";
import { rawConstraintEntities } from "./sketch";
import { DEFAULT_BODY } from "./types";

export type WriteScope = string[];

/** Null when the scope allows the command, else the rejection text. */
export function scopeProblem(doc: RawDocument, cmd: Command, scope: WriteScope | undefined): string | null {
  if (!scope || scope.includes("*")) return null;
  const has = (t: string) => scope.includes(t);
  let allowed: boolean;
  let what: string;
  switch (cmd.type) {
    case "addFeature": {
      const f = cmd.feature as Record<string, unknown>;
      what = `addFeature "${String(f.id)}"`;
      allowed = has("+") || references(f).some(has) || onlyBodies(doc, f, scope);
      break;
    }
    case "updateFeature":
    case "replaceFeature": {
      what = `${cmd.type} "${cmd.id}"`;
      // Sketch-content scope covers a rewrite that only touches entities and constraints.
      const before = doc.features.find((f) => isObject(f) && f.id === cmd.id);
      const after = cmd.type === "updateFeature" ? { ...before, ...cmd.patch } : (cmd.feature as Record<string, unknown>);
      allowed = has(cmd.id) || (has(`${cmd.id}/*`) && !!before && onlyContentsChanged(before, after));
      break;
    }
    case "deleteFeature":
    case "reorderFeature":
    case "suppressFeature":
      what = `${cmd.type} "${cmd.id}"`;
      allowed = has(cmd.id);
      break;
    case "setDimension":
    case "deleteConstraint": {
      what = `${cmd.type} ${cmd.index} on "${cmd.sketch}"`;
      const k = sketchConstraints(doc, cmd.sketch)[cmd.index];
      allowed = sketchWide(cmd.sketch) || rawConstraintEntities(k).some((e) => has(`${cmd.sketch}/${e}`));
      break;
    }
    case "addConstraint":
      what = `addConstraint on "${cmd.sketch}"`;
      allowed = sketchWide(cmd.sketch) || rawConstraintEntities(cmd.constraint).some((e) => has(`${cmd.sketch}/${e}`));
      break;
    case "updateEntity":
    case "deleteEntity":
      what = `${cmd.type} "${cmd.id}" in "${cmd.sketch}"`;
      allowed = sketchWide(cmd.sketch) || has(`${cmd.sketch}/${cmd.id}`);
      break;
    case "addEntity":
      what = `addEntity in "${cmd.sketch}"`;
      allowed = sketchWide(cmd.sketch);
      break;
    case "setParameter":
    case "deleteParameter": {
      what = `${cmd.type} "${cmd.name}"`;
      // A parameter moves the features that use it, and the members on nodes that use it.
      const nodes = Object.entries(isObject(doc.nodes) ? doc.nodes : {}).filter(([, at]) => parameterRefs(at).has(cmd.name)).map(([n]) => n);
      const users = [
        ...doc.features.filter((f) => isObject(f) && parameterRefs(f).has(cmd.name)).map((f) => String(f.id)),
        ...nodes.flatMap((n) => nodeUsers(doc.features, n)),
      ];
      const isNew = cmd.type === "setParameter" && !(cmd.name in documentParameters(doc));
      allowed = has(`param:${cmd.name}`) || (users.length > 0 && users.every(has)) || (isNew && has("+"));
      break;
    }
    case "setName":
      what = "setName";
      allowed = has("name");
      break;
    case "setPhotoScale":
      what = "setPhotoScale";
      allowed = has("photo");
      break;
    case "renameBody":
      what = `renameBody "${cmd.from}"`;
      allowed = has(`body:${cmd.from}`);
      break;
    case "setProfile":
      // A copy of a library profile adds nothing to the part until a member uses it.
      what = `setProfile "${cmd.name}"`;
      allowed = has("+");
      break;
    case "setNode": {
      what = `setNode "${cmd.name}"`;
      const users = nodeUsers(doc.features, cmd.name);
      const isNew = !(isObject(doc.nodes) && cmd.name in doc.nodes);
      allowed = has(`node:${cmd.name}`) || (users.length > 0 && users.every(has)) || (isNew && has("+"));
      break;
    }
    case "renameNode":
      what = `renameNode "${cmd.from}"`;
      allowed = has(`node:${cmd.from}`);
      break;
    case "setWeld": {
      what = `setWeld "${cmd.id}"`;
      const exists = Array.isArray(doc.welds) && doc.welds.some((w) => isObject(w) && w.id === cmd.id);
      allowed = has(`weld:${cmd.id}`) || (!exists && has("+"));
      break;
    }
    case "setDrawing":
    case "setSheet":
      what = cmd.type;
      allowed = has("drawing");
      break;
    case "setView":
      what = `setView "${cmd.id}"`;
      allowed = has("drawing") || has(`view:${cmd.id}`);
      break;
    case "setAnnotation": {
      what = `setAnnotation "${cmd.id}"`;
      const drawing = isObject(doc.drawing) && Array.isArray(doc.drawing.annotations) ? doc.drawing.annotations : [];
      const before = drawing.find((a) => isObject(a) && a.id === cmd.id) as Record<string, unknown> | undefined;
      const after = cmd.annotation as Record<string, unknown> | null;
      // The views it is in before and after: both must be in scope for a view-wide token.
      const views = [before?.view, after?.view].filter((v) => v !== undefined);
      const inViews = views.length > 0 && views.every((v) => has(`view:${String(v)}`));
      const sameView = !!before && (after === null || after.view === before.view);
      allowed = has("drawing") || inViews || (has(`annotation:${cmd.id}`) && sameView);
      break;
    }
    default:
      return "writeScope: unknown command";
  }
  return allowed ? null : `writeScope: ${what} is outside the scope [${scope.join(", ")}]`;

  function sketchWide(sketch: string) {
    return has(sketch) || has(`${sketch}/*`);
  }
}

function sketchConstraints(doc: RawDocument, sketch: string): unknown[] {
  const f = doc.features.find((x) => isObject(x) && x.id === sketch);
  return f && Array.isArray(f.constraints) ? f.constraints : [];
}

/** True when two versions of a feature differ only in entities and constraints. */
function onlyContentsChanged(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (k === "entities" || k === "constraints") continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) return false;
  }
  return true;
}

/**
 * True when a new feature touches only bodies the scope names ("body:base"):
 * an extrude into one of them, a cut or hole that lists only them, an edge
 * treatment whose selectors all name one, a combine of them, a pattern of
 * such a feature. A sketch touches no body. Anything that would reach every
 * body (a cut with no list) does not count.
 */
function onlyBodies(doc: RawDocument, f: Record<string, unknown>, scope: WriteScope, depth = 0): boolean {
  const bodies = scope.filter((t) => t.startsWith("body:")).map((t) => t.slice(5));
  if (bodies.length === 0 || depth > 8) return false;
  const inScope = (n: unknown) => typeof n === "string" && bodies.includes(n);
  switch (f.op) {
    case "sketch":
      return true;
    case "extrude":
      return inScope(f.newBody ?? f.body ?? DEFAULT_BODY);
    case "cut":
    case "hole":
      return Array.isArray(f.bodies) && f.bodies.length > 0 && f.bodies.every(inScope);
    case "fillet":
    case "chamfer": {
      const list = Array.isArray(f.edges) ? f.edges : [f.edges];
      return list.length > 0 && list.every((e) => isObject(e) && inScope(e.body));
    }
    case "combine":
      return inScope(f.target) && Array.isArray(f.tools) && f.tools.every(inScope);
    case "member":
    case "endCap":
    case "gusset":
      return inScope(f.newBody ?? f.id);
    case "joint": {
      // A joint trims every member at its node.
      const at = doc.features.filter((x) => isObject(x) && x.op === "member" && (x.from === f.node || x.to === f.node));
      const named = [...(Array.isArray(f.members) ? f.members : []), f.through].filter((x): x is string => typeof x === "string");
      const touched = [...at, ...doc.features.filter((x) => isObject(x) && named.includes(String(x.id)))];
      return touched.length > 0 && touched.every((x) => inScope(x.newBody ?? x.id));
    }
    case "linearPattern":
    case "circularPattern": {
      const seed = doc.features.find((x) => isObject(x) && x.id === f.feature);
      return !!seed && onlyBodies(doc, seed, scope, depth + 1);
    }
    default:
      return false;
  }
}

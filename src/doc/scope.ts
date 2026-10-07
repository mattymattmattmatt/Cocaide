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
//   "*"             anything (the whole part)
// A parameter change is also allowed when every feature that uses the
// parameter is in scope.

import type { Command, RawDocument } from "./commands";
import { references } from "./commands";
import { isObject } from "./validate";
import { documentParameters, parameterRefs } from "./parameters";
import { rawConstraintEntities } from "./sketch";

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
      allowed = has("+") || references(f).some(has);
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
      const users = doc.features.filter((f) => isObject(f) && parameterRefs(f).has(cmd.name)).map((f) => String(f.id));
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

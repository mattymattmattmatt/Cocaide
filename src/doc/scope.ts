// writeScope: what one agent turn may change. Enforced by apply(), not by
// the prompt; a command outside the scope is rejected and changes nothing.
//
// Tokens:
//   "<featureId>"   change that feature; add a feature that references it
//                   (a pattern of it, an extrude of a sketch)
//   "+"             add any new feature, or a new parameter
//   "param:<name>"  change that parameter
//   "name"          rename the document
//   "*"             anything (the whole part)
// A parameter change is also allowed when every feature that uses the
// parameter is in scope.

import type { Command, RawDocument } from "./commands";
import { references } from "./commands";
import { isObject } from "./validate";
import { documentParameters, parameterRefs } from "./parameters";

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
    case "replaceFeature":
    case "deleteFeature":
    case "reorderFeature":
    case "suppressFeature":
      what = `${cmd.type} "${cmd.id}"`;
      allowed = has(cmd.id);
      break;
    case "setDimension":
      what = `setDimension on "${cmd.sketch}"`;
      allowed = has(cmd.sketch);
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
    default:
      return "writeScope: unknown command";
  }
  return allowed ? null : `writeScope: ${what} is outside the scope [${scope.join(", ")}]`;
}

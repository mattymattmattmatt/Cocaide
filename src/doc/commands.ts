// apply(doc, command): every edit to a document goes through here. The UI
// uses it now; the agent tools use the same function in Phase C.
//
// Commands work on the raw JSON so a document can be edited while some of its
// features are invalid. A command is rejected, leaving the document as it
// was, if it would introduce a validation error that was not there before
// (a bad field, a broken reference, a duplicate id).

import { checkConstraints } from "../geom/constraints";
import { solveSketch, wouldOverDefine } from "../geom/solver";
import { documentParameters, isExpression, PARAMETER_NAME, parameterRefs, rawParameters, resolveExpressions, type Parameters } from "./parameters";
import { dependentNames, DIMENSION_NAME, dimensionNames, documentSymbols, isDimension, namedDimensions, pinReferencedNames, readersOf, referencedNames, renameInDocument, symbolEntries } from "./dimensions";
import { measureConstraint } from "../geom/constraints";
import { isDriven } from "../geom/axes";
import { mmPerPixel, photoOf, rescaled } from "./photo";
import { scopeProblem, type WriteScope } from "./scope";
import { ENTITY_PREFIX, nextEntityId, removeEntities } from "./sketch";
import { annotationTargetProblem, dependentViews, drawingTargets, migrateDrawing, migrateView, nextSheetId, nextViewLabel, rawAnnotations, rawDrawing, renameInDrawing, viewKind, type RawSheet } from "./drawing";
import { checkCutList, mergeCutList } from "./cutListSettings";
import { setTableIn } from "../drafting/tables/validate";
import type { DrawingTable } from "../drafting/tables/types";
import {
  BODY_NAME,
  DEFAULT_BODY,
  DERIVED_SUFFIX,
  FORMAT_KEYS,
  NODE_NAME,
  seedIds,
  type Annotation,
  type Constraint,
  type Drawing,
  type DrawingView,
  type Feature,
  type Material,
  type PhotoUnderlay,
  type ProfileDef,
  type SketchEntity,
  type Vec2,
  type Weld,
} from "./types";
import { allErrors, isObject, validateDocument } from "./validate";
import { defOf } from "../features/defs";
import { datumFeatureIds, featureDatumRefs, mapDatumSelector } from "../features/datum";
import { foldersAfterMove, foldersOf, orderProblems, renameCreatedBy } from "./tree";

/** A document as plain JSON: what a .cocaide.json parses to. */
export type RawDocument = Record<string, unknown> & { features: Record<string, unknown>[] };

export type Command =
  | { type: "addFeature"; feature: Record<string, unknown> | Feature; index?: number }
  /** Shallow merge into the feature; a value of null removes that field. */
  | { type: "updateFeature"; id: string; patch: Record<string, unknown> }
  /**
   * `renames` (a sketch's only): its dimensions whose names changed in the edit, old full name to new
   * ("sketch_1.d3": "sketch_1.width"); every expression that read the old name reads the new one.
   */
  | { type: "replaceFeature"; id: string; feature: Record<string, unknown> | Feature; renames?: Record<string, string> }
  | { type: "deleteFeature"; id: string }
  /**
   * Moves a feature to `index` in the history. Refused when it would come before what it uses (a sketch, a
   * feature whose faces it picks, a sketch whose dimensions it reads) or after what uses it. `folder`: the folder
   * it goes in (null: none); left out, it joins a folder it lands inside and leaves its own when moved away.
   */
  | { type: "reorderFeature"; id: string; index: number; folder?: string | null }
  | { type: "suppressFeature"; id: string; suppressed: boolean }
  /** Several new features at once (paste, duplicate): at `index`, or at the rollback bar; one undo step. */
  | { type: "insertFeatures"; features: (Record<string, unknown> | Feature)[]; index?: number; folder?: string }
  /**
   * Adds, changes (name, features: merged) or removes (null) a folder of the tree. Its features must be next to
   * each other in the history. Removing a folder keeps its features.
   */
  | { type: "setFolder"; id: string; folder: { name?: string; features?: string[] } | null }
  /** Suppresses (or unsuppresses) every feature of a folder. */
  | { type: "suppressFolder"; id: string; suppressed: boolean }
  | { type: "setName"; name: string }
  /** Sets a document parameter (a number, or "=expression"); sketches whose dimensions use it are re-solved. */
  | { type: "setParameter"; name: string; value: number | string }
  /** Removes a parameter nothing uses. */
  | { type: "deleteParameter"; name: string }
  /** Renames a parameter; every expression that reads it follows. */
  | { type: "renameParameter"; from: string; to: string }
  /**
   * Changes one dimension of a sketch (a constraint's value, or "=expr") and re-solves the sketch.
   * The dimension is picked by `index` (its constraint's place) or by `name` ("d3", "width").
   */
  | { type: "setDimension"; sketch: string; index?: number; name?: string; value: number | string }
  /** Names a dimension (`to`); every expression that reads it by its old name follows. */
  | { type: "renameDimension"; sketch: string; index?: number; name?: string; to: string }
  /** Makes a dimension driven (measured, never solved) or driving again. */
  | { type: "setDriven"; sketch: string; index?: number; name?: string; driven: boolean }
  // Inside one sketch. Each re-solves the sketch so its constraints still hold.
  | { type: "addEntity"; sketch: string; entity: Record<string, unknown> }
  /** Merges into the entity (null removes a field); the fields it sets are held while the sketch re-solves. */
  | { type: "updateEntity"; sketch: string; id: string; patch: Record<string, unknown> }
  /** Removes the entity and every constraint on it. */
  | { type: "deleteEntity"; sketch: string; id: string }
  | { type: "addConstraint"; sketch: string; constraint: Record<string, unknown> }
  | { type: "deleteConstraint"; sketch: string; index: number }
  /**
   * Moves the photo's scale points or changes the length between them, which
   * rescales every size estimated from the photo. `confirm` marks the scale
   * confirmed; only the user can, in the app.
   */
  | { type: "setPhotoScale"; from?: Vec2; to?: Vec2; length?: number; what?: string; confirm?: boolean }
  /** Renames a body; every feature and selector that names it follows. */
  | { type: "renameBody"; from: string; to: string }
  /** Puts a weldment profile in the part's profiles (a copy from the library), or removes one nothing uses. */
  | { type: "setProfile"; name: string; profile: ProfileDef | Record<string, unknown> | null }
  /** Adds or moves a node (coordinates may be expressions), or removes one nothing names. */
  | { type: "setNode"; name: string; at: (number | string)[] | null }
  /** Renames a node; the members, joints and gussets that name it follow. */
  | { type: "renameNode"; from: string; to: string }
  /** Adds or replaces a weld in the weld table by id, or removes it. */
  | { type: "setWeld"; id: string; weld: Weld | Record<string, unknown> | null }
  /** Puts a whole drawing in the part (New drawing), or removes it. A Phase L drawing ({ sheet, views, annotations }) is taken as one sheet. */
  | { type: "setDrawing"; drawing: Drawing | Record<string, unknown> | null }
  /**
   * Changes a sheet (`sheet`, default the first): its format (size, orientation, template and the title block's
   * fields: title, number, revision, drawnBy, date ...), scale, projection, name. Shallow merge; null removes a field.
   */
  | { type: "setSheet"; patch: Record<string, unknown>; sheet?: string }
  /** Adds a sheet (after the others, or at `index`): its format, projection and title block from the sheet before it unless given. */
  | { type: "addSheet"; id?: string; sheet?: Record<string, unknown>; index?: number }
  /** Renames a sheet's tab. */
  | { type: "renameSheet"; id: string; name: string }
  /** Deletes a sheet with its views and annotations (never the last one). */
  | { type: "deleteSheet"; id: string }
  /** Moves a sheet to place `index` (0 = first). */
  | { type: "moveSheet"; id: string; index: number }
  /** The drawing's own settings: standard, units, generalTolerance, properties, revisions (merged in; null removes one; properties and revisions are replaced whole). */
  | { type: "setDrawingOptions"; patch: Record<string, unknown> }
  /**
   * Adds or replaces a view by id (on `sheet`, else the sheet it is on, else the first), or removes it with every
   * annotation in it and the views made from it. A new section, detail or auxiliary view gets the next free label.
   */
  | { type: "setView"; id: string; view: DrawingView | Record<string, unknown> | null; sheet?: string }
  /** Moves a view: to `at` on its sheet (null: back to its automatic place), and/or to another sheet with its annotations. */
  | { type: "moveView"; id: string; at?: Vec2 | null; sheet?: string }
  /** Adds or replaces a table (cut list, BOM, holes, welds, revisions, general, stock) on a sheet (`sheet`, else the one holding it, else the first) by id, or removes it (null). */
  | { type: "setTable"; id: string; table: Record<string, unknown> | null; sheet?: string }
  /** Adds or replaces an annotation by id (on its view's sheet; a note or table on `sheet`, else the first), or removes it. What it points at must be in the part. */
  | { type: "setAnnotation"; id: string; annotation: Annotation | Record<string, unknown> | null; sheet?: string }
  /** Gives a body its own material, or puts it back on the part's (null). */
  | { type: "setBodyMaterial"; body: string; material: Material | Record<string, unknown> | null }
  /**
   * Changes the part's properties (partNumber, description, revision, author, finish, custom). Merged in;
   * null or "" removes a field; "custom" replaces the custom properties whole (a name with null or "" goes).
   */
  | { type: "setProperties"; patch: Record<string, unknown> }
  /**
   * Changes the cut list's settings and text (Phase Q, src/doc/cutListSettings.ts): tolerance, stock
   * (merged one level), items (item numbers and item text, replaced whole), members (text by member id or
   * body name, merged; null removes one). null removes a field; an empty result removes `cutList`.
   */
  | { type: "setCutList"; patch: Record<string, unknown> }
  /**
   * Moves the rollback bar to just above feature `before` (it and the features after it are not built in the
   * view, and new features go in there), or to the end (null). See src/doc/rollback.ts.
   */
  | { type: "setRollback"; before: string | null };

export type ApplyResult = { ok: true; doc: RawDocument } | { ok: false; error: string };

export interface ApplyOptions {
  /** When given, the command must fall inside it (see scope.ts). */
  writeScope?: WriteScope;
  /** The person at the app made this edit, not an agent. Only they can confirm a photo's scale. */
  user?: boolean;
}

export function apply(input: unknown, cmd: Command, opts: ApplyOptions = {}): ApplyResult {
  if (!isObject(input) || !Array.isArray(input.features)) {
    return { ok: false, error: "document: not a document (needs a features array)" };
  }
  const outside = scopeProblem(input as RawDocument, cmd, opts.writeScope);
  if (outside) return { ok: false, error: outside };
  const doc = structuredClone(input) as RawDocument;
  // A dimension an expression reads by its default name keeps that name, whatever this command deletes.
  pinReferencedNames(doc);
  /** The dimensions expressions read, each now with a name of its own. */
  const readBefore = [...referencedNames(doc)].filter((n) => namedDimensions(doc).has(n));
  const features = doc.features;
  const indexOf = (id: string) => features.findIndex((f) => isObject(f) && f.id === id);
  const need = (id: string): number | string => {
    const i = indexOf(id);
    return i < 0 ? `${cmd.type}: no feature "${id}"` : i;
  };

  switch (cmd.type) {
    case "addFeature": {
      const f = structuredClone(cmd.feature) as Record<string, unknown>;
      if (typeof f.id === "string" && indexOf(f.id) >= 0) {
        return { ok: false, error: `addFeature: a feature "${f.id}" already exists` };
      }
      // Without an index it goes in at the rollback bar: just above the first feature below it (the end when there is none).
      const bar = typeof doc.rollback === "string" ? indexOf(doc.rollback) : -1;
      const at = cmd.index ?? (bar >= 0 ? bar : features.length);
      if (!Number.isInteger(at) || at < 0 || at > features.length) {
        return { ok: false, error: `addFeature: index ${at} is outside 0..${features.length}` };
      }
      features.splice(at, 0, f);
      break;
    }
    case "insertFeatures": {
      if (!Array.isArray(cmd.features) || cmd.features.length === 0) return { ok: false, error: "insertFeatures: features must be a list of features" };
      const list = cmd.features.map((f) => structuredClone(f) as Record<string, unknown>);
      for (const f of list) {
        if (typeof f.id === "string" && (indexOf(f.id) >= 0 || list.filter((g) => g.id === f.id).length > 1)) return { ok: false, error: `insertFeatures: a feature "${f.id}" already exists` };
      }
      const bar = typeof doc.rollback === "string" ? indexOf(doc.rollback) : -1;
      const at = cmd.index ?? (bar >= 0 ? bar : features.length);
      if (!Number.isInteger(at) || at < 0 || at > features.length) return { ok: false, error: `insertFeatures: index ${at} is outside 0..${features.length}` };
      features.splice(at, 0, ...list);
      if (cmd.folder !== undefined) {
        const folders = foldersOf(doc);
        const f = folders.find((x) => x.id === cmd.folder);
        if (!f) return { ok: false, error: `insertFeatures: no folder "${cmd.folder}"` };
        f.features = [...f.features, ...list.map((x) => String(x.id))];
        doc.folders = folders;
      }
      break;
    }
    case "setFolder": {
      const folders = foldersOf(doc).map((f) => ({ ...f }));
      const i = folders.findIndex((f) => f.id === cmd.id);
      if (cmd.folder === null) {
        if (i < 0) return { ok: false, error: `setFolder: no folder "${cmd.id}"` };
        folders.splice(i, 1);
      } else {
        if (!isObject(cmd.folder)) return { ok: false, error: `setFolder: folder must be { name, features } or null (got ${JSON.stringify(cmd.folder)})` };
        if (i < 0 && indexOf(cmd.id) >= 0) return { ok: false, error: `setFolder: "${cmd.id}" is a feature's id; give the folder another` };
        const was = i >= 0 ? folders[i] : { id: cmd.id, name: cmd.id, features: [] as string[] };
        const next = { ...was, ...(cmd.folder.name !== undefined ? { name: cmd.folder.name } : {}), ...(cmd.folder.features !== undefined ? { features: [...cmd.folder.features] } : {}) };
        // A feature is in one folder: taken into this one, it leaves its other.
        const order = features.map((f) => String(f.id));
        next.features.sort((a, b) => order.indexOf(a) - order.indexOf(b));
        for (const f of folders) if (f.id !== cmd.id) f.features = f.features.filter((x) => !next.features.includes(x));
        if (i >= 0) folders[i] = next;
        else folders.push(next);
        for (let k = folders.length - 1; k >= 0; k--) if (folders[k].features.length === 0 && folders[k].id !== cmd.id) folders.splice(k, 1);
      }
      if (folders.length) doc.folders = folders;
      else delete doc.folders;
      break;
    }
    case "suppressFolder": {
      const f = foldersOf(doc).find((x) => x.id === cmd.id);
      if (!f) return { ok: false, error: `suppressFolder: no folder "${cmd.id}"` };
      for (const id of f.features) {
        const i = indexOf(id);
        if (i < 0) continue;
        const next = { ...features[i] };
        if (cmd.suppressed) next.suppressed = true;
        else delete next.suppressed;
        features[i] = next;
      }
      break;
    }
    case "updateFeature":
    case "replaceFeature": {
      const i = need(cmd.id);
      if (typeof i === "string") return { ok: false, error: i };
      const next =
        cmd.type === "replaceFeature"
          ? (structuredClone(cmd.feature) as Record<string, unknown>)
          : { ...features[i], ...structuredClone(cmd.patch) };
      for (const [k, v] of Object.entries(next)) if (v === null) delete next[k];
      if (next.id !== cmd.id) {
        const renamed = String(next.id);
        if (indexOf(renamed) >= 0) return { ok: false, error: `${cmd.type}: a feature "${renamed}" already exists` };
        // A reference to one of a renamed sketch's entities ({ sketch, entity }) follows it; any other use keeps the id.
        const users = features.filter((f) => isObject(f) && references(f, { sketchRefs: false }).includes(cmd.id)).map((f) => String((f as { id: unknown }).id));
        if (users.length) {
          return { ok: false, error: `${cmd.type}: cannot rename ${cmd.id}; ${users.join(", ")} ${users.length === 1 ? "uses" : "use"} it` };
        }
        renameSketchRefs(features, cmd.id, renamed);
        // Faces and edges picked by who made them follow the maker's new id; so does its folder.
        renameCreatedBy(features, cmd.id, renamed);
        if (Array.isArray(doc.folders)) doc.folders = foldersOf(doc).map((f) => ({ ...f, features: f.features.map((x) => (x === cmd.id ? renamed : x)) }));
      }
      const prev = features[i];
      features[i] = next;
      // The rollback bar names the feature it sits above: it follows a rename.
      if (next.id !== cmd.id && doc.rollback === cmd.id) doc.rollback = next.id;
      if (cmd.type === "replaceFeature" && cmd.renames && Object.keys(cmd.renames).length) {
        const own = (n: string, id: string) => n.startsWith(`${id}.`) && DIMENSION_NAME.test(n.slice(id.length + 1));
        const bad = Object.entries(cmd.renames).find(([from, to]) => typeof to !== "string" || !own(from, cmd.id) || !own(to, String(next.id)));
        if (bad) return { ok: false, error: `replaceFeature: renames: "${bad[0]}" → "${String(bad[1])}" must both be dimension names of ${cmd.id} (<sketch id>.<name>)` };
        const map = cmd.renames;
        // Old names to new all at once, so two dimensions can swap names.
        renameInDocument(doc, (n) => (Object.prototype.hasOwnProperty.call(map, n) ? map[n] : undefined));
      }
      // Expressions read a sketch's dimensions as <sketch id>.<name>: they follow a renamed sketch.
      if (next.id !== cmd.id && prev.op === "sketch") {
        const from = `${cmd.id}.`;
        renameInDocument(doc, (n) => (n.startsWith(from) ? `${String(next.id)}.${n.slice(from.length)}` : undefined));
      }
      // A sketch's dimensions may drive other sketches' (by expressions): those re-solve.
      if (next.op === "sketch" && prev.op === "sketch") {
        const problem = resolveSketchesUsing(doc, sketchDimensionNames(doc.features[i]), String(next.id));
        if (problem) return { ok: false, error: `${cmd.type}: ${problem}` };
      }
      // The drawing names features by id (balloons, member dimensions, hole callouts): it follows.
      if (next.id !== cmd.id && doc.drawing !== undefined) doc.drawing = renameInDrawing(doc.drawing, "feature", cmd.id, String(next.id));
      // A member, end cap or gusset that names its body by its id renames the body: its welds and material follow.
      const byId = (f: Record<string, unknown>) => ((f.op === "member" || f.op === "endCap" || f.op === "gusset") && f.newBody === undefined) || !!defOf(f.op)?.bodyFromId?.(f);
      if (next.id !== cmd.id && byId(prev) && byId(next)) renameBodyRefs(doc, new Map([[cmd.id, String(next.id)]]));
      break;
    }
    case "deleteFeature": {
      const i = need(cmd.id);
      if (typeof i === "string") return { ok: false, error: i };
      const users = dependants(features, cmd.id);
      if (users.length) {
        return {
          ok: false,
          error: `deleteFeature: ${cmd.id} is used by ${users.join(", ")}; delete or change ${users.length === 1 ? "it" : "them"} first`,
        };
      }
      features.splice(i, 1);
      // Out of its folder; a folder left empty goes.
      if (Array.isArray(doc.folders)) {
        const folders = foldersOf(doc).map((f) => ({ ...f, features: f.features.filter((x) => x !== cmd.id) })).filter((f) => f.features.length);
        if (folders.length) doc.folders = folders;
        else delete doc.folders;
      }
      // The bar sat above the deleted feature: it now sits above the one after it, or at the end.
      if (doc.rollback === cmd.id) {
        const after = features[i];
        if (isObject(after) && typeof after.id === "string") doc.rollback = after.id;
        else delete doc.rollback;
      }
      break;
    }
    case "setRollback": {
      if (cmd.before === null) {
        delete doc.rollback;
        break;
      }
      if (typeof cmd.before !== "string" || indexOf(cmd.before) < 0) {
        return { ok: false, error: `setRollback: no feature "${String(cmd.before)}"; name the feature the bar goes above, or null to roll to the end` };
      }
      doc.rollback = cmd.before;
      break;
    }
    case "reorderFeature": {
      const i = need(cmd.id);
      if (typeof i === "string") return { ok: false, error: i };
      if (!Number.isInteger(cmd.index) || cmd.index < 0 || cmd.index >= features.length) {
        return { ok: false, error: `reorderFeature: index ${cmd.index} is outside 0..${features.length - 1}` };
      }
      const [moved] = features.splice(i, 1);
      // The bar stays between the same features: moving the one just below it leaves the bar above the next one
      // (or at the end), so a feature dragged up out of the rolled-back part does not take the bar with it.
      if (doc.rollback === cmd.id) {
        const after = features[i];
        if (isObject(after) && typeof after.id === "string") doc.rollback = after.id;
        else delete doc.rollback;
      }
      features.splice(cmd.index, 0, moved);
      // Nothing may come to stand before what it uses (that was not so already).
      const was = new Set(orderProblems(input.features as Record<string, unknown>[], (f) => references(f)));
      const problem = orderProblems(features, (f) => references(f)).find((p) => !was.has(p));
      if (problem) return { ok: false, error: `reorderFeature: ${problem}` };
      // Folders stay whole: into the folder it lands inside, out of the one it left.
      const folders = foldersOf(doc);
      if (folders.length || (cmd.folder !== undefined && cmd.folder !== null)) {
        const next = foldersAfterMove(folders, features, cmd.id, cmd.folder);
        if (typeof next === "string") return { ok: false, error: `reorderFeature: ${next}` };
        if (next.length) doc.folders = next;
        else delete doc.folders;
      }
      break;
    }
    case "suppressFeature": {
      const i = need(cmd.id);
      if (typeof i === "string") return { ok: false, error: i };
      const next = { ...features[i] };
      if (cmd.suppressed) next.suppressed = true;
      else delete next.suppressed;
      features[i] = next;
      break;
    }
    case "setName":
      doc.name = cmd.name;
      break;
    case "setParameter": {
      if (typeof cmd.name !== "string" || !PARAMETER_NAME.test(cmd.name)) {
        return { ok: false, error: `setParameter: "${String(cmd.name)}" is not a parameter name (letters, digits, _)` };
      }
      if (!(typeof cmd.value === "number" && Number.isFinite(cmd.value)) && !isExpression(cmd.value)) {
        return { ok: false, error: `setParameter: value must be a number or "=expression" (got ${JSON.stringify(cmd.value)})` };
      }
      if (cmd.name.includes(".") || symbolEntries(doc).get(cmd.name)?.kind === "dimension") {
        return { ok: false, error: `setParameter: "${cmd.name}" is a sketch dimension's name; use setDimension` };
      }
      doc.parameters = { ...rawParameters(doc), [cmd.name]: cmd.value };
      // An equation reading itself, or going round through others, is refused here, plainly.
      const own = documentSymbols(doc).problems[cmd.name];
      if (own) return { ok: false, error: `setParameter: ${cmd.name}: ${own}` };
      const problem = resolveSketchesUsing(doc, [cmd.name]);
      if (problem) return { ok: false, error: `setParameter: ${cmd.name} = ${cmd.value}: ${problem}` };
      // A size the user sets is theirs, not an estimate from the photo.
      forgetEstimate(doc, cmd.name);
      break;
    }
    case "deleteParameter": {
      const params = rawParameters(doc);
      if (!(cmd.name in params)) return { ok: false, error: `deleteParameter: no parameter "${cmd.name}"` };
      const users = features.filter((f) => isObject(f) && parameterRefs(f).has(cmd.name)).map((f) => String(f.id));
      const nodes = Object.entries(isObject(doc.nodes) ? doc.nodes : {}).filter(([, at]) => parameterRefs(at).has(cmd.name)).map(([n]) => `node ${n}`);
      const others = Object.entries(params).filter(([n, v]) => n !== cmd.name && parameterRefs(v).has(cmd.name)).map(([n]) => `parameter ${n}`);
      if (users.length || nodes.length || others.length) return { ok: false, error: `deleteParameter: ${cmd.name} is used by ${[...users, ...nodes, ...others].join(", ")}` };
      delete params[cmd.name];
      if (Object.keys(params).length) doc.parameters = params;
      else delete doc.parameters;
      forgetEstimate(doc, cmd.name);
      break;
    }
    case "renameParameter": {
      const params = rawParameters(doc);
      if (!(cmd.from in params)) return { ok: false, error: `renameParameter: no parameter "${cmd.from}"` };
      if (typeof cmd.to !== "string" || !PARAMETER_NAME.test(cmd.to)) return { ok: false, error: `renameParameter: "${String(cmd.to)}" is not a parameter name (letters, digits, _)` };
      if (cmd.to in params) return { ok: false, error: `renameParameter: there is already a parameter "${cmd.to}"` };
      // Keep the order the parameters are listed in.
      doc.parameters = Object.fromEntries(Object.entries(params).map(([k, v]) => [k === cmd.from ? cmd.to : k, v]));
      renameInDocument(doc, (n) => (n === cmd.from ? cmd.to : undefined));
      const photo = photoOf(doc);
      if (photo && (cmd.from in photo.estimated || photo.scale.parameter === cmd.from)) {
        const estimated = Object.fromEntries(Object.entries(photo.estimated).map(([k, v]) => [k === cmd.from ? cmd.to : k, v]));
        doc.photo = { ...photo, estimated, scale: photo.scale.parameter === cmd.from ? { ...photo.scale, parameter: cmd.to } : photo.scale };
      }
      break;
    }
    case "renameBody": {
      const names = validateDocument(doc).bodies;
      if (!names.includes(cmd.from)) return { ok: false, error: `renameBody: no body "${cmd.from}" (bodies: ${names.join(", ") || "none"})` };
      if (typeof cmd.to !== "string" || !BODY_NAME.test(cmd.to)) return { ok: false, error: `renameBody: "${String(cmd.to)}" is not a body name (letters, digits, _ and -)` };
      if (names.includes(cmd.to)) return { ok: false, error: `renameBody: a body "${cmd.to}" already exists` };
      // What follows the rename, worked out on the features as they were.
      const renamed = renamedBodies(features, cmd.from, cmd.to);
      const problem = renameBody(features, cmd.from, cmd.to);
      if (problem) return { ok: false, error: `renameBody: ${problem}` };
      // The weld table, the bodies' materials and the drawing's balloons name bodies too.
      renameBodyRefs(doc, renamed);
      for (const [a, b] of renamed) if (doc.drawing !== undefined) doc.drawing = renameInDrawing(doc.drawing, "feature", a, b);
      break;
    }
    case "setNode": {
      const nodes = isObject(doc.nodes) ? { ...doc.nodes } : {};
      if (typeof cmd.name !== "string" || !NODE_NAME.test(cmd.name)) {
        return { ok: false, error: `setNode: "${String(cmd.name)}" is not a node name (letters, digits and _, starting with a letter)` };
      }
      if (cmd.at === null) {
        if (!(cmd.name in nodes)) return { ok: false, error: `setNode: no node "${cmd.name}"` };
        const users = nodeUsers(features, cmd.name);
        if (users.length) return { ok: false, error: `setNode: ${cmd.name} is used by ${users.join(", ")}` };
        delete nodes[cmd.name];
      } else {
        if (!Array.isArray(cmd.at) || cmd.at.length !== 3 || !cmd.at.every((x) => (typeof x === "number" && Number.isFinite(x)) || isExpression(x))) {
          return { ok: false, error: `setNode: ${cmd.name} must be at [x, y, z], numbers or =expressions (got ${JSON.stringify(cmd.at)})` };
        }
        nodes[cmd.name] = [...cmd.at];
      }
      if (Object.keys(nodes).length) doc.nodes = nodes;
      else delete doc.nodes;
      break;
    }
    case "renameNode": {
      const nodes = isObject(doc.nodes) ? doc.nodes : {};
      if (!(cmd.from in nodes)) return { ok: false, error: `renameNode: no node "${cmd.from}"` };
      if (typeof cmd.to !== "string" || !NODE_NAME.test(cmd.to)) return { ok: false, error: `renameNode: "${String(cmd.to)}" is not a node name (letters, digits and _, starting with a letter)` };
      if (cmd.to in nodes) return { ok: false, error: `renameNode: a node "${cmd.to}" already exists` };
      // Keep the order nodes are listed in.
      doc.nodes = Object.fromEntries(Object.entries(nodes).map(([k, v]) => [k === cmd.from ? cmd.to : k, v]));
      for (let i = 0; i < features.length; i++) {
        const f = { ...features[i] };
        if (f.op === "member") {
          if (f.from === cmd.from) f.from = cmd.to;
          if (f.to === cmd.from) f.to = cmd.to;
        }
        if ((f.op === "joint" || f.op === "gusset") && f.node === cmd.from) f.node = cmd.to;
        features[i] = f;
      }
      if (doc.drawing !== undefined) doc.drawing = renameInDrawing(doc.drawing, "node", cmd.from, cmd.to);
      break;
    }
    case "setWeld": {
      const welds = Array.isArray(doc.welds) ? [...doc.welds] : [];
      const i = welds.findIndex((w) => isObject(w) && w.id === cmd.id);
      if (cmd.weld === null) {
        if (i < 0) return { ok: false, error: `setWeld: no weld "${cmd.id}"` };
        welds.splice(i, 1);
      } else {
        const w = { ...structuredClone(cmd.weld), id: cmd.id };
        if (i < 0) welds.push(w);
        else welds[i] = w;
      }
      if (welds.length) doc.welds = welds;
      else delete doc.welds;
      break;
    }
    case "setBodyMaterial": {
      const made = validateDocument(doc).madeBodies;
      if (!made.includes(cmd.body)) return { ok: false, error: `setBodyMaterial: no body "${cmd.body}" (bodies: ${made.join(", ") || "none"})` };
      const materials = isObject(doc.bodyMaterials) ? { ...doc.bodyMaterials } : {};
      if (cmd.material === null) delete materials[cmd.body];
      else materials[cmd.body] = structuredClone(cmd.material);
      if (Object.keys(materials).length) doc.bodyMaterials = materials;
      else delete doc.bodyMaterials;
      break;
    }
    case "setProperties": {
      if (!isObject(cmd.patch)) return { ok: false, error: `setProperties: patch must be an object of part properties (got ${JSON.stringify(cmd.patch)})` };
      const next: Record<string, unknown> = { ...(isObject(doc.properties) ? doc.properties : {}), ...structuredClone(cmd.patch) };
      const blank = (v: unknown) => v === null || (typeof v === "string" && v.trim() === "");
      for (const [k, v] of Object.entries(next)) {
        if (blank(v)) delete next[k];
        else if (k === "custom" && isObject(v)) {
          const kept = Object.fromEntries(Object.entries(v).filter(([, x]) => !blank(x)));
          if (Object.keys(kept).length) next.custom = kept;
          else delete next.custom;
        }
      }
      if (Object.keys(next).length) doc.properties = next;
      else delete doc.properties;
      break;
    }
    case "setCutList": {
      if (!isObject(cmd.patch)) return { ok: false, error: `setCutList: patch must be an object of cut list settings: tolerance, stock, items, members (got ${JSON.stringify(cmd.patch)})` };
      let next: Record<string, unknown>;
      try {
        next = mergeCutList(isObject(doc.cutList) ? doc.cutList : {}, cmd.patch);
      } catch (e) {
        return { ok: false, error: `setCutList: ${(e as Error).message}` };
      }
      const checked = checkCutList(next);
      if (checked.errors.length) return { ok: false, error: `setCutList: ${checked.errors.map((e) => e.replace(/^document: /, "")).join("; ")}` };
      if (Object.keys(next).length) doc.cutList = next;
      else delete doc.cutList;
      break;
    }
    case "setDrawing": {
      if (cmd.drawing === null) {
        if (doc.drawing === undefined) return { ok: false, error: "setDrawing: the part has no drawing" };
        delete doc.drawing;
      } else {
        doc.drawing = structuredClone(migrateDrawing(cmd.drawing));
        const problem = targetProblem(doc, rawAnnotations(doc));
        if (problem) return { ok: false, error: `setDrawing: ${problem}` };
      }
      break;
    }
    case "setSheet":
    case "addSheet":
    case "renameSheet":
    case "deleteSheet":
    case "moveSheet":
    case "setDrawingOptions":
    case "setView":
    case "moveView":
    case "setTable":
    case "setAnnotation": {
      const r = drawingCommand(doc, cmd);
      if (r) return { ok: false, error: r };
      break;
    }
    case "setProfile": {
      const profiles = isObject(doc.profiles) ? { ...doc.profiles } : {};
      if (cmd.profile === null) {
        if (!(cmd.name in profiles)) return { ok: false, error: `setProfile: no profile "${cmd.name}" in the part` };
        const users = features.filter((f) => isObject(f) && f.op === "member" && f.profile === cmd.name).map((f) => String(f.id));
        if (users.length) return { ok: false, error: `setProfile: ${cmd.name} is used by ${users.join(", ")}` };
        delete profiles[cmd.name];
      } else {
        profiles[cmd.name] = structuredClone(cmd.profile);
      }
      if (Object.keys(profiles).length) doc.profiles = profiles;
      else delete doc.profiles;
      break;
    }
    case "setPhotoScale": {
      const photo = photoOf(doc);
      if (!photo) return { ok: false, error: "setPhotoScale: this part has no photo" };
      const scale = { ...photo.scale };
      for (const k of ["from", "to"] as const) {
        const v = cmd[k];
        if (v === undefined) continue;
        if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
          return { ok: false, error: `setPhotoScale: ${k} must be a pixel position [x, y] (got ${JSON.stringify(v)})` };
        }
        scale[k] = [v[0], v[1]];
      }
      if (cmd.length !== undefined) {
        if (typeof cmd.length !== "number" || !Number.isFinite(cmd.length) || cmd.length <= 0) {
          return { ok: false, error: `setPhotoScale: length must be a number of mm greater than 0 (got ${JSON.stringify(cmd.length)})` };
        }
        scale.length = cmd.length;
      }
      if (Math.hypot(scale.to[0] - scale.from[0], scale.to[1] - scale.from[1]) < 1) {
        return { ok: false, error: "setPhotoScale: the two points must be at least a pixel apart" };
      }
      const moved = String(scale.from) !== String(photo.scale.from) || String(scale.to) !== String(photo.scale.to);
      if (moved) {
        delete scale.parameter; // the line no longer measures that size of the part
        scale.what = "the line picked on the photo";
      }
      if (typeof cmd.what === "string" && cmd.what.trim()) scale.what = cmd.what.trim();
      if (cmd.length !== undefined) scale.source = "typed";
      if (moved || scale.length !== photo.scale.length) scale.confirmed = false;
      if (cmd.confirm) {
        if (!opts.user) return { ok: false, error: "setPhotoScale: only the user can confirm a photo's scale, in the app" };
        if (scale.source === "guess") return { ok: false, error: "setPhotoScale: the length is a guess; type the real length to confirm it" };
        scale.confirmed = true;
      }
      const next: PhotoUnderlay = { ...photo, scale };
      doc.photo = next;
      const values = rescaled(next, mmPerPixel(scale));
      const params = rawParameters(doc);
      const changed = Object.keys(values).filter((name) => params[name] !== values[name]);
      if (changed.length) {
        doc.parameters = { ...params, ...values };
        const problem = resolveSketchesUsing(doc, changed);
        if (problem) return { ok: false, error: `setPhotoScale: ${problem}` };
      }
      break;
    }
    case "setDimension": {
      const i = need(cmd.sketch);
      if (typeof i === "string") return { ok: false, error: i };
      const f = structuredClone(features[i]);
      if (f.op !== "sketch") return { ok: false, error: `setDimension: "${cmd.sketch}" is a ${String(f.op)}, not a sketch` };
      const constraints = Array.isArray(f.constraints) ? (f.constraints as Record<string, unknown>[]) : [];
      const at = findDimension(f, cmd);
      if (typeof at === "string") return { ok: false, error: `setDimension: ${at}` };
      const k = constraints[at];
      if (!(typeof cmd.value === "number" && Number.isFinite(cmd.value)) && !isExpression(cmd.value)) {
        return { ok: false, error: `setDimension: value must be a number or "=expression" (got ${JSON.stringify(cmd.value)})` };
      }
      if (k.driven === true) return { ok: false, error: `setDimension: ${cmd.sketch}.${dimensionNames(constraints)[at]} is driven: the geometry sets it. Make it driving first (setDriven), or change what drives it` };
      k.value = cmd.value;
      features[i] = f;
      // Going round: it reads itself, or a name that reads it.
      const full = `${cmd.sketch}.${dimensionNames(constraints)[at]}`;
      const loop = documentSymbols(doc).problems[full];
      if (loop?.includes("cycle")) return { ok: false, error: `setDimension: ${full}: ${loop}` };
      const r = resolveSketch(f, documentParameters(doc));
      if (!r.ok) return { ok: false, error: `setDimension: ${r.error}` };
      features[i] = r.feature;
      // Other sketches whose dimensions read this one move with it.
      const problem = resolveSketchesUsing(doc, sketchDimensionNames(r.feature), cmd.sketch);
      if (problem) return { ok: false, error: `setDimension: ${problem}` };
      break;
    }
    case "renameDimension":
    case "setDriven": {
      const i = need(cmd.sketch);
      if (typeof i === "string") return { ok: false, error: i };
      const f = structuredClone(features[i]);
      if (f.op !== "sketch") return { ok: false, error: `${cmd.type}: "${cmd.sketch}" is a ${String(f.op)}, not a sketch` };
      const at = findDimension(f, cmd);
      if (typeof at === "string") return { ok: false, error: `${cmd.type}: ${at}` };
      const constraints = f.constraints as Record<string, unknown>[];
      const names = dimensionNames(constraints);
      const k = constraints[at];
      if (cmd.type === "renameDimension") {
        if (typeof cmd.to !== "string" || !DIMENSION_NAME.test(cmd.to)) {
          return { ok: false, error: `renameDimension: "${String(cmd.to)}" is not a dimension name (letters, digits and _, starting with a letter)` };
        }
        if (names.some((n, j) => j !== at && n === cmd.to)) return { ok: false, error: `renameDimension: ${cmd.sketch} already has a dimension "${cmd.to}"` };
        const was = names[at]!;
        k.name = cmd.to;
        features[i] = f;
        // Everything that read it by its old name reads the new one; the other dimensions keep the names they had.
        constraints.forEach((x, j) => {
          if (j !== at && names[j] && x.name === undefined && names[j] !== dimensionNames(constraints)[j]) x.name = names[j];
        });
        const from = `${cmd.sketch}.${was}`;
        const to = `${cmd.sketch}.${cmd.to}`;
        renameInDocument(doc, (n) => (n === from ? to : undefined));
        break;
      }
      if (cmd.driven) {
        k.driven = true;
        // Its value is what the geometry measures: an expression has nothing to drive any more.
        if (isExpression(k.value)) k.value = 0;
      } else delete k.driven;
      const r = resolveSketch(f, documentParameters(doc));
      if (!r.ok) return { ok: false, error: `setDriven: ${r.error}` };
      if (!cmd.driven) {
        // Driving again: it must not over-define the sketch.
        const resolved = resolveExpressions(r.feature, documentParameters(doc), []) as { entities: SketchEntity[]; constraints: Constraint[] };
        const others = resolved.constraints.filter((_, j) => j !== at);
        try {
          if (wouldOverDefine(resolved.entities, others, resolved.constraints[at])) {
            return { ok: false, error: `setDriven: ${cmd.sketch}.${names[at]} would over-define the sketch as a driving dimension; it stays driven` };
          }
        } catch (e) {
          return { ok: false, error: `setDriven: ${(e as Error).message}` };
        }
      }
      features[i] = r.feature;
      const problem = resolveSketchesUsing(doc, sketchDimensionNames(r.feature), cmd.sketch);
      if (problem) return { ok: false, error: `setDriven: ${problem}` };
      break;
    }
    case "addEntity":
    case "updateEntity":
    case "deleteEntity":
    case "addConstraint":
    case "deleteConstraint": {
      const i = need(cmd.sketch);
      if (typeof i === "string") return { ok: false, error: i };
      const r = editSketch(features[i], cmd, documentParameters(doc));
      if (typeof r === "string") return { ok: false, error: `${cmd.type}: ${r}` };
      features[i] = r;
      // Other sketches whose dimensions read one this edit re-measured move with it.
      const problem = resolveSketchesUsing(doc, sketchDimensionNames(r), cmd.sketch);
      if (problem) return { ok: false, error: `${cmd.type}: ${problem}` };
      break;
    }
    default:
      return { ok: false, error: `unknown command ${JSON.stringify((cmd as { type?: unknown }).type)}` };
  }

  // A dimension something reads can't go: its name would fall to another dimension (or to nothing) and what read it would silently change.
  {
    const named = namedDimensions(doc);
    const still = referencedNames(doc);
    const gone = readBefore.find((n) => still.has(n) && !named.has(n));
    if (gone) {
      return { ok: false, error: `${cmd.type}: dimension ${gone} is used by ${readersOf(doc, gone).join(", ")}; change what reads it first` };
    }
  }
  // A reference this command wrote to a default dimension name pins it too.
  pinReferencedNames(doc);
  const was = validateDocument(input);
  let now = validateDocument(doc);
  // A body's material goes with the body: a command that removes a body (deleting the feature that makes it) drops it.
  if (cmd.type !== "setBodyMaterial" && isObject(doc.bodyMaterials)) {
    const had = new Set(was.madeBodies);
    const has = new Set(now.madeBodies);
    const entries = Object.entries(doc.bodyMaterials);
    const kept = entries.filter(([k]) => has.has(k) || !had.has(k));
    if (kept.length < entries.length) {
      if (kept.length) doc.bodyMaterials = Object.fromEntries(kept);
      else delete doc.bodyMaterials;
      now = validateDocument(doc);
    }
  }
  const before = new Set(allErrors(was));
  const introduced = allErrors(now).filter((e) => !before.has(e));
  if (introduced.length > 0) {
    return { ok: false, error: `${cmd.type} rejected: ${introduced.join("; ")}` };
  }
  return { ok: true, doc };
}

/** Renamed bodies, in the weld table and the bodies' materials. */
function renameBodyRefs(doc: RawDocument, renamed: Map<string, string>): void {
  if (Array.isArray(doc.welds)) {
    doc.welds = doc.welds.map((w) => (isObject(w) && Array.isArray(w.between) ? { ...w, between: w.between.map((b) => renamed.get(String(b)) ?? b) } : w));
  }
  if (isObject(doc.bodyMaterials)) doc.bodyMaterials = Object.fromEntries(Object.entries(doc.bodyMaterials).map(([k, v]) => [renamed.get(k) ?? k, v]));
  // The cut list's kept item numbers and text name bodies (plates, copies of members) too; a member feature's id stays.
  if (isObject(doc.cutList)) {
    const cut = { ...doc.cutList };
    const memberIds = new Set(doc.features.filter((f) => f.op === "member").map((f) => String(f.id)));
    const to = (m: string) => (memberIds.has(m) ? m : (renamed.get(m) ?? m));
    if (Array.isArray(cut.items)) cut.items = cut.items.map((e) => (isObject(e) && Array.isArray(e.members) ? { ...e, members: e.members.map((m) => to(String(m))) } : e));
    if (isObject(cut.members)) cut.members = Object.fromEntries(Object.entries(cut.members).map(([k, v]) => [to(k), v]));
    doc.cutList = cut;
  }
}

type DrawingCommand = Extract<Command, { type: "setSheet" | "addSheet" | "renameSheet" | "deleteSheet" | "moveSheet" | "setDrawingOptions" | "setView" | "moveView" | "setTable" | "setAnnotation" }>;

/** The sheet commands, on the drawing migrated to sheets. Writes doc.drawing; returns an error or null. */
function drawingCommand(doc: RawDocument, cmd: DrawingCommand): string | null {
  const t = cmd.type;
  const raw = rawDrawing(doc);
  if (!raw) return `${t}: the part has no drawing; make one first (setDrawing)`;
  const sheets = raw.sheets;
  const write = () => {
    doc.drawing = { ...raw.drawing, sheets };
  };
  const sheetIndex = (id: string | undefined, what = "sheet"): number | string => {
    if (id === undefined) return 0;
    const i = sheets.findIndex((s) => s.id === id);
    return i < 0 ? `${t}: no ${what} "${id}" (sheets: ${sheets.map((s) => s.id).join(", ")})` : i;
  };
  const holding = (id: string, key: "views" | "annotations") => sheets.findIndex((s) => s[key].some((x) => x.id === id));
  const taken = (id: string) => sheets.some((s) => s.views.some((v) => v.id === id) || s.annotations.some((a) => a.id === id) || (Array.isArray(s.tables) && s.tables.some((x) => isObject(x) && x.id === id)));
  switch (cmd.type) {
    case "setSheet": {
      const i = sheetIndex(cmd.sheet);
      if (typeof i === "string") return i;
      if (!isObject(cmd.patch)) return `setSheet: patch must be an object of sheet fields (got ${JSON.stringify(cmd.patch)})`;
      const sheet: Record<string, unknown> = { ...sheets[i] };
      const format: Record<string, unknown> = isObject(sheet.format) ? { ...sheet.format } : {};
      for (const [k, v] of Object.entries(structuredClone(cmd.patch))) {
        // The paper and its title block are the format's; a format given whole replaces it.
        if (k === "format" && isObject(v)) Object.assign(format, v);
        else if ((FORMAT_KEYS as readonly string[]).includes(k)) format[k] = v;
        else if (k === "id" || k === "views" || k === "annotations") return `setSheet: "${k}" can't be patched (use ${k === "id" ? "renameSheet for its name" : k === "views" ? "setView" : "setAnnotation"})`;
        else sheet[k] = v;
      }
      for (const [k, v] of Object.entries(format)) if (v === null) delete format[k];
      for (const [k, v] of Object.entries(sheet)) if (v === null) delete sheet[k];
      sheet.format = format;
      sheets[i] = sheet as RawSheet;
      break;
    }
    case "addSheet": {
      const id = cmd.id ?? nextSheetId({ sheets });
      if (sheets.some((s) => s.id === id)) return `addSheet: a sheet "${id}" already exists`;
      const index = cmd.index ?? sheets.length;
      if (!Number.isInteger(index) || index < 0 || index > sheets.length) return `addSheet: index ${index} is outside 0..${sheets.length}`;
      const like = sheets[Math.max(0, index - 1)] ?? sheets[0];
      const given = isObject(cmd.sheet) ? structuredClone(cmd.sheet) : {};
      for (const k of ["id", "views", "annotations"]) if (k in given) return `addSheet: a new sheet starts empty; give its ${k === "id" ? "id as the command's id" : k} after (setView, setAnnotation)`;
      const format = { ...(isObject(like?.format) ? like.format : { size: "A3" }), ...(isObject(given.format) ? given.format : {}) };
      const sheet: RawSheet = { id, format, projection: like?.projection ?? "third", ...given, views: [], annotations: [] } as RawSheet;
      sheet.format = format;
      sheets.splice(index, 0, sheet);
      break;
    }
    case "renameSheet": {
      const i = sheetIndex(cmd.id);
      if (typeof i === "string") return i;
      if (typeof cmd.name !== "string") return `renameSheet: name must be text (got ${JSON.stringify(cmd.name)})`;
      if (cmd.name.trim()) sheets[i] = { ...sheets[i], name: cmd.name.trim() };
      else {
        const { name: _n, ...rest } = sheets[i];
        sheets[i] = rest as RawSheet;
      }
      break;
    }
    case "deleteSheet": {
      const i = sheetIndex(cmd.id);
      if (typeof i === "string") return i;
      if (sheets.length === 1) return "deleteSheet: a drawing has at least one sheet; delete the drawing instead (setDrawing null)";
      const gone = new Set(sheets[i].views.map((v) => String(v.id)));
      // A view on another sheet made from one of these goes too.
      for (const id of [...gone]) for (const d of dependentViews({ sheets: sheets as never }, id)) gone.add(d);
      sheets.splice(i, 1);
      for (let k = 0; k < sheets.length; k++) {
        sheets[k] = { ...sheets[k], views: sheets[k].views.filter((v) => !gone.has(String(v.id))), annotations: sheets[k].annotations.filter((a) => !gone.has(String(a.view))) };
      }
      break;
    }
    case "moveSheet": {
      const i = sheetIndex(cmd.id);
      if (typeof i === "string") return i;
      if (!Number.isInteger(cmd.index) || cmd.index < 0 || cmd.index >= sheets.length) return `moveSheet: index ${cmd.index} is outside 0..${sheets.length - 1}`;
      const [s] = sheets.splice(i, 1);
      sheets.splice(cmd.index, 0, s);
      break;
    }
    case "setDrawingOptions": {
      if (!isObject(cmd.patch)) return `setDrawingOptions: patch must be an object (got ${JSON.stringify(cmd.patch)})`;
      for (const [k, v] of Object.entries(structuredClone(cmd.patch))) {
        if (k === "sheets") return "setDrawingOptions: sheets change through addSheet, setSheet, deleteSheet and moveSheet";
        if (v === null) delete raw.drawing[k];
        else raw.drawing[k] = v;
      }
      break;
    }
    case "setView": {
      const from = holding(cmd.id, "views");
      if (cmd.view === null) {
        if (from < 0) return `setView: no view "${cmd.id}"`;
        // Its annotations have nowhere to be, nor have the views made from it.
        const gone = new Set([cmd.id, ...dependentViews({ sheets: sheets as never }, cmd.id)]);
        for (let k = 0; k < sheets.length; k++) {
          sheets[k] = { ...sheets[k], views: sheets[k].views.filter((v) => !gone.has(String(v.id))), annotations: sheets[k].annotations.filter((a) => !gone.has(String(a.view))) };
        }
        break;
      }
      if (!isObject(cmd.view)) return `setView: view must be an object (got ${JSON.stringify(cmd.view)})`;
      if (from < 0 && taken(cmd.id)) return `setView: "${cmd.id}" is an annotation's id`;
      const { id: _v, ...view } = migrateView(structuredClone(cmd.view)) as Record<string, unknown>;
      const v: Record<string, unknown> = { id: cmd.id, ...view };
      const kind = viewKind(v);
      if ((kind === "section" || kind === "detail" || kind === "auxiliary") && v.label === undefined) {
        const old = from >= 0 ? sheets[from].views.find((x) => x.id === cmd.id) : undefined;
        v.label = typeof old?.label === "string" ? old.label : nextViewLabel({ sheets });
      }
      const target = cmd.sheet !== undefined ? sheetIndex(cmd.sheet) : from >= 0 ? from : 0;
      if (typeof target === "string") return target;
      if (from >= 0 && from !== target) return `setView: ${cmd.id} is on ${sheets[from].id}; move it with moveView`;
      const list = [...sheets[target].views];
      const i = list.findIndex((x) => x.id === cmd.id);
      if (i < 0) list.push(v);
      else list[i] = v;
      sheets[target] = { ...sheets[target], views: list };
      break;
    }
    case "moveView": {
      const from = holding(cmd.id, "views");
      if (from < 0) return `moveView: no view "${cmd.id}"`;
      const view = { ...sheets[from].views.find((v) => v.id === cmd.id)! };
      if (cmd.at === null) delete view.at;
      else if (cmd.at !== undefined) view.at = cmd.at;
      const to = cmd.sheet !== undefined ? sheetIndex(cmd.sheet) : from;
      if (typeof to === "string") return to;
      if (to === from) {
        sheets[from] = { ...sheets[from], views: sheets[from].views.map((v) => (v.id === cmd.id ? view : v)) };
      } else {
        // To another sheet, with its annotations; its place there is found again unless given.
        if (cmd.at === undefined) delete view.at;
        const mine = sheets[from].annotations.filter((a) => a.view === cmd.id);
        sheets[from] = { ...sheets[from], views: sheets[from].views.filter((v) => v.id !== cmd.id), annotations: sheets[from].annotations.filter((a) => a.view !== cmd.id) };
        sheets[to] = { ...sheets[to], views: [...sheets[to].views, view], annotations: [...sheets[to].annotations, ...mine] };
      }
      break;
    }
    case "setTable": {
      const tablesOf = (i: number) => (Array.isArray(sheets[i].tables) ? (sheets[i].tables as DrawingTable[]) : []);
      const from = sheets.findIndex((_s, i) => tablesOf(i).some((x) => x.id === cmd.id));
      if (cmd.table !== null && from < 0 && taken(cmd.id)) return `setTable: "${cmd.id}" is a view's or an annotation's id`;
      const target = cmd.sheet !== undefined ? sheetIndex(cmd.sheet) : from >= 0 ? from : 0;
      if (typeof target === "string") return target;
      if (cmd.table === null && from < 0) return `setTable: no table "${cmd.id}"`;
      if (cmd.table !== null && !isObject(cmd.table)) return `setTable: table must be an object (got ${JSON.stringify(cmd.table)})`;
      const at = cmd.table === null ? from : target;
      if (from >= 0 && from !== at) sheets[from] = { ...sheets[from], tables: tablesOf(from).filter((x) => x.id !== cmd.id) };
      const r = setTableIn(from === at ? tablesOf(at) : tablesOf(at).filter((x) => x.id !== cmd.id), cmd.id, cmd.table === null ? null : structuredClone(cmd.table), { views: sheets[at].views.map((v) => String(v.id)) });
      if (!r.ok) return `setTable: ${r.error}`;
      const next = { ...sheets[at], tables: r.tables } as RawSheet;
      if (!r.tables.length) delete next.tables;
      sheets[at] = next;
      break;
    }
    case "setAnnotation": {
      const from = holding(cmd.id, "annotations");
      if (cmd.annotation === null) {
        if (from < 0) return `setAnnotation: no annotation "${cmd.id}"`;
        sheets[from] = { ...sheets[from], annotations: sheets[from].annotations.filter((a) => a.id !== cmd.id) };
        break;
      }
      if (!isObject(cmd.annotation)) return `setAnnotation: annotation must be an object (got ${JSON.stringify(cmd.annotation)})`;
      if (from < 0 && taken(cmd.id)) return `setAnnotation: "${cmd.id}" is a view's id`;
      const { id: _a, ...annotation } = structuredClone(cmd.annotation) as Record<string, unknown>;
      const a: Record<string, unknown> = { id: cmd.id, ...annotation };
      const problem = targetProblem(doc, [a]);
      if (problem) return `setAnnotation: ${problem}`;
      // In a view: on the view's sheet. Else where it was, or the sheet asked for, or the first.
      const ofView = typeof a.view === "string" ? holding(a.view, "views") : -1;
      const asked = cmd.sheet !== undefined ? sheetIndex(cmd.sheet) : null;
      if (typeof asked === "string") return asked;
      const target = ofView >= 0 ? ofView : (asked ?? (from >= 0 ? from : 0));
      if (from >= 0 && from !== target) sheets[from] = { ...sheets[from], annotations: sheets[from].annotations.filter((x) => x.id !== cmd.id) };
      const list = [...sheets[target].annotations];
      const i = list.findIndex((x) => x.id === cmd.id);
      if (i < 0) list.push(a);
      else list[i] = a;
      sheets[target] = { ...sheets[target], annotations: list };
      break;
    }
  }
  write();
  return null;
}

/** What the first of these annotations points at that the part doesn't have, if anything. */
function targetProblem(doc: RawDocument, annotations: Record<string, unknown>[]): string | null {
  const targets = drawingTargets(doc);
  for (const a of annotations) {
    const problem = annotationTargetProblem(a as unknown as Annotation, targets);
    if (problem) return `${String(a.id)}: ${problem}`;
  }
  return null;
}

/**
 * Renames a body through every feature: what adds to it, cuts it, selects on
 * it or combines it. A pattern's copies of it (from_2, from_3) follow. The
 * default body has no name in the features that make it, so renaming it
 * names it there.
 */
function renameBody(features: Record<string, unknown>[], from: string, to: string): string | null {
  // A body another tool made from this one without naming it (a mirror, a split, a copy) is named
  // after it: renaming that body means naming it on the tool that makes it.
  const maker = implicitMaker(features, from);
  if (maker) {
    if (maker.list && maker.list.length > 1) return `"${from}" is ${maker.id}'s ${maker.suffix.slice(1)} of "${maker.of}", one of several it makes; list that body alone in ${maker.id} to name it`;
    const i = features.findIndex((f) => f.id === maker.id);
    features[i] = { ...features[i], newBody: to };
    // Then everything that names it follows, as below.
  }
  // A pattern of the feature that starts the body makes copies named from_2, from_3: they follow.
  const seeds = new Set(features.filter((f) => startsBody(f, from)).map((f) => f.id));
  const patterned = features.some((f) => isPattern(f) && seedIds(f).some((id) => seeds.has(id)));
  const derived = new RegExp(`^${from.replace(/[-]/g, "\\-")}_(\\d+)$`);
  const renamed = renamedBodies(features, from, to);
  const rename = (n: unknown) => (typeof n === "string" && renamed.has(n) ? renamed.get(n)! : n);
  if (patterned && derived.test(to)) return `"${to}" would read as a pattern copy of "${from}"`;
  let first = true;
  const selector = (s: unknown): unknown => {
    if (!isObject(s)) return s;
    const out: Record<string, unknown> = { ...s };
    if (typeof out.body === "string") out.body = rename(out.body);
    if (out.onFace) out.onFace = selector(out.onFace);
    if (Array.isArray(out.between)) out.between = out.between.map(selector);
    return out;
  };
  for (let i = 0; i < features.length; i++) {
    const f = { ...features[i] };
    if (f.op === "extrude") {
      if (f.body === undefined && f.newBody === undefined) {
        if (from === DEFAULT_BODY) {
          if (first) f.newBody = to;
          else f.body = to;
          first = false;
        }
      } else {
        if (f.body !== undefined) f.body = rename(f.body);
        if (f.newBody !== undefined) f.newBody = rename(f.newBody);
      }
    }
    if ((f.op === "member" || f.op === "endCap" || f.op === "gusset") && (f.newBody ?? f.id) === from) f.newBody = to;
    if (Array.isArray(f.bodies)) f.bodies = f.bodies.map(rename);
    if (f.op === "deleteBody" && Array.isArray(f.keep)) f.keep = f.keep.map(rename);
    if (f.op === "split") f.body = rename(f.body);
    if ((f.op === "mirror" || f.op === "split" || f.op === "move") && f.newBody !== undefined) f.newBody = rename(f.newBody);
    if (f.op === "combine") {
      f.target = rename(f.target);
      if (Array.isArray(f.tools)) f.tools = f.tools.map(rename);
    }
    if (f.face) f.face = selector(f.face);
    if (f.edges) f.edges = Array.isArray(f.edges) ? f.edges.map(selector) : selector(f.edges);
    if (Array.isArray(f.faces)) f.faces = f.faces.map(selector);
    // A fillet's other radius sets have edges and faces of their own.
    if (f.op === "fillet" && Array.isArray(f.sets)) {
      f.sets = f.sets.map((set) => {
        if (!isObject(set)) return set;
        const out: Record<string, unknown> = { ...set };
        if (out.edges) out.edges = Array.isArray(out.edges) ? out.edges.map(selector) : selector(out.edges);
        if (Array.isArray(out.faces)) out.faces = out.faces.map(selector);
        return out;
      });
    }
    // Selectors inside references (a sketch on a face, an axis from an edge), on this feature's own copy.
    const d = defOf(f.op);
    if (featureDatumRefs(f, d?.datumRefs).length) {
      const own = structuredClone(f);
      for (const r of featureDatumRefs(own, d?.datumRefs)) mapDatumSelector(r.ref, selector);
      Object.assign(f, own);
    }
    // A registry op: "body" and "newBody" (DESIGN §2.5), the body its id names, and any other body fields it has.
    if (d) {
      if (typeof f.body === "string") f.body = rename(f.body);
      if (typeof f.newBody === "string") f.newBody = rename(f.newBody);
      else if (d.bodyFromId?.(f) && f.id === from) f.newBody = to;
      if (d.renameBodies) Object.assign(f, d.renameBodies(f, rename, features[i]));
    }
    features[i] = f;
  }
  return null;
}

/** A linear or circular pattern (built in; a sketch-driven pattern is a registry op with hooks of its own). */
function isPattern(f: Record<string, unknown>): boolean {
  return f.op === "linearPattern" || f.op === "circularPattern";
}

/** How many instances a pattern has, the original included. */
function patternTotal(f: Record<string, unknown>): number {
  return Number(f.count) * (f.op === "linearPattern" && f.count2 !== undefined ? Number(f.count2) : 1);
}

/** The feature starts this body, and patterns or mirrors of it name their copies after it (from_2, from_mirror). */
function startsBody(f: Record<string, unknown>, name: string): boolean {
  if (f.op === "extrude") return f.newBody === name;
  if (f.op === "member") return (f.newBody ?? f.id) === name;
  return defOf(f.op)?.bodies?.seedBody?.(f) === name;
}

/**
 * Every body name a rename changes: the body, the copies a pattern names after
 * it (from_2), and the bodies a mirror, split or copy derives from it without
 * naming them (from_mirror, from_split, from_copy), and theirs in turn.
 */
export function renamedBodies(features: Record<string, unknown>[], from: string, to: string): Map<string, string> {
  const out = new Map([[from, to]]);
  const seeds = new Set(features.filter((f) => startsBody(f, from)).map((f) => f.id));
  for (const f of features) {
    if (!isPattern(f) || !seedIds(f).some((id) => seeds.has(id))) continue;
    // Copies are named by instance number (a skipped one is simply not made).
    for (let k = 2; k <= patternTotal(f); k++) out.set(`${from}_${k}`, `${to}_${k}`);
  }
  for (const f of features) {
    if (f.newBody !== undefined) continue;
    const lists = (x: unknown) => Array.isArray(x) && x.includes(from);
    if (f.op === "mirror" && f.merge !== true && (lists(f.bodies) || seedIds(f).some((id) => seeds.has(id)))) out.set(`${from}${DERIVED_SUFFIX.mirror}`, `${to}${DERIVED_SUFFIX.mirror}`);
    if (f.op === "split" && f.body === from) out.set(`${from}${DERIVED_SUFFIX.split}`, `${to}${DERIVED_SUFFIX.split}`);
    if (f.op === "move" && f.copy === true && lists(f.bodies)) out.set(`${from}${DERIVED_SUFFIX.move}`, `${to}${DERIVED_SUFFIX.move}`);
  }
  // A body named after one of these (from_mirror_split) follows it in turn. Each step makes a longer name, so this ends.
  for (const [a, b] of [...out].slice(1)) {
    for (const [c, d] of renamedBodies(features, a, b)) if (!out.has(c)) out.set(c, d);
  }
  return out;
}

/** The tool that makes this body by deriving its name from another's, if any. */
function implicitMaker(features: Record<string, unknown>[], name: string): { id: string; suffix: string; of: string; list?: unknown[] } | null {
  for (const f of features) {
    if (f.newBody !== undefined) continue;
    const suffix = f.op === "mirror" && f.merge !== true ? DERIVED_SUFFIX.mirror : f.op === "split" ? DERIVED_SUFFIX.split : f.op === "move" && f.copy === true ? DERIVED_SUFFIX.move : null;
    if (!suffix || !name.endsWith(suffix)) continue;
    const of = name.slice(0, -suffix.length);
    if (f.op === "split" && f.body === of) return { id: String(f.id), suffix, of };
    if (Array.isArray(f.bodies) && f.bodies.includes(of)) return { id: String(f.id), suffix, of, list: f.bodies };
    if (f.op === "mirror") {
      for (const id of seedIds(f)) {
        const seed = features.find((g) => g.id === id);
        if (seed && startsBody(seed, of)) return { id: String(f.id), suffix, of };
      }
    }
  }
  return null;
}

/**
 * Re-solves the sketches that use any of these names (parameters or
 * dimensions), or a name worked out from one of them, other than `skip` (the
 * sketch just solved). A re-solved sketch's driven dimensions may change, so
 * what reads those follows, a few rounds deep. The error text, or null.
 */
function resolveSketchesUsing(doc: RawDocument, names: string[], skip?: string): string | null {
  let changed = new Set(names);
  for (let round = 0; round < 4 && changed.size; round++) {
    const affected = dependentNames(symbolEntries(doc), changed);
    const next = new Set<string>();
    for (let i = 0; i < doc.features.length; i++) {
      const f = doc.features[i];
      if (!isObject(f) || f.op !== "sketch" || (round === 0 && f.id === skip)) continue;
      const refs = parameterRefs(f);
      if (![...affected].some((n) => refs.has(n))) continue;
      const r = resolveSketch(f, documentParameters(doc));
      if (!r.ok) return r.error;
      if (JSON.stringify(r.feature) === JSON.stringify(f)) continue;
      doc.features[i] = r.feature;
      for (const n of sketchDimensionNames(r.feature)) next.add(n);
    }
    changed = next;
  }
  return null;
}

/** A sketch's dimensions by their full names ("sketch_1.d1"). */
function sketchDimensionNames(f: unknown): string[] {
  if (!isObject(f) || typeof f.id !== "string") return [];
  return dimensionNames(f.constraints).flatMap((n) => (n ? [`${String(f.id)}.${n}`] : []));
}

/** The constraint index of the dimension a command names (by `index` or `name`), or what is wrong. */
function findDimension(f: Record<string, unknown>, cmd: { sketch: string; index?: number; name?: string }): number | string {
  const constraints = Array.isArray(f.constraints) ? f.constraints : [];
  const names = dimensionNames(constraints);
  if (cmd.name !== undefined) {
    // "sketch_1.d2" names the same dimension as "d2" in sketch_1.
    const short = cmd.name.startsWith(`${cmd.sketch}.`) ? cmd.name.slice(cmd.sketch.length + 1) : cmd.name;
    const at = names.indexOf(short);
    if (at < 0) return `${cmd.sketch} has no dimension "${cmd.name}" (it has ${names.filter(Boolean).join(", ") || "none"})`;
    return at;
  }
  const at = cmd.index;
  if (typeof at !== "number" || !Number.isInteger(at) || !isDimension(constraints[at])) {
    return `${cmd.sketch} has no dimension at index ${String(at)} (it has ${constraints.length} constraints)`;
  }
  return at;
}

/** The parameter is no longer an estimate from the photo, nor the photo's scale. */
function forgetEstimate(doc: RawDocument, name: string): void {
  const photo = photoOf(doc);
  if (!photo || (!(name in photo.estimated) && photo.scale.parameter !== name)) return;
  const estimated = { ...photo.estimated };
  delete estimated[name];
  const scale = { ...photo.scale };
  if (scale.parameter === name) delete scale.parameter;
  doc.photo = { ...photo, estimated, scale };
}

type SketchCommand = Extract<Command, { type: "addEntity" | "updateEntity" | "deleteEntity" | "addConstraint" | "deleteConstraint" }>;

/** One edit inside a sketch, then a re-solve. Returns the new feature or why not. */
function editSketch(raw: Record<string, unknown>, cmd: SketchCommand, params: Parameters): Record<string, unknown> | string {
  if (raw.op !== "sketch") return `"${cmd.sketch}" is a ${String(raw.op)}, not a sketch`;
  const f = structuredClone(raw);
  const entities = (Array.isArray(f.entities) ? f.entities : []) as Record<string, unknown>[];
  const constraints = (Array.isArray(f.constraints) ? f.constraints : []) as Record<string, unknown>[];
  const findEntity = (id: string) => entities.findIndex((e) => isObject(e) && e.id === id);
  const fixed: string[] = [];
  switch (cmd.type) {
    case "addEntity": {
      if (!isObject(cmd.entity)) return "entity must be an object";
      const e = { ...cmd.entity };
      if (e.id === undefined) e.id = nextEntityId(entities, ENTITY_PREFIX[e.type as keyof typeof ENTITY_PREFIX] ?? "e");
      if (findEntity(String(e.id)) >= 0) return `${cmd.sketch} already has an entity "${String(e.id)}"`;
      entities.push(e);
      break;
    }
    case "updateEntity": {
      const k = findEntity(cmd.id);
      if (k < 0) return `${cmd.sketch} has no entity "${cmd.id}"`;
      if (!isObject(cmd.patch)) return "patch must be an object";
      if ("id" in cmd.patch && cmd.patch.id !== cmd.id) return "an entity's id cannot change";
      const next: Record<string, unknown> = { ...entities[k], ...cmd.patch };
      for (const [key, v] of Object.entries(next)) if (v === null) delete next[key];
      entities[k] = next;
      // What the edit set stays put; the rest of the sketch moves to keep its constraints.
      for (const [key, v] of Object.entries(cmd.patch)) {
        // A spline's points: the solver calls points[i] "p<i>".
        if (key === "points" && next.type === "spline" && Array.isArray(v)) v.forEach((_, i) => fixed.push(`${cmd.id}.p${i}`));
        else if (typeof v === "number" || Array.isArray(v)) fixed.push(`${cmd.id}.${key}`);
      }
      break;
    }
    case "deleteEntity": {
      if (findEntity(cmd.id) < 0) return `${cmd.sketch} has no entity "${cmd.id}"`;
      const left = removeEntities(entities as never, constraints as never, [cmd.id]);
      f.entities = left.entities;
      f.constraints = left.constraints;
      break;
    }
    case "addConstraint": {
      if (!isObject(cmd.constraint)) return "constraint must be an object";
      const resolved = resolveExpressions(f, params, []) as { entities: SketchEntity[]; constraints?: Constraint[] };
      const extra = resolveExpressions(cmd.constraint, params, []) as Constraint;
      try {
        // A driven dimension only measures: it can never over-define.
        if (!isDriven(extra) && wouldOverDefine(resolved.entities, resolved.constraints ?? [], extra)) {
          return `${cmd.sketch}: that constraint repeats or contradicts what the sketch already fixes${"value" in extra ? '; add it as a driven (reference) dimension instead, with "driven": true' : ""}`;
        }
      } catch (e) {
        return `${cmd.sketch}: constraint: ${(e as Error).message}`;
      }
      constraints.push({ ...cmd.constraint });
      break;
    }
    case "deleteConstraint": {
      if (!Number.isInteger(cmd.index) || cmd.index < 0 || cmd.index >= constraints.length) {
        return `${cmd.sketch} has no constraint at index ${cmd.index} (it has ${constraints.length})`;
      }
      constraints.splice(cmd.index, 1);
      break;
    }
  }
  if (cmd.type !== "deleteEntity") {
    f.entities = entities;
    if (constraints.length || f.constraints !== undefined) f.constraints = constraints;
  }
  const r = resolveSketch(f, params, fixed);
  if (!r.ok) return fixed.length ? `${r.error} (with ${fixed.join(", ")} held where you set them)` : r.error;
  return r.feature;
}

/**
 * Brings a sketch's geometry back in line with its constraints after a
 * dimension or parameter changed: solve, with fields that are themselves
 * expressions held fixed, and write the solved numbers back. A sketch whose
 * constraints already hold, or that does not validate, is returned as is.
 */
export function resolveSketch(
  raw: Record<string, unknown>,
  params: Parameters,
  hold: string[] = [],
): { ok: true; feature: Record<string, unknown> } | { ok: false; error: string } {
  const errors: string[] = [];
  const resolved = resolveExpressions(raw, params, errors) as { entities?: SketchEntity[]; constraints?: Constraint[] };
  if (errors.length || !Array.isArray(resolved.entities)) return { ok: true, feature: raw };
  const constraints = resolved.constraints ?? [];
  try {
    if (checkConstraints(resolved.entities, constraints).length === 0) return { ok: true, feature: measureDriven(raw, resolved.entities, constraints) };
  } catch {
    return { ok: true, feature: raw }; // malformed: validation will say why
  }
  const rawEntities = raw.entities as Record<string, unknown>[];
  const fixed: string[] = [...hold];
  for (const e of rawEntities) {
    for (const [field, v] of Object.entries(e)) {
      if (isExpression(v)) fixed.push(`${String(e.id)}.${field}`);
      else if (Array.isArray(v)) {
        v.forEach((c, k) => {
          if (isExpression(c)) fixed.push(`${String(e.id)}.${field}.${k}`);
          // A spline's points: the solver calls points[i] "p<i>".
          else if (field === "points" && Array.isArray(c)) c.forEach((x, j) => isExpression(x) && fixed.push(`${String(e.id)}.p${k}.${j}`));
        });
      }
    }
  }
  const r = solveSketch(resolved.entities, constraints, { fixed });
  if (!r.ok) return { ok: false, error: `${String(raw.id)}: ${r.error}` };
  const out = structuredClone(raw);
  // The solved numbers written back, field by field and into nested arrays (a spline's points), expressions kept.
  const written = (v: unknown, solved: unknown): unknown => {
    if (typeof v === "number" && typeof solved === "number") return clean(solved);
    if (Array.isArray(v) && Array.isArray(solved)) return v.map((c, k) => written(c, solved[k]));
    return v;
  };
  (out.entities as Record<string, unknown>[]).forEach((e, n) => {
    const solved = r.entities[n] as unknown as Record<string, unknown>;
    for (const [field, v] of Object.entries(e)) e[field] = written(v, solved[field]);
  });
  return { ok: true, feature: measureDriven(out, r.entities, constraints) };
}

/**
 * The sketch with each driven dimension's value set to what the geometry
 * measures (they are never solved, only read). The same object when none changed.
 */
export function measureDriven(raw: Record<string, unknown>, entities: SketchEntity[], constraints: Constraint[]): Record<string, unknown> {
  if (!Array.isArray(raw.constraints) || !constraints.some(isDriven)) return raw;
  let out: Record<string, unknown> | null = null;
  constraints.forEach((k, j) => {
    if (!isDriven(k)) return;
    let value: number;
    try {
      value = clean(measureConstraint(entities, k).actual);
    } catch {
      return;
    }
    const was = (raw.constraints as Record<string, unknown>[])[j];
    if (!isObject(was) || was.value === value || !Number.isFinite(value)) return;
    out ??= { ...raw, constraints: [...(raw.constraints as unknown[])] };
    (out.constraints as unknown[])[j] = { ...was, value };
  });
  return out ?? raw;
}

/** Solver output for the document: a value within 1e-8 of a 6-decimal number is that number. */
function clean(x: number): number {
  const r6 = Math.round(x * 1e6) / 1e6;
  return (Math.abs(x - r6) < 1e-8 ? r6 : Math.round(x * 1e9) / 1e9) + 0;
}

/** Ids of features that reference `id` (an extrude's sketch, a pattern's feature). */
export function dependants(features: unknown[], id: string): string[] {
  return features.filter((f) => isObject(f) && references(f).includes(id)).map((f) => String((f as { id: unknown }).id));
}

/**
 * The features `f` uses, by id. `sketchRefs: false` leaves out the sketches it
 * uses only through a { sketch, entity } reference (those follow a rename).
 */
export function references(f: Record<string, unknown>, opts: { sketchRefs?: boolean } = {}): string[] {
  const refs: string[] = [];
  if ((f.op === "extrude" || f.op === "cut") && typeof f.sketch === "string") refs.push(f.sketch);
  // A fillet or chamfer may treat the edges an earlier feature made (its own, or one of its sets).
  if (f.op === "fillet" || f.op === "chamfer") {
    const sets = Array.isArray(f.sets) ? f.sets.filter(isObject) : [];
    for (const ch of [f, ...sets]) if (Array.isArray(ch.features)) for (const id of ch.features) if (typeof id === "string" && !refs.includes(id)) refs.push(id);
  }
  if (isPattern(f) || f.op === "mirror") for (const id of seedIds(f)) if (!refs.includes(id)) refs.push(id);
  // A hole at a sketch's points.
  if (f.op === "hole" && typeof f.points === "string") refs.push(f.points);
  // Joints, gussets and end caps work on members.
  if ((f.op === "joint" || f.op === "gusset") && Array.isArray(f.members)) refs.push(...f.members.filter((m): m is string => typeof m === "string"));
  if (f.op === "joint" && typeof f.through === "string") refs.push(f.through);
  if (f.op === "endCap" && typeof f.member === "string") refs.push(f.member);
  // A registry op says what it uses; any feature may stand on a plane, axis or point feature ({ "datum": id }).
  const d = defOf(f.op);
  const datumRefs = featureDatumRefs(f, d?.datumRefs);
  const viaDatums = opts.sketchRefs === false ? datumFeatureIds(datumRefs.filter((r) => !("sketch" in r.ref))) : datumFeatureIds(datumRefs);
  for (const id of [...(d?.references?.(f) ?? []), ...viaDatums]) if (!refs.includes(id)) refs.push(id);
  return refs;
}

/** Every { sketch: from, entity } reference in the features, rewritten to name sketch `to` (in place). */
function renameSketchRefs(features: unknown[], from: string, to: string): void {
  for (const f of features) {
    if (!isObject(f)) continue;
    for (const r of featureDatumRefs(f, defOf(f.op)?.datumRefs)) if ("sketch" in r.ref && r.ref.sketch === from) r.ref.sketch = to;
  }
}

/**
 * The references to sketch `sketch`'s entities ({ sketch, entity }) in the
 * other features: which feature, and which entity, once each. An edit that
 * takes such an entity out of the sketch is refused; the sketcher says so
 * before it tries.
 */
export function sketchEntityUsers(features: unknown[], sketch: string): { feature: string; entity: string }[] {
  const out: { feature: string; entity: string }[] = [];
  for (const f of features) {
    if (!isObject(f) || f.id === sketch) continue;
    for (const { ref } of featureDatumRefs(f, defOf(f.op)?.datumRefs)) {
      if (!("sketch" in ref) || ref.sketch !== sketch || typeof ref.entity !== "string") continue;
      const use = { feature: String(f.id), entity: ref.entity };
      if (!out.some((u) => u.feature === use.feature && u.entity === use.entity)) out.push(use);
    }
  }
  return out;
}

/** The features that name a node: members that end there, joints and gussets at it. */
export function nodeUsers(features: unknown[], node: string): string[] {
  return features
    .filter((f) => isObject(f) && ((f.op === "member" && (f.from === node || f.to === node)) || ((f.op === "joint" || f.op === "gusset") && f.node === node)))
    .map((f) => String((f as { id: unknown }).id));
}


/** The first free id of the form prefix_1, prefix_2, ... */
export function nextId(doc: unknown, prefix: string): string {
  const used = new Set(
    isObject(doc) && Array.isArray(doc.features) ? doc.features.map((f) => (isObject(f) ? f.id : undefined)) : [],
  );
  for (let n = 1; ; n++) if (!used.has(`${prefix}_${n}`)) return `${prefix}_${n}`;
}

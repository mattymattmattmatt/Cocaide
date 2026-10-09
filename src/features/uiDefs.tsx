// The UI side of feature ops: for each op, its name and icon (Properties
// header, feature tree, right-click menu), its property editor (declared
// fields for FeatureForm, or a component of its own), the chip the tree shows
// beside it, and the sketch it is built from ("Edit sketch").
//
// Each op's UiOp lives in src/features/<op>/ui.tsx and is listed in
// uiIndex.ts. An op's ui.tsx imports only types from this file (this file
// imports the index, so a value import would be a cycle).

import type { ComponentType } from "react";
import type { IconName } from "../ui/icons";
import type { FieldProps, FieldSpec } from "../ui/props/spec";
import { UI_OP_LIST } from "./uiIndex";

type Raw = Record<string, unknown>;

/**
 * What a property editor gets: the feature as the document holds it (`f`)
 * and with expressions evaluated (`resolved`), the features before it, the
 * bodies before it, the document, the last rebuild, the viewport selection,
 * and update (one updateFeature, shallow patch; null removes a key), rename
 * (renameBody) and setError.
 */
export type EditorProps = FieldProps;

export interface UiOp {
  op: string;
  /** Its name in the Properties header, the feature tree and menus ("Revolve"). */
  label: string;
  icon: IconName;
  /** Its property editor, declared: FeatureForm renders these fields. */
  fields?: FieldSpec[];
  /** Or an editor of its own (it may render <FeatureForm> for part of itself). */
  Editor?: ComponentType<EditorProps>;
  /** A short chip beside it in the feature tree ("360°", "2 faces"), or null for none. */
  summary?(f: Raw): string | null;
  /** The sketch it is built from, for the right-click "Edit sketch". */
  sketchOf?(f: Raw): string | null;
}

/** Every registered op's UI, by op. */
export const UI_OPS: Record<string, UiOp> = Object.fromEntries(UI_OP_LIST.map((u) => [u.op, u]));

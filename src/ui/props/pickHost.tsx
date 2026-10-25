// The session's selection fields, between the property panel and the app
// (Phase P wave 2). While a feature is open in a session, the panel provides
// a PickHost: each selection field it shows registers a PickField, one field
// is active (highlighted; the first empty one by default), and the app routes
// the view's clicks, boxes and tree clicks to it through a PickRouter. When
// no session is open there is no host and fields behave as before.

import { createContext, useContext, useEffect, type MutableRefObject } from "react";
import type { RebuildView } from "../../worker/protocol";
import type { PickTarget } from "../model/selection";
import type { ActiveFieldSummary, PickField } from "./picking";
import type { EdgeOptions } from "./pickFields";

export interface PickHost {
  /** The active field's key, or null when none is. */
  active: string | null;
  /** Makes a field active (a click on it, Tab, focus). */
  setActive(key: string | null): void;
  /** A field shown now (it registers on every render, so the newest closure wins). */
  register(field: PickField): void;
  unregister(key: string): void;
  /** The part the clicks are made on: as it stands before the feature. */
  view: RebuildView | null;
  /** Tangent propagation and the corner filter, for edge fields. */
  edge: EdgeOptions;
  setEdge(next: EdgeOptions): void;
  /** Lights these up in the view while a chip is hovered (null: stop). */
  peek(items: PickTarget[] | null): void;
  /** The edges that go with an edge picked (its tangency chain), and whether one passes the corner filter. */
  chainOf(edge: number): number[];
  passes(edge: number): boolean;
}

export const PickContext = createContext<PickHost | null>(null);

/** The open session's pick host, or null outside a session. */
export function usePickHost(): PickHost | null {
  return useContext(PickContext);
}

/** Registers a selection field with the session while it is shown (null: nothing to register). */
export function usePickField(field: PickField | null): void {
  const host = usePickHost();
  if (host && field) host.register(field);
  const key = field?.key;
  useEffect(
    () => () => {
      if (host && key) host.unregister(key);
    },
    [host, key],
  );
}

/** What the app asks of the open session's fields. */
export interface PickRouter {
  /** A click on the part, into the active field: the refusal, or null. "none" when no field is active. */
  pick(target: PickTarget): string | null | "none";
  /** A box over the view: what it took, into the active field. */
  box(targets: PickTarget[]): string | null | "none";
  /** A feature clicked in the tree: did the active field take it (or say why not)? */
  feature(id: string, op: unknown): { taken: true; error: string | null } | { taken: false };
  /** Tab: the next field (Shift: the one before). */
  next(back: boolean): void;
  /** What a click on this would do, for the pointer's tip: "Click to add to Edges". Null: nothing. */
  hint(target: PickTarget): string | null;
}

/** What the app hands the panel for an open session. */
export interface SessionLink {
  /** The routes the app's clicks take (the panel fills it in). */
  router: MutableRefObject<PickRouter | null>;
  /** The panel says which field is active now, after each change. */
  report(summary: ActiveFieldSummary | null): void;
  /** The part picks are made on. */
  view: RebuildView | null;
  peek(items: PickTarget[] | null): void;
  edge: EdgeOptions;
  setEdge(next: EdgeOptions): void;
  /** The field to make active first (a tool's choice). */
  initialActive?: string;
  chainOf(edge: number): number[];
  passes(edge: number): boolean;
}

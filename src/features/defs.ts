// The feature-op registry, document layer. A new op lives in
// src/features/<op>/doc.ts (this file's FeatureDef), kernel.ts (KernelOp,
// kernelDefs.ts) and ui.tsx, and is listed once in each index file
// (docIndex.ts, kernelIndex.ts, uiIndex.ts). The shared code (validation,
// body names, references, renames, scopes, the agent's packets and reference)
// asks the registry through the hooks below; no existing op's code changes.
//
// The document layer imports this file, so it and every <op>/doc.ts may only
// `import type` from src/doc, src/kernel and src/ui: the helpers they need
// come in the ValidateKit. A value import would make an import cycle through
// src/doc/types.ts (tests/registry.test.ts checks this).

import type { RawDocument } from "../doc/commands";
import type { DatumRef, DatumPlane, EdgeSelector, FaceSelector, RefPlane, Vec3 } from "../doc/types";
import type { Checker, FeatureContext } from "../doc/validate";
import type { PartTopology, SelectResult } from "../ask/kernel";
import type { DatumKind, DatumRefAt } from "./datum";
import { DOC_DEFS } from "./docIndex";

/** A selector a feature holds, with its field path ("faces[0]", "axis.edge"). */
export interface FeatureSelector {
  path: string;
  face?: FaceSelector;
  edge?: EdgeSelector;
  /** It may pick several faces or edges (a shell's removed faces); else it must pick one. */
  many?: boolean;
}

/**
 * Validation helpers for an op's `validate`, bound to its Checker: each
 * reports its own errors (with the field path) and returns undefined/null
 * when the value is wrong.
 */
export interface ValidateKit {
  /** Every feature before this one: id -> op. */
  earlier: ReadonlyMap<string, string>;
  /** The part's profiles, nodes, and the members and joints so far. */
  ctx: FeatureContext;
  isObject(v: unknown): v is Record<string, unknown>;
  /** A value for an error message: "nothing", 5, "\"x\"", shortened. */
  describe(v: unknown): string;
  /** true or false, when present. */
  bool(obj: Record<string, unknown>, key: string, path: string): boolean | undefined;
  /** One of the listed strings. */
  oneOf<T extends string>(obj: Record<string, unknown>, key: string, path: string, values: readonly T[]): T | undefined;
  bodyName(v: unknown, path: string): string | undefined;
  /** A non-empty list of different body names. */
  bodyList(v: unknown, path: string): string[] | undefined;
  /** The optional "newBody" field. */
  newBody(raw: Record<string, unknown>): string | undefined;
  faceSelector(v: unknown, path: string): FaceSelector | null;
  /** A list of face selectors; empty only with allowEmpty. */
  faceSelectors(v: unknown, path: string, opts?: { allowEmpty?: boolean }): FaceSelector[] | null;
  edgeSelector(v: unknown, path: string): EdgeSelector | null;
  /** One edge selector or a non-empty list of them (as fillet's "edges"). */
  edgeSelectors(v: unknown, path: string): EdgeSelector | EdgeSelector[] | null;
  /** A DatumRef; `want` refuses what cannot be that kind (a default axis where a plane is needed). */
  datumRef(v: unknown, path: string, want?: DatumKind | readonly DatumKind[]): DatumRef | null;
  /** A plane written out ({ "type": "datum", ... }) or by reference ({ "type": "ref", "ref": ... }). */
  plane(v: unknown, path: string): DatumPlane | RefPlane | undefined;
  /** The id of an earlier feature whose op is one of `ops`; `what` names them for the message ("an extrude, cut or hole"). */
  feature(v: unknown, path: string, ops: readonly string[], what: string): string | undefined;
  /** The id of an earlier sketch. */
  sketch(v: unknown, path: string): string | undefined;
  /** A direction: three numbers, not all zero. */
  direction(obj: Record<string, unknown>, key: string, path: string): Vec3 | undefined;
}

/** How an op uses and makes bodies, for the body-name checks (BodyNames in validate.ts). */
export interface BodyHooks<F> {
  /** Bodies that must exist before it: [field path, name]. */
  needs?(f: F): [string, string][];
  /**
   * The bodies it makes, refused if a name is taken; `path` is where to say so.
   * `names` are the bodies so far; `made` the body each earlier seed feature started.
   */
  makes?(f: F, state: { names: ReadonlySet<string>; made: ReadonlyMap<string, string> }): { names: string[]; path: string } | null;
  /** Anything else wrong with the bodies it names, given the bodies so far: [field path, message]. */
  problems?(f: F, state: { names: ReadonlySet<string>; made: ReadonlyMap<string, string> }): [string, string][];
  /** Bodies it deletes or merges away (no longer bodies after it). */
  consumes?(f: F, names: readonly string[]): string[];
  /**
   * The body it starts, when patterns and mirrors of it make copies named after
   * it (seed_2, seed_mirror); renaming that body renames the copies. (A
   * patternable op that makes one body counts as its seed anyway.) Called with
   * raw features too, so check types.
   */
  seedBody?(f: Record<string, unknown>): string | undefined;
}

/** The registry entry of one op, document side. */
export interface FeatureDef<F extends { id: string; op: string } = any> {
  op: F["op"];
  /**
   * The typed feature, or null with the errors reported on `c`. Expressions
   * are already numbers and `suppressed` is already checked and taken off.
   * Start with c.keys(raw, "", ["id", "op", ...]) so unknown fields are errors.
   */
  validate(raw: Record<string, unknown>, c: Checker, x: ValidateKit): F | null;
  /** Ids of earlier features it uses (a sketch, a seed); the { datum } ids in datumRefs are added for it. */
  references?(raw: Record<string, unknown>): string[];
  /**
   * The DatumRefs it holds, by identity, with their paths (usually
   * datumRefsAt(raw, "axis", ...)): their feature ids count as references,
   * body names in their selectors are checked and follow a body rename, and
   * validate reports their selectors' health. Called on raw features too.
   */
  datumRefs?(raw: Record<string, unknown>): DatumRefAt[];
  bodies?: BodyHooks<F>;
  /** Its face and edge selectors (not those inside datumRefs): body names in them are checked; validate reports their health. */
  selectors?(f: F): FeatureSelector[];
  /**
   * Body names in fields the rename does not know. Already renamed for a
   * registry op: "body", "newBody", "bodies", the body its id names
   * (bodyFromId), the selectors in "face", "faces" and "edges", and those
   * inside its datumRefs.
   */
  renameBodies?(raw: Record<string, unknown>, rename: (name: unknown) => unknown): Record<string, unknown>;
  /** True when the feature touches only bodies `inScope` accepts (a "body:<name>" write scope). */
  onlyBodies?(raw: Record<string, unknown>, inScope: (name: unknown) => boolean, doc: RawDocument): boolean;
  /** A pattern or mirror may repeat it (its kernel op then calls ctx.setSeed). */
  patternable?: boolean;
  /** Numeric fields the agent sees measured in its packets ("thickness", "factor"). */
  measurementKeys?: string[];
  /** The body its id names when it has no "newBody": renaming the feature renames that body. */
  bodyFromId?(raw: Record<string, unknown>): boolean;
  /**
   * From a right-clicked face or edge the ask adds one feature that must use it:
   * null when this one does, else why not. Without it the ask refuses the op there.
   */
  askFrom?(f: Record<string, unknown>, target: { kind: "face" | "edge"; index: number }, k: AskKernel): Promise<string | null>;
  /** Its section of the document reference for agents (markdown, starting "## <op>"). */
  reference: string;
}

/** What askFrom may ask of the kernel, on the part before the edit. */
export interface AskKernel {
  select(selector: unknown): Promise<SelectResult>;
  topology(): Promise<PartTopology | null>;
}

/** Every registry op's def, by op. */
export const DEF: Readonly<Record<string, FeatureDef>> = Object.fromEntries(DOC_DEFS.map((d) => [d.op, d]));

/** The registry def of an op, if it is a registry op. */
export function defOf(op: unknown): FeatureDef | undefined {
  return typeof op === "string" && Object.hasOwn(DEF, op) ? DEF[op] : undefined;
}

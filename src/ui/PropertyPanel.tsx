// Edits one feature through document commands. Every field commits as one
// updateFeature; a rejected command shows why and leaves the document alone.

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { Command, RawDocument } from "../doc/commands";
import { rollbackIndex } from "../doc/rollback";
import type { FeatureStatus } from "../kernel";
import { Icon, ICON_NAMES, type IconName } from "./icons";
import { activeField, holds, nextField, summaryOf, fieldTakes, treeTakes, type PickField } from "./props/picking";
import type { PickTarget } from "./model/selection";
import { PickContext, type PickHost, type SessionLink } from "./props/pickHost";
import { documentParameters, resolveExpressions } from "../doc/parameters";
import { DEFAULT_BODY, type SketchEntity, type Vec3 } from "../doc/types";
import { validateDocument } from "../doc/validate";
import { sketchDof } from "../geom/solver";
import type { RebuildView } from "../worker/protocol";
import { UI_OPS, type EditorProps } from "../features/uiDefs";
import { Field, Select, TextInput } from "./fields";
import { DeleteBodyProps, MirrorProps, MoveProps, SplitProps } from "./BodyToolProps";
import { EndCapProps, GussetProps, JointProps, MemberProps, type FrameActions } from "./FrameProps";
import { nextBodyName } from "./model/names";
import { FeatureForm } from "./props/FeatureForm";
import { CUT_FIELDS, EXTRUDE_FIELDS } from "./props/ExtrudeForm";
import type { FieldSpec } from "./props/spec";
import { sketchFrameIn } from "./model/sketchPlane";
import { referenceName } from "./sketcher/names";
import type { Selection } from "./Viewport";

export const OP_LABEL: Record<string, string> = {
  sketch: "Sketch",
  extrude: "Extrude",
  cut: "Cut",
  hole: "Hole",
  fillet: "Fillet",
  chamfer: "Chamfer",
  linearPattern: "Linear pattern",
  circularPattern: "Circular pattern",
  combine: "Combine",
  member: "Member",
  joint: "Joint",
  endCap: "End cap",
  gusset: "Gusset",
  mirror: "Mirror",
  split: "Split body",
  move: "Move/Copy body",
  deleteBody: "Delete/Keep bodies",
  // Ops with a UI of their own (src/features/<op>/ui.tsx) name themselves.
  ...Object.fromEntries(Object.values(UI_OPS).map((u) => [u.op, u.label])),
};

export { nextBodyName } from "./model/names";

type Raw = Record<string, unknown>;

/** A feature open in a session (Phase P): what the panel needs to show OK and Cancel and make its selection fields live. */
export interface SessionPanelProps {
  kind: "create" | "edit";
  /** "Add fillet_2", "Edit extrude_1": what OK makes one undo step of. */
  label: string;
  /** A new feature not complete yet (not in the document until it is), and what it still needs. */
  pending?: Raw;
  pendingProblem?: string;
  /** Its newest rebuild failed: the view keeps the last preview that built. */
  failing?: string;
  ok(): void;
  cancel(): void;
  /** Keep the panel open: OK runs the same tool again (several holes in a row). */
  keepOpen: boolean;
  setKeepOpen(on: boolean): void;
  /** A tool made it, so it can be repeated. */
  repeatable: boolean;
  /** The pick fields' link to the app. */
  link: SessionLink;
  /** A change to a pending feature (merged in; it goes into the document once complete). */
  onDraft(patch: Raw): string | null;
  /** Its id changed (renamed inline): the session follows it. */
  onRenamed(from: string, to: string): void;
}

interface Props {
  doc: RawDocument;
  featureId: string;
  view: RebuildView | null;
  /** The feature's own status (the session shows the part before the feature, which has none for it). */
  status?: FeatureStatus;
  /** The open session on this feature, if any. */
  session?: SessionPanelProps;
  selection: Selection;
  dispatch(cmd: Command): string | null;
  onEditSketch(id: string): void;
  onSelectFeature(id: string | null): void;
  onAsk?(target: { kind: "failed"; id: string }, x: number, y: number): void;
  /** Opens the weldment profile card for a sketch. */
  onProfileCard?(sketchId: string): void;
  /** Adding features and multi-feature changes, for a frame's features. */
  frame?: FrameActions;
}

export function PropertyPanel(props: Props) {
  return props.session ? (
    <SessionFields link={props.session.link}>
      <FeaturePanel {...props} />
    </SessionFields>
  ) : (
    <FeaturePanel {...props} />
  );
}

/**
 * The session's selection fields: each one shown registers here; one is
 * active (the first empty one the feature needs, unless one was clicked, or a
 * tool chose); the app's clicks reach it through the link's router.
 */
function SessionFields({ link, children }: { link: SessionLink; children: ReactNode }) {
  const registry = useRef(new Map<string, PickField>());
  /** The field asked for (undefined: the default rule). */
  const [wanted, setWanted] = useState<string | null | undefined>(link.initialActive);
  const [active, setActive] = useState<string | null>(null);
  const [error, setPickError] = useState<{ text: string; at: number } | null>(null);
  const reported = useRef("");
  const fields = () => [...registry.current.values()];
  // After each render (the fields have registered): which is active, and tell the app.
  useLayoutEffect(() => {
    const f = activeField(fields(), wanted);
    const key = f?.key ?? null;
    if (key !== active) setActive(key);
    const summary = f ? summaryOf(f) : null;
    const sig = summary ? JSON.stringify([summary.key, summary.count, summary.prompt, summary.takes, summary.items.map((i) => (i.kind === "datum" ? i.id : i.kind === "vertex" ? `${i.edge}${i.at}` : `${i.kind}${i.index}`))]) : "";
    if (sig !== reported.current) {
      reported.current = sig;
      link.report(summary);
    }
  });
  useEffect(() => () => link.report(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const current = () => (active ? registry.current.get(active) ?? null : null);
  /**
   * The field a click on this goes to: the active one; or, when none is active or the active one takes nothing from
   * the view (features ticked in the tree), the first field that takes it.
   */
  const taking = (t: PickTarget): PickField | null => {
    const f = current();
    if (f?.takes.length) return f;
    return (
      fields()
        .filter((x) => !x.onRequest && fieldTakes(x, t))
        .sort((a, b) => a.order - b.order)[0] ?? f
    );
  };
  /** A single choice filled: on to the next field that still needs something. */
  const advance = (f: PickField) => {
    if (["face", "datumRef", "feature", "sketch"].includes(f.kind)) setWanted(undefined);
  };
  link.router.current = {
    pick(t) {
      const f = taking(t);
      if (!f) return "none";
      // Taken by another field than the active one: that one is active now.
      if (f.key !== active) setWanted(f.key);
      if (!fieldTakes(f, t)) return `${f.label} doesn't take that: ${f.prompt.toLowerCase()}`;
      const err = f.toggle(t);
      setPickError(err ? { text: err, at: Date.now() } : null);
      if (!err) advance(f);
      return err;
    },
    box(ts) {
      const f = current();
      if (!f) return "none";
      const err = f.addAll ? f.addAll(ts.filter((t) => fieldTakes(f, t))) : `${f.label} takes one at a time: click it`;
      setPickError(err ? { text: err, at: Date.now() } : null);
      return err;
    },
    feature(id, op) {
      const f = current();
      // The active field, or one the feature still needs (a pattern's features, command-first); else the tree click is the tree's (it asks to finish first).
      const taker = f?.takeFeature && treeTakes(f.treeOps, op) ? f : fields().find((x) => x.takeFeature && x.required && x.count === 0 && treeTakes(x.treeOps, op));
      if (!taker?.takeFeature) return { taken: false };
      const err = taker.takeFeature(id);
      setPickError(err ? { text: err, at: Date.now() } : null);
      if (!err) advance(taker);
      return { taken: true, error: err };
    },
    next(back) {
      const n = nextField(fields(), active, back);
      if (n) setWanted(n.key);
    },
    hint(t) {
      const f = taking(t);
      if (!f || !fieldTakes(f, t)) return null;
      return holds(f.items, t) ? `Click to take it out of ${f.label}` : `Click to add it to ${f.label}`;
    },
    reach(t) {
      const f = taking(t);
      return f?.reach && fieldTakes(f, t) ? f.reach(t) : null;
    },
  };
  const host: PickHost = {
    active,
    setActive: (key) => setWanted(key),
    register: (f) => void registry.current.set(f.key, f),
    unregister: (key) => void registry.current.delete(key),
    view: link.view,
    edge: link.edge,
    setEdge: link.setEdge,
    peek: link.peek,
    chainOf: link.chainOf,
    passes: link.passes,
  };
  return (
    <PickContext.Provider value={host}>
      {children}
      {error && (
        <div className="command-error pick-error" role="alert" data-testid="pick-error" key={error.at}>
          {error.text}
        </div>
      )}
    </PickContext.Provider>
  );
}

function FeaturePanel({ doc, featureId, view, status: statusIn, session, selection, dispatch, onEditSketch, onSelectFeature, onAsk, onProfileCard, frame }: Props) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [featureId]);
  const index = doc.features.findIndex((f) => f.id === featureId);
  // A new feature not complete yet is not in the document: it is the session's own, and goes at the end (at the rollback bar).
  const pending = index < 0 && session?.pending?.id === featureId ? session.pending : undefined;
  const f = (pending ?? doc.features[index]) as Raw | undefined;
  /** For the second Enter in a field (OK): fields typed into since their last Enter. */
  const typed = useRef(new WeakSet<EventTarget>());
  const enter = useRef<{ wasTyped: boolean } | null>(null);
  if (!f) return <p className="muted">Select a feature in the tree.</p>;
  const at = pending ? rollbackIndex(doc) : index;

  const run = (cmd: Command) => {
    const problem = dispatch(cmd);
    setError(problem);
    return problem;
  };
  const update = (patch: Raw) => {
    if (pending && session) {
      const problem = session.onDraft(patch);
      setError(problem);
      return problem;
    }
    return run({ type: "updateFeature", id: featureId, patch });
  };
  const status = statusIn ?? view?.features.find((s) => s.id === featureId);
  // Fields show what the document holds ("=plate_t"); anything computed uses the numbers.
  const params = documentParameters(doc);
  const resolved = resolveExpressions(f, params, []) as Raw;
  const before = resolveExpressions(doc.features.slice(0, at), params, []) as Raw[];
  const op = String(f.op);
  /** The bodies made before this feature: what it can add to, cut or combine. */
  const bodiesBefore = validateDocument({ ...doc, features: doc.features.slice(0, at) }).bodies;
  const rename = (from: string, to: string) => run({ type: "renameBody", from, to });
  /** Frame actions whose rejection shows here, like any other edit's. */
  const batched = (a: FrameActions): FrameActions => ({ onCreate: a.onCreate, onBatch: (cmds) => {
    const problem = a.onBatch(cmds);
    setError(problem);
    return problem;
  } });
  /** An op with a UI of its own (src/features/<op>/ui.tsx): its editor, or its fields in a FeatureForm. */
  const ui = UI_OPS[op];
  const editorProps: EditorProps = { f, resolved, before, bodies: bodiesBefore, doc, view, selection, update, rename, setError };

  const renameFeature = (id: string) => {
    if (pending && session) {
      if (!session.onDraft({ id })) session.onRenamed(featureId, id);
      return;
    }
    if (!run({ type: "updateFeature", id: featureId, patch: { id } })) {
      session?.onRenamed(featureId, id);
      onSelectFeature(id);
    }
  };
  // In a session: Enter in a field commits that field; a second Enter (nothing typed since) or Ctrl+Enter is OK.
  const keys = session
    ? {
        onInputCapture: (e: FormEvent) => typed.current.add(e.target),
        onKeyDownCapture: (e: KeyboardEvent) => {
          if (e.key !== "Enter") return;
          enter.current = { wasTyped: typed.current.has(e.target) };
          typed.current.delete(e.target);
        },
        onKeyDown: (e: KeyboardEvent) => {
          if (e.key !== "Enter") return;
          const t = e.target as HTMLElement;
          const wasTyped = enter.current?.wasTyped ?? false;
          enter.current = null;
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            return session.ok();
          }
          if (t.tagName !== "INPUT" || wasTyped || t.getAttribute("aria-invalid") === "true") return;
          e.preventDefault();
          session.ok();
        },
      }
    : {};
  const icon: IconName = UI_OPS[op]?.icon ?? ((ICON_NAMES as string[]).includes(op) ? (op as IconName) : "sketch");

  return (
    <div className={`properties${session ? " in-session" : ""}`} data-testid="properties" {...keys}>
      {session && (
        <div className="session-bar" data-testid="session-bar">
          <span className="session-title" data-testid="session-title">
            {session.label}
          </span>
          <span className="session-actions">
            {session.repeatable && (
              <button
                type="button"
                className={`session-pin${session.keepOpen ? " on" : ""}`}
                aria-pressed={session.keepOpen}
                aria-label="Repeat after OK"
                title={session.keepOpen ? "Keeping the panel open: OK starts another one (click to stop)" : "Keep the panel open: OK starts another one, for several in a row"}
                onClick={() => session.setKeepOpen(!session.keepOpen)}
                data-testid="session-pin"
              >
                <Icon name="pin" size={15} />
              </button>
            )}
            <button type="button" className="session-cancel" title="Cancel: leave the part as it was (Esc)" onClick={session.cancel} data-testid="session-cancel">
              <Icon name="x" size={15} />
              Cancel
            </button>
            <button
              type="button"
              className="session-ok"
              title={`OK: keep it, one undo step "${session.label}" (Enter in the view, a second Enter in a field, or Ctrl+Enter)`}
              onClick={session.ok}
              data-testid="session-ok"
            >
              <Icon name="check" size={15} />
              OK
            </button>
          </span>
        </div>
      )}
      <div className="prop-header">
        <span className="prop-icon" aria-hidden="true">
          <Icon name={icon} size={18} />
        </span>
        <h3>{OP_LABEL[op] ?? op}</h3>
        <TextInput value={featureId} testId="prop-id" onCommit={renameFeature} />
      </div>
      {session?.pending && (
        <div className="session-pending" data-testid="session-pending" role="status">
          {session.pendingProblem ? `Still needed: ${session.pendingProblem}` : "Pick what it needs in the view."}
        </div>
      )}
      {session?.failing && !status?.error && (
        <div className="feature-error standalone" data-testid="prop-feature-error">
          {session.failing.replaceAll(`${featureId}: `, "")}
        </div>
      )}
      {status?.error && (
        <div
          className="feature-error standalone"
          data-testid="prop-feature-error"
          title="Right-click to fix it or ask the AI about it"
          onContextMenu={(e) => {
            if (!onAsk) return;
            e.preventDefault();
            onAsk({ kind: "failed", id: featureId }, e.clientX, e.clientY);
          }}
        >
          {status.error.replaceAll(`${featureId}: `, "")}
        </div>
      )}
      {session && status?.error && <div className="session-note muted small">The view keeps the last preview that built: change the value, or OK keeps it with the error.</div>}
      <div className="prop-body">
        {ui ? (
          ui.Editor ? <ui.Editor {...editorProps} /> : <FeatureForm fields={ui.fields ?? []} {...editorProps} />
        ) : (
          <>
        {op === "sketch" && <SketchProps form={editorProps} onEdit={() => onEditSketch(featureId)} onProfileCard={onProfileCard && (() => onProfileCard(featureId))} />}
        {op === "member" && <MemberProps f={f} resolved={resolved} doc={doc} view={view} update={update} rename={rename} actions={frame && batched(frame)} />}
        {op === "joint" && <JointProps f={f} doc={doc} view={view} update={update} actions={frame && batched(frame)} />}
        {op === "endCap" && <EndCapProps f={f} doc={doc} update={update} />}
        {op === "gusset" && <GussetProps f={f} doc={doc} update={update} />}
        {(op === "endCap" || op === "gusset") && <BodyNameField f={f} rename={rename} />}
        {(op === "extrude" || op === "cut") && <FeatureForm fields={op === "extrude" ? EXTRUDE_FIELDS : CUT_FIELDS} {...editorProps} />}
        {op === "extrude" && <BodyProps f={f} bodies={bodiesBefore} update={update} rename={rename} />}
        {op === "cut" && bodiesBefore.length > 1 && <BodiesScope f={f} bodies={bodiesBefore} update={update} />}
        {op === "combine" && <CombineProps f={f} bodies={bodiesBefore} update={update} />}
        {op === "mirror" && (
          <MirrorProps
            f={f}
            bodies={bodiesBefore}
            update={update}
            rename={rename}
            seeds={before
              .filter((g) => ["extrude", "cut", "hole", "member"].includes(String(g.op)))
              .map((g) => ({ id: String(g.id), body: g.op === "member" ? String(g.newBody ?? g.id) : typeof g.newBody === "string" ? g.newBody : undefined }))}
            form={editorProps}
          />
        )}
        {op === "split" && <SplitProps f={f} bodies={bodiesBefore} update={update} rename={rename} form={editorProps} />}
        {op === "move" && <MoveProps f={f} bodies={bodiesBefore} update={update} rename={rename} />}
        {op === "deleteBody" && <DeleteBodyProps f={f} bodies={bodiesBefore} update={update} rename={rename} />}
          </>
        )}
      </div>
      {!pending && (
        <div className="prop-actions">
          <label className="check">
            <input
              type="checkbox"
              checked={f.suppressed === true}
              data-testid="prop-suppressed"
              onChange={(e) => run({ type: "suppressFeature", id: featureId, suppressed: e.target.checked })}
            />
            Suppressed
          </label>
          {!session && (
            <button
              className="danger"
              onClick={() => {
                if (!run({ type: "deleteFeature", id: featureId })) onSelectFeature(null);
              }}
            >
              Delete
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="command-error" role="alert" data-testid="command-error">
          {error}
        </div>
      )}
    </div>
  );
}

/** The body a plate (end cap, gusset) makes: named by its id, or renamed. */
function BodyNameField({ f, rename }: { f: Raw; rename(from: string, to: string): unknown }) {
  const body = typeof f.newBody === "string" ? f.newBody : String(f.id);
  return (
    <Field label="Body">
      <TextInput value={body} onCommit={(name) => name !== body && rename(body, name)} testId="prop-body-name" />
    </Field>
  );
}

/** Where an extrude's material goes: an existing body, or a new one with a name. */
function BodyProps({ f, bodies, update, rename }: { f: Raw; bodies: string[]; update(p: Raw): unknown; rename(from: string, to: string): unknown }) {
  const newBody = typeof f.newBody === "string" ? f.newBody : null;
  const value = newBody ? "__new" : typeof f.body === "string" ? f.body : DEFAULT_BODY;
  const names = bodies.includes(DEFAULT_BODY) ? bodies : [DEFAULT_BODY, ...bodies];
  const options: [string, string][] = [...names.map((n): [string, string] => [n, n === DEFAULT_BODY && !bodies.includes(n) ? `${n} (new)` : `add to ${n}`]), ["__new", "New body"]];
  return (
    <>
      <Field label="Body">
        <Select
          value={value}
          options={options}
          testId="prop-body"
          onChange={(v) => update(v === "__new" ? { body: null, newBody: nextBodyName(bodies) } : { newBody: null, body: v === DEFAULT_BODY ? null : v })}
        />
      </Field>
      {newBody && (
        <Field label="Name">
          <TextInput value={newBody} onCommit={(to) => to !== newBody && rename(newBody, to)} testId="prop-body-name" />
        </Field>
      )}
    </>
  );
}

/** Which bodies a cut removes material from (a hole's editor has its own). None ticked: every body it reaches. */
function BodiesScope({ f, bodies, update }: { f: Raw; bodies: string[]; update(p: Raw): unknown }) {
  const listed = Array.isArray(f.bodies) ? (f.bodies as string[]) : [];
  const toggle = (name: string, on: boolean) => {
    const next = on ? [...listed, name] : listed.filter((n) => n !== name);
    update({ bodies: next.length ? bodies.filter((b) => next.includes(b)) : null });
  };
  return (
    <Field label="Bodies">
      <span className="body-checks" data-testid="prop-bodies">
        {bodies.map((b) => (
          <label key={b} className="check">
            <input type="checkbox" checked={listed.includes(b)} onChange={(e) => toggle(b, e.target.checked)} data-testid={`prop-bodies-${b}`} />
            {b}
          </label>
        ))}
        <span className="muted small">{listed.length ? "only these, and each must lose material" : "none ticked: every body it reaches"}</span>
      </span>
    </Field>
  );
}

function CombineProps({ f, bodies, update }: { f: Raw; bodies: string[]; update(p: Raw): unknown }) {
  const target = String(f.target);
  const tools = Array.isArray(f.tools) ? (f.tools as string[]) : [];
  return (
    <>
      <Field label="Operation">
        <Select
          value={f.operation as "add" | "subtract" | "common"}
          testId="prop-operation"
          options={[
            ["add", "Add (join)"],
            ["subtract", "Subtract"],
            ["common", "Common (intersect)"],
          ]}
          onChange={(v) => update({ operation: v })}
        />
      </Field>
      <Field label="Into">
        <Select value={target} options={bodies.map((b): [string, string] => [b, b])} testId="prop-target" onChange={(v) => update({ target: v, tools: tools.filter((t) => t !== v).length ? tools.filter((t) => t !== v) : bodies.filter((b) => b !== v).slice(0, 1) })} />
      </Field>
      <Field label="Bodies">
        <span className="body-checks">
          {bodies
            .filter((b) => b !== target)
            .map((b) => (
              <label key={b} className="check">
                <input
                  type="checkbox"
                  checked={tools.includes(b)}
                  data-testid={`prop-tools-${b}`}
                  onChange={(e) => {
                    const next = e.target.checked ? [...tools, b] : tools.filter((t) => t !== b);
                    if (next.length) update({ tools: bodies.filter((x) => next.includes(x)) });
                  }}
                />
                {b}
              </label>
            ))}
          <span className="muted small">used up: they become part of {target}</span>
        </span>
      </Field>
    </>
  );
}

/** The fields of a sketch's plane: a default plane, a plane feature, a flat face (by reference), with offset and flip; or written out. */
const SKETCH_PLANE: FieldSpec[] = [{ kind: "plane", key: "plane", label: "Plane", refs: true, testId: "prop-sketch-plane", hint: "Where the sketch is: it moves with what it stands on" }];

function SketchProps({ form, onEdit, onProfileCard }: { form: EditorProps; onEdit(): void; onProfileCard?(): void }) {
  const f = form.resolved;
  const frame = sketchFrameIn(f, form.view);
  const entities = (f.entities as unknown[]) ?? [];
  const constraints = (f.constraints as unknown[]) ?? [];
  let dof: number | null = null;
  try {
    dof = sketchDof(entities as never, constraints as never);
  } catch {
    dof = null;
  }
  return (
    <>
      <FeatureForm fields={SKETCH_PLANE} {...form} />
      <Field label="Now">
        <span className="readout" data-testid="prop-sketch-where">
          {typeof frame === "string" ? frame : `${planeName(frame.z, frame.origin)}`}
        </span>
      </Field>
      <Field label="Geometry">
        <span className="readout">
          {entities.length} entities · {constraints.length} constraints
          {entities.length === 0 ? " · Empty sketch" : dof !== null && ` · ${dof === 0 ? "fully defined" : `${dof} DOF free`}`}
        </span>
      </Field>
      {entities.some((e) => (e as { ref?: unknown }).ref) && (
        <Field label="References">
          <span className="readout" data-testid="prop-sketch-references" title="Reference geometry follows the model: projected again on every rebuild">
            {(entities as SketchEntity[])
              .filter((e) => e.ref)
              .map((e) => `${e.id}: ${referenceName(e)}`)
              .join(" · ")}
          </span>
        </Field>
      )}
      {isProfile(f.profile) && (
        <Field label="Weldment">
          <span className="readout" data-testid="prop-profile">
            {f.profile.name}
            {f.profile.library ? ` · library v${f.profile.library.version}` : " · not in the library"}
          </span>
        </Field>
      )}
      <button className="primary wide" onClick={onEdit} data-testid="edit-sketch">
        Edit sketch
      </button>
      {onProfileCard && (
        <button className="wide" onClick={onProfileCard} data-testid="prop-profile-card" title="Name it, give it sizes and tags, and keep it in the section library">
          {isProfile(f.profile) ? "Profile card…" : "Save as a weldment profile…"}
        </button>
      )}
    </>
  );
}

function isProfile(p: unknown): p is { name: string; library?: { id: string; version: number } } {
  return typeof p === "object" && p !== null && typeof (p as { name?: unknown }).name === "string";
}


export function planeName(normal: Vec3, origin: Vec3): string {
  const n = normal.map((v) => Math.round(v * 1e6) / 1e6);
  const at = (k: number) => (origin[k] ? ` at ${"XYZ"[k]} = ${Math.round(origin[k] * 1e4) / 1e4}` : "");
  if (n[0] === 0 && n[1] === 0) return `Top (XY${n[2] < 0 ? ", flipped" : ""})${at(2)}`;
  if (n[0] === 0 && n[2] === 0) return `Front (XZ${n[1] > 0 ? ", flipped" : ""})${at(1)}`;
  if (n[1] === 0 && n[2] === 0) return `Right (YZ${n[0] < 0 ? ", flipped" : ""})${at(0)}`;
  return `normal [${n.join(", ")}] through [${origin.map((v) => Math.round(v * 1e4) / 1e4).join(", ")}]`;
}


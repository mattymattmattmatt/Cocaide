/// <reference lib="webworker" />
// The kernel runs here, off the UI thread.

import wasmUrl from "replicad-opencascadejs/wasm?url";
import {
  describeEdges,
  describeFaces,
  heapBytes,
  loadOC,
  RECYCLE_HEAP_BYTES,
  recycleOC,
  scoped,
  tessellate,
  type OC,
  type RebuildResult,
} from "../kernel";
import { LocalKernel } from "../ask/kernel";
import { exportRefusal } from "../doc/photo";
import { exportPartSTEP } from "../kernel/stepPart";
import { labelBodies } from "../kernel/bodies";
import { evaluate } from "./evaluate";
import { rebuild } from "../kernel/rebuild";
import { beforeKey, documentBefore, documentThrough, Recent } from "./before";
import { featureEffect } from "../kernel/featureEffect";
import { geometryKey } from "../doc/drawing";
import type { MeshData } from "../kernel/mesh";
import type { KernelRequest, KernelResponse, RebuildView, SessionPreview } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

const recycleAt = Number(import.meta.env.VITE_COCAIDE_RECYCLE_MB) * 2 ** 20 || RECYCLE_HEAP_BYTES;

/** Null while the kernel is loading or being recycled; requests queue meanwhile. */
let oc: OC | null = null;
const queue: KernelRequest[] = [];
/**
 * Serves the right-click ask's kernel queries and the drawing's projection.
 * It keeps the last rebuild, which the rebuild and export requests share: an
 * export, a drawing or an ask about the document on screen doesn't rebuild it again.
 */
const local = new LocalKernel(() => {
  if (!oc) throw new Error("the kernel is not loaded");
  return oc;
});

function post(msg: KernelResponse, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

function rebuildCached(doc: unknown): RebuildResult {
  return local.built(doc);
}

/** The part before a feature, by document and feature: plain data, so it outlives the rebuild it came from. */
const beforeViews = new Recent<RebuildView>(4);

/** The part before a feature session's feature: its rebuild (whose solid the effect is measured against) and its view. Freed when dropped. */
const sessionBefore = new Recent<{ result: RebuildResult; view: RebuildView }>(2, (b) => b.result.dispose());

/**
 * A feature session's preview: the part before the feature (rebuilt once and
 * kept while the session lasts), and the material the feature adds and
 * removes there: the part just after it compared with the part before it. The
 * part just after it is the document's own rebuild (`main`) when the feature
 * is the last one, as it is for a new feature.
 */
function sessionPreview(kernel: OC, doc: unknown, feature: string, have: string | undefined, main: RebuildResult): SessionPreview {
  const key = beforeKey(doc, feature);
  let before = sessionBefore.get(key);
  if (!before) {
    const result = rebuild(documentBefore(doc, feature), kernel);
    before = { result, view: viewOf(kernel, result) };
    sessionBefore.set(key, before);
  }
  const through = documentThrough(doc, feature);
  const own = through !== doc && geometryKey(through) !== geometryKey(doc);
  const after = own ? rebuild(through, kernel) : main;
  try {
    const status = after.features.find((f) => f.id === feature);
    let added: MeshData | null = null;
    let removed: MeshData | null = null;
    let addedVolume = 0;
    let removedVolume = 0;
    if (status?.ok && !status.suppressed) {
      const b = before.result.solid;
      scoped((s) => {
        const e = featureEffect(kernel, s, b, after.solid);
        added = e.added ? tessellate(kernel, e.added) : null;
        removed = e.removed ? tessellate(kernel, e.removed) : null;
        addedVolume = e.addedVolume;
        removedVolume = e.removedVolume;
      });
    }
    return {
      feature,
      beforeKey: key,
      ...(have === key ? {} : { before: before.view }),
      added,
      removed,
      addedVolume,
      removedVolume,
      ok: !!status?.ok,
      ...(status?.error ? { error: status.error } : !status ? { error: `${feature} is not in the document yet` } : {}),
    };
  } finally {
    if (own) after.dispose();
  }
}

const meshBuffers = (m: MeshData | null): ArrayBuffer[] => (m ? [m.positions.buffer, m.normals.buffer, m.indices.buffer, m.edges.buffer] : []) as ArrayBuffer[];

/** What the UI gets of a rebuild: plain data, the mesh and the B-rep faces and edges indexed like it. */
function viewOf(kernel: OC, result: RebuildResult): RebuildView {
  const mesh = result.solid ? tessellate(kernel, result.solid) : null;
  const topo = result.solid
    ? scoped((s) => {
        const f = describeFaces(kernel, s, result.solid!);
        return { faces: f.infos, edges: describeEdges(kernel, s, result.solid!, f.faces).infos };
      })
    : { faces: [], edges: [] };
  const bodies = result.bodies.map(({ name, faces, edges }) => ({ name, faces, edges }));
  if (bodies.length > 1) labelBodies(topo, bodies);
  return {
    ok: result.ok,
    name: result.name,
    errors: result.errors,
    features: result.features,
    sketches: result.sketches,
    measurements: result.measurements,
    mesh,
    faces: topo.faces,
    edges: topo.edges,
    bodies,
    datums: result.datums,
  };
}

async function handle(kernel: OC, req: KernelRequest) {
  try {
    if (req.type === "port") {
      const fn = local[req.method] as (...args: unknown[]) => Promise<unknown>;
      const result = await fn.apply(local, req.args);
      const png = (result as { png?: Uint8Array } | null)?.png;
      post({ id: req.id, type: "port", result }, png ? [png.buffer as ArrayBuffer] : []);
    } else if (req.type === "rebuild") {
      const t0 = performance.now();
      const result = rebuildCached(req.doc);
      const view = viewOf(kernel, result);
      const ms = performance.now() - t0;
      // A feature session's preview comes with it (the part before it is kept, so it is not sent again while the client has it).
      const session = req.session ? sessionPreview(kernel, req.doc, req.session.feature, req.session.have, result) : undefined;
      const transfer = [...meshBuffers(view.mesh), ...meshBuffers(session?.added ?? null), ...meshBuffers(session?.removed ?? null)];
      post({ id: req.id, type: "rebuilt", view, ms, ...(session ? { session } : {}) }, transfer);
    } else if (req.type === "evaluate") {
      post({ id: req.id, type: "evaluated", result: evaluate(kernel, rebuildCached(req.doc), req.doc, req.query) });
    } else if (req.type === "before") {
      // Its own rebuild, so the document on screen keeps the shared one; kept as plain data (copied out, never transferred).
      const key = beforeKey(req.doc, req.feature);
      let view = beforeViews.get(key);
      if (!view) {
        const result = rebuild(documentBefore(req.doc, req.feature), kernel);
        try {
          view = viewOf(kernel, result);
        } finally {
          result.dispose();
        }
        beforeViews.set(key, view);
      }
      post({ id: req.id, type: "before", view });
    } else {
      const refused = exportRefusal(req.doc);
      if (refused) {
        post({ id: req.id, type: "step", ok: false, errors: [refused] });
        return;
      }
      const result = rebuildCached(req.doc);
      if (!result.ok || !result.solid) {
        const errors = result.errors.length ? result.errors : ["document: nothing to export"];
        post({ id: req.id, type: "step", ok: false, errors });
        return;
      }
      post({ id: req.id, type: "step", ok: true, name: result.name, text: exportPartSTEP(kernel, result, req.doc) });
    }
  } catch (e) {
    post({ id: req.id, type: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

/** Drains the queue; swaps in a fresh kernel when the heap has grown too large. */
let draining = false;
async function drain() {
  if (draining) return; // one request at a time, even while one awaits
  draining = true;
  try {
    await drainQueue();
  } finally {
    draining = false;
  }
}

async function drainQueue() {
  while (oc && queue.length) {
    const req = queue.shift()!;
    // A rebuild with a newer one waiting behind it is not worth building: the newest change wins (a handle's drag sends many).
    if (req.type === "rebuild" && queue.some((q) => q.type === "rebuild")) {
      post({ id: req.id, type: "superseded" });
      continue;
    }
    await handle(oc, req);
    if (heapBytes(oc) > recycleAt) {
      const before = heapBytes(oc);
      local.reset();
      beforeViews.clear();
      sessionBefore.clear();
      oc = null;
      const t0 = performance.now();
      oc = await recycleOC();
      console.info(
        `cocaide: kernel recycled (heap ${Math.round(before / 2 ** 20)} MB -> ${Math.round(heapBytes(oc) / 2 ** 20)} MB, ${Math.round(performance.now() - t0)} ms)`,
      );
    }
  }
}

self.onmessage = (event: MessageEvent<KernelRequest>) => {
  queue.push(event.data);
  if (oc) void drain();
};

const t0 = performance.now();
loadOC({ wasmUrl })
  .then((instance) => {
    oc = instance;
    post({ id: 0, type: "ready", loadMs: performance.now() - t0 });
    void drain();
  })
  .catch((e) => post({ id: 0, type: "fatal", message: `could not load OpenCascade: ${e instanceof Error ? e.message : e}` }));

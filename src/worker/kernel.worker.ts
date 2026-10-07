/// <reference lib="webworker" />
// The kernel runs here, off the UI thread.

import wasmUrl from "replicad-opencascadejs/wasm?url";
import {
  describeEdges,
  describeFaces,
  exportSTEP,
  heapBytes,
  loadOC,
  rebuild,
  RECYCLE_HEAP_BYTES,
  recycleOC,
  scoped,
  tessellate,
  type OC,
  type RebuildResult,
} from "../kernel";
import { LocalKernel } from "../ask/kernel";
import { exportRefusal, photoNote } from "../doc/photo";
import { labelBodies } from "../kernel/bodies";
import type { KernelRequest, KernelResponse, RebuildView } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

const recycleAt = Number(import.meta.env.VITE_COCAIDE_RECYCLE_MB) * 2 ** 20 || RECYCLE_HEAP_BYTES;

/** Null while the kernel is loading or being recycled; requests queue meanwhile. */
let oc: OC | null = null;
/** The last rebuild, kept so an export of the same document does not rebuild again. */
let last: { key: string; result: RebuildResult } | null = null;
const queue: KernelRequest[] = [];
/** Serves the right-click ask's kernel queries; keeps its own last rebuild. */
const local = new LocalKernel(() => {
  if (!oc) throw new Error("the kernel is not loaded");
  return oc;
});

function post(msg: KernelResponse, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

function rebuildCached(kernel: OC, doc: unknown): RebuildResult {
  const key = JSON.stringify(doc);
  if (last?.key === key) return last.result;
  last?.result.dispose();
  last = null;
  const result = rebuild(doc, kernel);
  last = { key, result };
  return result;
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
      const result = rebuildCached(kernel, req.doc);
      const mesh = result.solid ? tessellate(kernel, result.solid) : null;
      const topo = result.solid
        ? scoped((s) => {
            const f = describeFaces(kernel, s, result.solid!);
            return { faces: f.infos, edges: describeEdges(kernel, s, result.solid!, f.faces).infos };
          })
        : { faces: [], edges: [] };
      const bodies = result.bodies.map(({ name, faces, edges }) => ({ name, faces, edges }));
      if (bodies.length > 1) labelBodies(topo, bodies);
      const view: RebuildView = {
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
      };
      const transfer = mesh ? [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, mesh.edges.buffer] : [];
      post({ id: req.id, type: "rebuilt", view, ms: performance.now() - t0 }, transfer as Transferable[]);
    } else {
      const refused = exportRefusal(req.doc);
      if (refused) {
        post({ id: req.id, type: "step", ok: false, errors: [refused] });
        return;
      }
      const result = rebuildCached(kernel, req.doc);
      if (!result.ok || !result.solid) {
        const errors = result.errors.length ? result.errors : ["document: nothing to export"];
        post({ id: req.id, type: "step", ok: false, errors });
        return;
      }
      post({ id: req.id, type: "step", ok: true, name: result.name, text: exportSTEP(kernel, result.solid, result.name, photoNote(req.doc), result.bodies) });
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
    await handle(oc, queue.shift()!);
    if (heapBytes(oc) > recycleAt) {
      const before = heapBytes(oc);
      last?.result.dispose();
      last = null;
      local.reset();
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

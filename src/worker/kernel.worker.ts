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
import type { KernelRequest, KernelResponse, RebuildView } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

const recycleAt = Number(import.meta.env.VITE_COCAIDE_RECYCLE_MB) * 2 ** 20 || RECYCLE_HEAP_BYTES;

/** Null while the kernel is loading or being recycled; requests queue meanwhile. */
let oc: OC | null = null;
/** The last rebuild, kept so an export of the same document does not rebuild again. */
let last: { key: string; result: RebuildResult } | null = null;
const queue: KernelRequest[] = [];

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

function handle(kernel: OC, req: KernelRequest) {
  try {
    if (req.type === "rebuild") {
      const t0 = performance.now();
      const result = rebuildCached(kernel, req.doc);
      const mesh = result.solid ? tessellate(kernel, result.solid) : null;
      const topo = result.solid
        ? scoped((s) => {
            const f = describeFaces(kernel, s, result.solid!);
            return { faces: f.infos, edges: describeEdges(kernel, s, result.solid!, f.faces).infos };
          })
        : { faces: [], edges: [] };
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
      };
      const transfer = mesh ? [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, mesh.edges.buffer] : [];
      post({ id: req.id, type: "rebuilt", view, ms: performance.now() - t0 }, transfer as Transferable[]);
    } else {
      const result = rebuildCached(kernel, req.doc);
      if (!result.ok || !result.solid) {
        const errors = result.errors.length ? result.errors : ["document: nothing to export"];
        post({ id: req.id, type: "step", ok: false, errors });
        return;
      }
      post({ id: req.id, type: "step", ok: true, name: result.name, text: exportSTEP(kernel, result.solid, result.name) });
    }
  } catch (e) {
    post({ id: req.id, type: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

/** Drains the queue; swaps in a fresh kernel when the heap has grown too large. */
async function drain() {
  while (oc && queue.length) {
    handle(oc, queue.shift()!);
    if (heapBytes(oc) > recycleAt) {
      const before = heapBytes(oc);
      last?.result.dispose();
      last = null;
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
  if (oc && queue.length === 1) void drain();
};

const t0 = performance.now();
loadOC({ wasmUrl })
  .then((instance) => {
    oc = instance;
    post({ id: 0, type: "ready", loadMs: performance.now() - t0 });
    void drain();
  })
  .catch((e) => post({ id: 0, type: "fatal", message: `could not load OpenCascade: ${e instanceof Error ? e.message : e}` }));

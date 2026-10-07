// Loads the OpenCascade WASM build once per process (tab, worker or Node).

import init, { type OpenCascadeInstance } from "replicad-opencascadejs";

export type OC = OpenCascadeInstance;

let instance: OC | null = null;
let loading: Promise<OC> | null = null;
let loadOptions: { wasmUrl?: string } = {};

/**
 * The WASM OCCT builds do not return the memory of deleted B-rep topology to
 * their heap (native OCCT does; measured: a box created and deleted 30 000
 * times grows the WASM heap by ~290 MB and native RSS not at all). Every
 * rebuild therefore costs heap (about 0.3 MB for the bracket, 4 MB for the
 * mounting plate). The kernel holds no state the document does not, so a
 * long-lived host swaps in a fresh instance once the heap passes this size;
 * see recycleOC().
 */
export const RECYCLE_HEAP_BYTES = 1024 * 2 ** 20;

/**
 * In Node the glue finds its .wasm next to itself. In a browser bundle pass
 * the URL the bundler gave the .wasm file.
 */
export function loadOC(options: { wasmUrl?: string } = {}): Promise<OC> {
  if (instance) return Promise.resolve(instance);
  if (!loading) {
    loadOptions = options;
    // OCCT's translators write progress statistics to stdout; keep them out of tool output.
    const args: Record<string, unknown> = { print: () => {}, printErr: (m: string) => console.warn(m) };
    if (options.wasmUrl) args.locateFile = () => options.wasmUrl;
    loading = init(args).then((oc) => {
      instance = oc;
      return oc;
    });
  }
  return loading;
}

/** Current size of the instance's WASM heap. It only grows. */
export function heapBytes(oc: OC = getOC()): number {
  return (oc as unknown as { wasmMemory: WebAssembly.Memory }).wasmMemory.buffer.byteLength;
}

/**
 * Drops the current instance and loads a fresh one with an empty heap. The
 * caller must already have deleted or dropped every handle that came from the
 * old instance (shapes, results); the old heap is freed once it is garbage.
 */
export function recycleOC(): Promise<OC> {
  instance = null;
  loading = null;
  return loadOC(loadOptions);
}

export function getOC(): OC {
  if (!instance) throw new Error("OpenCascade is not loaded yet; await loadOC() first");
  return instance;
}

/** Collects OCCT objects created during one operation and deletes them together. */
export class Scope {
  private readonly items: { delete(): void }[] = [];

  track<T extends { delete(): void }>(obj: T): T {
    this.items.push(obj);
    return obj;
  }

  dispose(): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      try {
        this.items[i].delete();
      } catch {
        // already deleted
      }
    }
    this.items.length = 0;
  }
}

/** Runs fn with a fresh scope that is always disposed afterwards. */
export function scoped<T>(fn: (s: Scope) => T): T {
  const s = new Scope();
  try {
    return fn(s);
  } finally {
    s.dispose();
  }
}

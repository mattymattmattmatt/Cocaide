// Promise wrapper around the kernel worker.

import type { KernelRequest, KernelResponse, RebuildView } from "./protocol";

type Pending = { resolve: (r: KernelResponse) => void; reject: (e: Error) => void };
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export class KernelClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  readonly ready: Promise<number>;

  constructor() {
    this.worker = new Worker(new URL("./kernel.worker.ts", import.meta.url), { type: "module" });
    let markReady!: (ms: number) => void;
    let fail!: (e: Error) => void;
    this.ready = new Promise((resolve, reject) => {
      markReady = resolve;
      fail = reject;
    });
    this.worker.onmessage = (event: MessageEvent<KernelResponse>) => {
      const msg = event.data;
      if (msg.type === "ready") return markReady(msg.loadMs);
      if (msg.type === "fatal") return fail(new Error(msg.message));
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.type === "error") p.reject(new Error(msg.message));
      else p.resolve(msg);
    };
    this.worker.onerror = (e) => fail(new Error(e.message || "kernel worker failed to start"));
  }

  private request(req: DistributiveOmit<KernelRequest, "id">): Promise<KernelResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...req, id });
    });
  }

  async rebuild(doc: unknown): Promise<{ view: RebuildView; ms: number }> {
    const r = await this.request({ type: "rebuild", doc });
    if (r.type !== "rebuilt") throw new Error("unexpected kernel reply");
    return { view: r.view, ms: r.ms };
  }

  async exportStep(doc: unknown): Promise<{ ok: true; name: string; text: string } | { ok: false; errors: string[] }> {
    const r = await this.request({ type: "exportStep", doc });
    if (r.type !== "step") throw new Error("unexpected kernel reply");
    return r.ok ? { ok: true, name: r.name, text: r.text } : { ok: false, errors: r.errors };
  }

  dispose() {
    this.worker.terminate();
  }
}

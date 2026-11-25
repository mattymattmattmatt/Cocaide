// Share project: one browser hands the open project to another (a headset, a
// laptop) by a 6-digit code. The sender holds the code open; the receiver
// types it; the two browsers connect directly (WebRTC, through PeerJS: its free
// public server only introduces them, the project goes from one to the other,
// encrypted, never stored anywhere) and the project arrives compressed, in pieces (a project carrying a .glb model
// is tens of megabytes), each side showing how far it has got.
// While the share is open anyone with the code can take a copy; it closes with
// the dialog, or after SHARE_MINUTES.

import Peer, { type DataConnection, type PeerOptions } from "peerjs";

/** How long a code stays open (minutes). */
export const SHARE_MINUTES = 15;
/** The size of each piece the packed project goes in (bytes). */
export const CHUNK = 256 * 1024;
/** How much may wait unsent before the sender pauses (bytes). */
const IN_FLIGHT = 4 * 1024 * 1024;
/** How long the receiver waits for the first word from the sender, and then between pieces (ms). */
const FIRST_WAIT = 20_000;
const IDLE_WAIT = 30_000;
const PREFIX = "cocaide-share-v1-";

/** A new 6-digit code (never starting with 0, so it reads as six digits). */
export function newCode(): string {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(100000 + (n[0] % 900000));
}
/** The code as people read it: "123 456". */
export const showCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;
/** What was typed, as a code (digits only), or null when it isn't six digits. */
export function readCode(typed: string): string | null {
  const d = typed.replace(/\D/g, "");
  return d.length === 6 ? d : null;
}
export const peerIdOf = (code: string) => `${PREFIX}${code}`;

/** What goes over the wire: the project's name and its text, deflated. */
export interface SharePacket {
  kind: "cocaide-project";
  name: string;
  data: ArrayBuffer;
  /** The text's length, to check it arrived whole. */
  length: number;
}

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream)).arrayBuffer());
}
/** The project packed to send (deflated: a furnished house is ~280 kB of text, ~25 kB packed). */
export async function pack(name: string, text: string): Promise<SharePacket> {
  const raw = new TextEncoder().encode(text);
  const data = await through(raw, new CompressionStream("deflate"));
  return { kind: "cocaide-project", name, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, length: text.length };
}
/** A packet back to the project's text, or what is wrong with it. */
export async function unpack(p: unknown): Promise<{ name: string; text: string } | { error: string }> {
  const o = p as Partial<SharePacket> | null;
  if (!o || o.kind !== "cocaide-project" || !o.data) return { error: "what arrived is not a Cocaide project" };
  const bytes = o.data instanceof ArrayBuffer ? new Uint8Array(o.data) : ArrayBuffer.isView(o.data) ? new Uint8Array((o.data as ArrayBufferView).buffer, (o.data as ArrayBufferView).byteOffset, (o.data as ArrayBufferView).byteLength) : null;
  if (!bytes) return { error: "what arrived is not a Cocaide project" };
  try {
    const text = new TextDecoder().decode(await through(bytes, new DecompressionStream("deflate")));
    if (typeof o.length === "number" && text.length !== o.length) return { error: "the project arrived incomplete: try again" };
    return { name: typeof o.name === "string" ? o.name : "project", text };
  } catch {
    return { error: "the project arrived damaged: try again" };
  }
}

/** The PeerJS server: its free public one, or (tests) a local one set on window.__cocaidePeer. */
function options(): PeerOptions {
  const o = (globalThis as { __cocaidePeer?: PeerOptions }).__cocaidePeer;
  return { debug: 0, ...(o ?? {}) };
}

/** Why a connection failed, in words. */
function why(e: unknown): string {
  const t = (e as { type?: string })?.type;
  if (t === "peer-unavailable") return "no device is sharing with that code (check it, and that Share is still open on the other device)";
  if (t === "network" || t === "server-error" || t === "socket-error" || t === "socket-closed") return "couldn't reach the sharing service: check this device is online";
  if (t === "browser-incompatible") return "this browser can't share (it has no WebRTC)";
  return (e as Error)?.message || String(e);
}

export interface Sharing {
  code: string;
  stop(): void;
}

/**
 * Open a share: a code others can take the project with. `project` is read when each device asks, so they get it as
 * it is then. Calls back when the code is ready, each time a device took it, and on failure.
 */
export function startSharing(
  project: () => Promise<SharePacket>,
  on: { ready(code: string): void; sent(count: number): void; failed(why: string): void; expired(): void; progress?(fraction: number, bytes: number): void },
): Sharing {
  let peer: Peer | null = null;
  let stopped = false;
  let sent = 0;
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const sharing: Sharing = {
    code: "",
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      peer?.destroy();
      peer = null;
    },
  };
  const open = () => {
    const code = newCode();
    const p = new Peer(peerIdOf(code), options());
    peer = p;
    p.on("open", () => {
      if (stopped) return p.destroy();
      sharing.code = code;
      on.ready(code);
      timer = setTimeout(() => {
        sharing.stop();
        on.expired();
      }, SHARE_MINUTES * 60_000);
    });
    p.on("connection", (conn: DataConnection) => {
      conn.on("open", () => {
        void project()
          .then((packet) => sendInPieces(conn, packet, (f, n) => on.progress?.(f, n)))
          .catch((e: Error) => on.failed(`couldn't send the project: ${e.message}`));
      });
      conn.on("data", (msg) => {
        if ((msg as { kind?: string })?.kind === "received") {
          sent++;
          on.sent(sent);
          setTimeout(() => conn.close(), 500);
        }
      });
    });
    p.on("error", (e) => {
      // Someone already holds this code: another.
      if ((e as { type?: string }).type === "unavailable-id" && tries++ < 5 && !stopped) {
        p.destroy();
        return open();
      }
      if ((e as { type?: string }).type === "peer-unavailable") return;
      if (!stopped) on.failed(why(e));
    });
  };
  open();
  return sharing;
}

/** What starts a project sent in pieces: its name, its text's length, how many packed bytes in how many pieces. */
export interface ShareStart {
  kind: "cocaide-project-start";
  name: string;
  length: number;
  size: number;
  chunks: number;
}
interface ShareChunk {
  kind: "cocaide-project-chunk";
  i: number;
  data: ArrayBuffer;
}

/** The packed project sent in pieces, pausing while too much waits unsent; `progress` after each. */
async function sendInPieces(conn: DataConnection, packet: SharePacket, progress: (fraction: number, bytes: number) => void): Promise<void> {
  const bytes = new Uint8Array(packet.data);
  const chunks = Math.max(1, Math.ceil(bytes.length / CHUNK));
  conn.send({ kind: "cocaide-project-start", name: packet.name, length: packet.length, size: bytes.length, chunks } satisfies ShareStart);
  // Unsent: what the channel holds, and what PeerJS queues before it (in its own ~16 kB pieces).
  const waiting = () => (conn.dataChannel?.bufferedAmount ?? 0) + ((conn as unknown as { bufferSize?: number }).bufferSize ?? 0) * 16_300;
  for (let i = 0; i < chunks; i++) {
    while (conn.open && waiting() > IN_FLIGHT) await new Promise((r) => setTimeout(r, 25));
    if (!conn.open) throw new Error("the other device went away");
    const piece = bytes.slice(i * CHUNK, Math.min(bytes.length, (i + 1) * CHUNK));
    conn.send({ kind: "cocaide-project-chunk", i, data: piece.buffer } satisfies ShareChunk);
    progress((i + 1) / chunks, bytes.length);
  }
}

/**
 * Take the project shared under `code`: its name and text, or why not. Gives up when the sender says nothing for
 * `firstMs` at first, or `idleMs` between pieces (a big project takes as long as it takes). `progress` as pieces come.
 */
export function receive(code: string, opts: { firstMs?: number; idleMs?: number; progress?: (fraction: number, bytes: number) => void } | number = {}): Promise<{ name: string; text: string }> {
  const o = typeof opts === "number" ? { firstMs: opts } : opts;
  const firstMs = o.firstMs ?? FIRST_WAIT;
  const idleMs = o.idleMs ?? IDLE_WAIT;
  return new Promise((resolve, reject) => {
    const peer = new Peer(options());
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (err: string | null, value?: { name: string; text: string }) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      setTimeout(() => peer.destroy(), 800);
      if (err) reject(new Error(err));
      else resolve(value!);
    };
    const wait = (ms: number, why: string) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish(why), ms);
    };
    wait(firstMs, "no answer from the other device: check the code, and that both devices are online");
    peer.on("error", (e) => finish(why(e)));
    peer.on("open", () => {
      const conn = peer.connect(peerIdOf(code), { reliable: true });
      let start: ShareStart | null = null;
      let buf: Uint8Array | null = null;
      let got = 0;
      const seen = new Set<number>();
      const take = (packet: unknown) =>
        void unpack(packet).then((r) => {
          if ("error" in r) return finish(r.error);
          conn.send({ kind: "received" });
          finish(null, r);
        });
      conn.on("data", (msg) => {
        const m = msg as { kind?: string };
        if (m?.kind === "cocaide-project-start") {
          start = msg as ShareStart;
          buf = new Uint8Array(start.size);
          wait(idleMs, "the project stopped arriving: try again (keep Share open on the other device)");
          o.progress?.(0, start.size);
        } else if (m?.kind === "cocaide-project-chunk" && start && buf) {
          const c = msg as ShareChunk;
          const data = c.data instanceof ArrayBuffer ? new Uint8Array(c.data) : new Uint8Array((c.data as ArrayBufferView).buffer, (c.data as ArrayBufferView).byteOffset, (c.data as ArrayBufferView).byteLength);
          if (!seen.has(c.i)) {
            seen.add(c.i);
            buf.set(data, c.i * CHUNK);
            got++;
          }
          wait(idleMs, "the project stopped arriving: try again (keep Share open on the other device)");
          o.progress?.(got / start.chunks, start.size);
          if (got === start.chunks) take({ kind: "cocaide-project", name: start.name, data: buf.buffer as ArrayBuffer, length: start.length } satisfies SharePacket);
        } else take(msg); // the whole project in one (an older sender)
      });
      conn.on("error", (e) => finish(why(e)));
    });
  });
}

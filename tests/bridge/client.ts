// A WebSocket client for the bridge tests that can set the Origin header (as a browser would).

import { randomBytes } from "node:crypto";
import { request } from "node:http";
import type { Socket } from "node:net";
import { decodeFrames } from "../../src/bridge/ws";
import type { ClientMessage, ServerMessage } from "../../src/bridge/protocol";

function maskedFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x81;
  if (len < 126) head[1] = 0x80 | len;
  else if (len < 65536) {
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

export interface TestClient {
  messages: ServerMessage[];
  send(m: ClientMessage | Record<string, unknown>): void;
  /** Resolves with the first message (from now or already received after `from`) that matches. */
  waitFor<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, timeoutMs?: number): Promise<T>;
  waitFor(pred: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  closed: Promise<void>;
  close(): void;
}

/** Connects; rejects with the HTTP status when the upgrade is refused. */
export function connect(port: number, origin: string | null = "http://localhost:5173", host = `127.0.0.1:${port}`): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"), Host: host };
    if (origin) headers.Origin = origin;
    const req = request({ host: "127.0.0.1", port, path: "/ws", headers });
    req.on("response", (res) => reject(new Error(`HTTP ${res.statusCode}`)));
    req.on("error", reject);
    req.on("upgrade", (_res, socket: Socket) => {
      const messages: ServerMessage[] = [];
      const waiters: { pred: (m: ServerMessage) => boolean; ok(m: ServerMessage): void }[] = [];
      let buf = Buffer.alloc(0);
      let closedOk!: () => void;
      const closed = new Promise<void>((r) => (closedOk = r));
      socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const r = decodeFrames(buf, false);
        buf = Buffer.from(r.rest);
        for (const f of r.frames) {
          if (f.opcode !== 1) continue;
          const m = JSON.parse(f.payload.toString("utf8")) as ServerMessage;
          messages.push(m);
          for (const w of [...waiters]) if (w.pred(m)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.ok(m);
          }
        }
      });
      socket.on("close", () => closedOk());
      resolve({
        messages,
        send: (m) => socket.write(maskedFrame(JSON.stringify(m))),
        waitFor: (pred: (m: ServerMessage) => boolean, timeoutMs = 60_000) =>
          new Promise<ServerMessage>((ok, fail) => {
            const hit = messages.find(pred);
            if (hit) return ok(hit);
            const t = setTimeout(() => fail(new Error(`timed out; got ${messages.map((m) => m.type).join(",")}`)), timeoutMs);
            waiters.push({ pred, ok: (m) => (clearTimeout(t), ok(m)) });
          }),
        closed,
        close: () => socket.destroy(),
      } as TestClient);
    });
    req.end();
  });
}

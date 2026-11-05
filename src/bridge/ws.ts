// A small WebSocket server endpoint (RFC 6455), enough for the bridge: the
// upgrade handshake, text messages (fragmented or not, any length), ping and
// pong, and close. No extensions, no binary messages. Written here so the
// bridge needs no package beyond what the repo already has.

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** The largest message the bridge takes from the app (a document with attachments). */
export const MAX_MESSAGE = 200 * 2 ** 20;

export function acceptKey(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

/** One frame's bytes (server frames are never masked). */
export function encodeFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const len = payload.length;
  const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = (fin ? 0x80 : 0) | opcode;
  if (len < 126) head[1] = len;
  else if (len < 65536) {
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

export interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** Reads whole frames from the front of `buf`; returns them and what is left over. Throws on a frame the server must refuse. */
export function decodeFrames(buf: Buffer, requireMask = true): { frames: Frame[]; rest: Buffer } {
  const frames: Frame[] = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const masked = (b1 & 0x80) !== 0;
    if (requireMask && !masked) throw new Error("client frames must be masked");
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      const big = buf.readBigUInt64BE(p);
      if (big > BigInt(MAX_MESSAGE)) throw new Error("message too large");
      len = Number(big);
      p += 8;
    }
    if (len > MAX_MESSAGE) throw new Error("message too large");
    const maskLen = masked ? 4 : 0;
    if (buf.length - p < maskLen + len) break;
    const mask = masked ? buf.subarray(p, p + 4) : null;
    p += maskLen;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

export class WsConnection {
  private buf: Buffer = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private partsLen = 0;
  private closed = false;
  onMessage: (text: string) => void = () => {};
  onClose: () => void = () => {};

  constructor(private readonly socket: Duplex) {
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("close", () => this.finish());
    socket.on("error", () => this.finish());
  }

  get open(): boolean {
    return !this.closed;
  }

  send(text: string) {
    if (this.closed) return;
    this.socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.socket.write(encodeFrame(0x8, body));
    this.socket.end();
    this.finish();
  }

  private finish() {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  private receive(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let frames: Frame[];
    try {
      const r = decodeFrames(this.buf);
      frames = r.frames;
      this.buf = Buffer.from(r.rest);
    } catch (e) {
      this.close(1009, (e as Error).message);
      return;
    }
    for (const f of frames) {
      if (f.opcode === 0x8) return this.close();
      if (f.opcode === 0x9) {
        this.socket.write(encodeFrame(0xa, f.payload));
        continue;
      }
      if (f.opcode === 0xa) continue;
      if (f.opcode === 0x2) return this.close(1003, "text messages only");
      if (f.opcode === 0x1 || f.opcode === 0x0) {
        this.parts.push(f.payload);
        this.partsLen += f.payload.length;
        if (this.partsLen > MAX_MESSAGE) return this.close(1009, "message too large");
        if (f.fin) {
          const text = Buffer.concat(this.parts).toString("utf8");
          this.parts = [];
          this.partsLen = 0;
          this.onMessage(text);
        }
      }
    }
  }
}

/** Completes the upgrade handshake; null (and the socket closed with 400) when the request is not a WebSocket one. */
export function upgrade(req: IncomingMessage, socket: Duplex): WsConnection | null {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || String(req.headers.upgrade).toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return null;
  }
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${acceptKey(key)}`, "", ""].join("\r\n"));
  return new WsConnection(socket);
}

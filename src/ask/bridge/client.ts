// The app's side of the Claude Code bridge connection (src/bridge): a
// WebSocket to the bridge on this computer, paired with the token the bridge
// printed. Used by the ask (run.ts), the settings panel's Test and Live link.

import { BRIDGE_VERSION, type ClaudeStatus, type ClientMessage, type ServerMessage } from "../../bridge/protocol";

/** The WebSocket constructor (the browser's; tests pass a stand-in). */
export type SocketCtor = new (url: string) => WebSocket;

export type BridgeProblem = "unreachable" | "unauthorized" | "no-token" | "bad-address";

export class BridgeError extends Error {
  constructor(
    readonly problem: BridgeProblem,
    message: string,
  ) {
    super(message);
  }
}

/** ws://127.0.0.1:8787/ws from the address shown in Settings ("http://127.0.0.1:8787", "127.0.0.1:8787"). */
export function socketUrl(address: string): string {
  const a = address.trim().replace(/\/+$/, "");
  const withScheme = /^[a-z]+:\/\//i.test(a) ? a : `http://${a}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new BridgeError("bad-address", `"${address}" is not an address. Use http://127.0.0.1:8787.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "ws:") throw new BridgeError("bad-address", "The bridge address starts with http:// (it runs on this computer).");
  return `ws://${u.host}/ws`;
}

/** What to do about a problem, in plain words. */
export function bridgeFix(problem: BridgeProblem): string {
  switch (problem) {
    case "unreachable":
      return "The bridge is not answering. In a terminal, in the Cocaide folder, run `npm run bridge` and leave it open. If the browser asks whether this site may reach devices on your local network, allow it.";
    case "unauthorized":
      return "The pairing token does not match. Copy the token the bridge printed in its terminal into the token field.";
    case "no-token":
      return "Paste the pairing token the bridge printed in its terminal (`npm run bridge`).";
    case "bad-address":
      return "Use the address the bridge printed, normally http://127.0.0.1:8787.";
  }
}

export class BridgeClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<(m: ServerMessage) => void>();
  private closers = new Set<() => void>();
  version = "";
  claude: ClaudeStatus | null = null;

  constructor(
    private readonly address: string,
    private readonly token: string,
    private readonly Socket: SocketCtor = WebSocket,
  ) {}

  /** Opens the connection and pairs; rejects with a BridgeError saying what is wrong. */
  connect(timeoutMs = 20000): Promise<ClaudeStatus> {
    if (!this.token.trim()) return Promise.reject(new BridgeError("no-token", bridgeFix("no-token")));
    let url: string;
    try {
      url = socketUrl(this.address);
    } catch (e) {
      return Promise.reject(e);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e: BridgeError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.close();
        reject(e);
      };
      const timer = setTimeout(() => fail(new BridgeError("unreachable", bridgeFix("unreachable"))), timeoutMs);
      let ws: WebSocket;
      try {
        ws = new this.Socket(url);
      } catch {
        fail(new BridgeError("unreachable", bridgeFix("unreachable")));
        return;
      }
      this.ws = ws;
      ws.onopen = () => this.send({ type: "hello", token: this.token.trim() });
      ws.onerror = () => fail(new BridgeError("unreachable", bridgeFix("unreachable")));
      ws.onclose = () => {
        fail(new BridgeError("unreachable", bridgeFix("unreachable")));
        for (const c of this.closers) c();
      };
      ws.onmessage = (ev: MessageEvent) => {
        let m: ServerMessage;
        try {
          m = JSON.parse(String(ev.data)) as ServerMessage;
        } catch {
          return;
        }
        if (!settled) {
          if (m.type === "error" && m.code === "unauthorized") return fail(new BridgeError("unauthorized", bridgeFix("unauthorized")));
          if (m.type === "welcome") {
            settled = true;
            clearTimeout(timer);
            this.version = m.version;
            this.claude = m.claude;
            resolve(m.claude);
          }
          return;
        }
        for (const l of this.listeners) l(m);
      };
    });
  }

  /** Whether the bridge is older or newer than this app expects (shown, not refused). */
  get versionNote(): string | null {
    return this.version && this.version.split(".")[0] !== BRIDGE_VERSION.split(".")[0] ? `The bridge is version ${this.version}; this app expects ${BRIDGE_VERSION}. Update the Cocaide folder (git pull) and restart the bridge.` : null;
  }

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === 1;
  }

  send(m: ClientMessage) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  on(l: (m: ServerMessage) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onClose(c: () => void): () => void {
    this.closers.add(c);
    return () => this.closers.delete(c);
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= 1) ws.close();
  }
}

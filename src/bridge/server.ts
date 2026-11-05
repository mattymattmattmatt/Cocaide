// The bridge's HTTP + WebSocket server, on 127.0.0.1 only. It answers pages
// from the hosted app and from localhost (dev / preview) and nobody else, and
// a connection does nothing until it sends the pairing token. Each
// connection runs at most one ask at a time and may follow one file.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { claudeStatus, findClaude } from "./claude";
import { BRIDGE_VERSION, DEFAULT_PORT, originAllowed, type ClientMessage, type ServerMessage } from "./protocol";
import { BridgeSession } from "./session";
import { DocWatcher } from "./watch";
import { upgrade, type WsConnection } from "./ws";

export interface BridgeOptions {
  port?: number;
  dataDir?: string;
  /** The pairing token; by default the one kept in <dataDir>/token (made on first start). */
  token?: string;
  /** Make a new pairing token (the old one stops working). */
  newToken?: boolean;
  /** The claude executable (or a .js file run with this Node); default: found on PATH. */
  claudePath?: string;
  serverPath: string;
  tsxLoader: string;
  timeoutMs?: number;
  idleMs?: number;
  log?(line: string): void;
}

export interface Bridge {
  port: number;
  token: string;
  dataDir: string;
  close(): Promise<void>;
}

export const defaultDataDir = () => join(homedir(), ".cocaide-bridge");

/** The pairing token kept in the data folder (only readable by this user where the system allows it). */
export function pairingToken(dataDir: string, fresh = false): string {
  const file = join(dataDir, "token");
  if (!fresh && existsSync(file)) {
    const t = readFileSync(file, "utf8").trim();
    if (t.length >= 20) return t;
  }
  mkdirSync(dataDir, { recursive: true });
  const t = randomBytes(18).toString("base64url");
  writeFileSync(file, t + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows: the user's profile folder already keeps it to them
  }
  return t;
}

export function tokenMatches(given: unknown, token: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Only requests addressed to this computer by name: a page on another site cannot reach the bridge through DNS tricks. */
function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase());
}

function cors(res: ServerResponse, origin: string) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  // Chrome asks before a public site (the hosted app) reaches 127.0.0.1.
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

export async function startBridge(o: BridgeOptions): Promise<Bridge> {
  const dataDir = resolve(o.dataDir ?? defaultDataDir());
  mkdirSync(dataDir, { recursive: true });
  const token = o.token ?? pairingToken(dataDir, o.newToken);
  const log = o.log ?? (() => {});
  let claude = findClaude(o.claudePath);
  let port = o.port ?? DEFAULT_PORT;
  const live = new Set<{ stop(): void }>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (!hostAllowed(req.headers.host, port)) {
      res.writeHead(403).end();
      return;
    }
    if (origin !== undefined && !originAllowed(origin)) {
      res.writeHead(403, { "content-type": "text/plain" }).end("This page's origin may not use the Cocaide bridge.");
      return;
    }
    if (origin) cors(res, origin);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name: "cocaide-bridge", version: BRIDGE_VERSION }));
      return;
    }
    res.writeHead(404).end();
  });

  server.on("upgrade", (req, socket) => {
    const url = (req.url ?? "").split("?")[0];
    if (url !== "/ws" || !hostAllowed(req.headers.host, port) || !originAllowed(req.headers.origin)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const ws = upgrade(req, socket);
    if (ws) connection(ws);
  });

  function connection(ws: WsConnection) {
    let authed = false;
    let session: BridgeSession | null = null;
    let follow: DocWatcher | null = null;
    const send = (m: ServerMessage) => ws.send(JSON.stringify(m));
    const handle = { stop: () => ws.close(1001, "bridge stopping") };
    live.add(handle);
    const helloTimer = setTimeout(() => !authed && ws.close(1008, "no hello"), 10_000);
    ws.onClose = () => {
      clearTimeout(helloTimer);
      live.delete(handle);
      session?.stop();
      follow?.stop();
    };
    ws.onMessage = async (text) => {
      let m: ClientMessage;
      try {
        m = JSON.parse(text) as ClientMessage;
      } catch {
        send({ type: "error", code: "bad-request", message: "not JSON" });
        return;
      }
      if (!authed) {
        if (m.type !== "hello" || !tokenMatches(m.token, token)) {
          log("refused a connection: wrong or missing pairing token");
          send({ type: "error", code: "unauthorized", message: "The pairing token does not match. Copy the token the bridge printed in its terminal into Settings → Assistant." });
          ws.close(1008, "unauthorized");
          return;
        }
        authed = true;
        clearTimeout(helloTimer);
        claude = findClaude(o.claudePath);
        send({ type: "welcome", version: BRIDGE_VERSION, claude: await claudeStatus(claude) });
        return;
      }
      switch (m.type) {
        case "status":
          claude = findClaude(o.claudePath);
          send({ type: "status", claude: await claudeStatus(claude) });
          return;
        case "ask": {
          if (session) {
            send({ type: "error", code: "busy", message: "An ask is already running on this connection.", id: m.id });
            return;
          }
          if (typeof m.id !== "string" || typeof m.prompt !== "string" || typeof m.doc !== "string" || !Array.isArray(m.scope)) {
            send({ type: "error", code: "bad-request", message: "ask needs id, prompt, doc and scope", ...(typeof m.id === "string" ? { id: m.id } : {}) });
            return;
          }
          const s = new BridgeSession({ ...m, context: typeof m.context === "string" ? m.context : "" }, {
            dataDir,
            claude,
            serverPath: o.serverPath,
            tsxLoader: o.tsxLoader,
            timeoutMs: o.timeoutMs,
            idleMs: o.idleMs,
            emit: send,
            log,
          });
          session = s;
          void s.done.then(() => {
            if (session === s) session = null;
          });
          s.start();
          return;
        }
        case "abort":
          if (session && session.ask.id === m.id) session.stop();
          return;
        case "follow": {
          follow?.stop();
          follow = null;
          const path = typeof m.path === "string" ? m.path.trim().replace(/^"(.*)"$/, "$1") : "";
          // Only part files: the bridge does not read anything else on this computer for a page.
          if (!path || !isAbsolute(path) || extname(path).toLowerCase() !== ".json") {
            send({ type: "followError", path, message: "Give the full path of a .cocaide.json file (for example G:/CocaideParts/part.cocaide.json)." });
            return;
          }
          const p = resolve(path);
          log(`following ${p}`);
          follow = new DocWatcher(p, {
            onChange: (text) => send({ type: "follow", path: p, text }),
            onError: (message) => send({ type: "followError", path: p, message }),
          }).start();
          void follow.check(true);
          return;
        }
        case "unfollow":
          follow?.stop();
          follow = null;
          return;
        default:
          send({ type: "error", code: "bad-request", message: `unknown message ${(m as { type?: unknown }).type}` });
      }
    };
  }

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", fail);
      port = (server.address() as AddressInfo).port;
      ok();
    });
  });
  return {
    port,
    token,
    dataDir,
    close: () =>
      new Promise<void>((ok) => {
        for (const h of [...live]) h.stop();
        server.close(() => ok());
        server.closeAllConnections?.();
      }),
  };
}

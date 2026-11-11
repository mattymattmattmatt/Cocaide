// The Claude Code bridge's wire protocol: what the app and the local bridge
// (src/bridge/server.ts) say to each other over the WebSocket. Pure and
// browser-safe: the app imports it as well as the bridge.
//
// The app connects to ws://127.0.0.1:<port>/ws and first sends `hello` with
// the pairing token the bridge printed in its terminal. Anything else before
// a good hello closes the connection.

/**
 * The bridge's version. Bump the minor number whenever Cocaide's tools change
 * (tests/bridge-version.test.ts fails until you do), so an app newer than the
 * bridge on the user's computer can say the bridge is out of date.
 */
export const BRIDGE_VERSION = "1.1.0";

/** Whether bridge version `have` is older than `want` (or a different major version). */
export function bridgeOutdated(have: string, want: string = BRIDGE_VERSION): boolean {
  const a = have.split(".").map((n) => parseInt(n, 10) || 0);
  const b = want.split(".").map((n) => parseInt(n, 10) || 0);
  if (a[0] !== b[0]) return true;
  for (let i = 1; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

/** What to tell the user when their bridge is older than the app. */
export function bridgeOutdatedNote(have: string): string {
  return `Your Cocaide bridge (version ${have}) is older than this app (${BRIDGE_VERSION}), so the AI is missing some of Cocaide's newer tools (for example adding a profile from the section library). Close the "Cocaide bridge" window and double-click start-cocaide.bat again: it updates the Cocaide folder and restarts the bridge. (Or run git pull and npm install in the Cocaide folder, then npm run bridge.)`;
}
export const DEFAULT_PORT = 8787;
export const DEFAULT_URL = `http://127.0.0.1:${DEFAULT_PORT}`;

/** The hosted app's origin. With any http://localhost or http://127.0.0.1 port (npm run dev / preview) the only ones the bridge answers. */
export const HOSTED_ORIGIN = "https://mattymattmattmatt.github.io";

/** Whether a page at this origin may drive the bridge. */
export function originAllowed(origin: string | undefined | null): boolean {
  if (!origin) return false;
  if (origin === HOSTED_ORIGIN) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/.test(origin);
}

/** The model choices passed to `claude --model` ("default": whatever the user's Claude Code uses). */
export const BRIDGE_MODELS: { id: BridgeModel; label: string }[] = [
  { id: "default", label: "Claude Code's default" },
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
];
export type BridgeModel = "default" | "sonnet" | "opus";

/** The only tools a bridge session may run: Cocaide's. */
export const MCP_SERVER_NAME = "cocaide";
export const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export interface BridgeAttachment {
  name: string;
  mediaType: string;
  /** Base64 (images, PDFs): saved into the session folder for Claude Code to read. */
  data?: string;
  /** Text (text files, DXF/STEP summaries, a PDF's text layer): put in the prompt. */
  text?: string;
}

/** What Claude Code reports about itself on this computer. */
export interface ClaudeStatus {
  installed: boolean;
  version?: string;
  /** null: could not tell (an older Claude Code without `claude auth status`). */
  loggedIn: boolean | null;
  authMethod?: string;
  /** What is wrong and how to fix it, in plain words. */
  problem?: string;
}

// ------------------------------------------------------------ app -> bridge

export type ClientMessage =
  | { type: "hello"; token: string }
  | { type: "status" }
  | {
      type: "ask";
      /** The app's id for this ask; every event about it carries it. */
      id: string;
      prompt: string;
      /** The document as .cocaide.json text. */
      doc: string;
      /** The write scope (feature ids, "+" for new features; ["*"]: anything). */
      scope: string[];
      /** The app's context packet as text (what was right-clicked, the part's outline). */
      context: string;
      attachments?: BridgeAttachment[];
      /** A Claude Code session to continue (a follow-up). */
      resume?: string;
      model?: BridgeModel;
    }
  | { type: "abort"; id: string }
  | { type: "follow"; path: string }
  | { type: "unfollow" };

// ------------------------------------------------------------ bridge -> app

export type ServerMessage =
  | { type: "welcome"; version: string; claude: ClaudeStatus }
  | { type: "status"; claude: ClaudeStatus }
  | { type: "error"; code: "unauthorized" | "bad-request" | "busy" | "internal"; message: string; id?: string }
  | { type: "started"; id: string }
  | { type: "init"; id: string; sessionId: string; model?: string; tools: number; mcp?: string }
  | { type: "text"; id: string; text: string }
  | { type: "tool"; id: string; callId: string; name: string; args: string }
  | { type: "toolResult"; id: string; callId: string; ok: boolean; error?: string }
  | { type: "doc"; id: string; text: string }
  | { type: "notice"; id: string; text: string }
  | {
      type: "done";
      id: string;
      ok: boolean;
      /** The final reply, or what went wrong (verbatim from Claude Code for quota and login problems). */
      text: string;
      sessionId?: string;
      /** The document as it ended (also sent as `doc` events along the way). */
      doc?: string;
      errorKind?: "login" | "rate-limit" | "crash" | "timeout" | "aborted" | "not-installed" | "error";
      costUsd?: number;
      durationMs?: number;
      turns?: number;
      usage?: Record<string, number>;
    }
  | { type: "follow"; path: string; text: string }
  | { type: "followError"; path: string; message: string };

/** A tool call's arguments, short enough for a step list: `{"id":"hole_1","patch":{"diameter":8}}` cut at `max` characters. */
export function shortArgs(input: unknown, max = 120): string {
  let s: string;
  try {
    s = JSON.stringify(input) ?? "";
  } catch {
    s = String(input);
  }
  if (s === "{}") return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A Cocaide tool's plain name ("mcp__cocaide__addFeature" -> "addFeature"); null for any other tool. */
export function cocaideTool(name: string): string | null {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : null;
}

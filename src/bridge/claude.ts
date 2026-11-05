// Claude Code on this computer: finding the `claude` executable (without a
// shell, also on Windows), asking it its version and whether it is logged
// in, the arguments of a headless run limited to Cocaide's tools, and
// reading its stream-json output.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { cocaideTool, MCP_SERVER_NAME, shortArgs, TOOL_PREFIX, type BridgeModel, type ClaudeStatus } from "./protocol";

/** How to start Claude Code: the program, and arguments that go before Claude Code's own. */
export interface ClaudeCommand {
  command: string;
  prefix: string[];
  /** Only for a Windows .cmd shim whose script could not be found: run through cmd.exe (arguments are quoted). */
  shell?: boolean;
}

const isScript = (p: string) => /\.(c|m)?js$/i.test(p);

/**
 * Where Claude Code is. `override` (--claude, or COCAIDE_CLAUDE) is used as given: a .js file runs with this
 * Node. Otherwise PATH is searched; on Windows npm's claude.cmd is turned into "node <its cli.js>" so no shell
 * (and no path mangling) is involved, and the native installer's claude.exe is found in ~/.local/bin too.
 */
export function findClaude(override?: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ClaudeCommand | null {
  if (override) return isScript(override) ? { command: process.execPath, prefix: [override] } : { command: override, prefix: [] };
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean);
  const home = env.USERPROFILE ?? env.HOME;
  if (home) dirs.push(join(home, ".local", "bin"));
  const file = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  for (const dir of dirs) {
    if (platform === "win32") {
      const exe = join(dir, "claude.exe");
      if (file(exe)) return { command: exe, prefix: [] };
      const cmd = join(dir, "claude.cmd");
      if (file(cmd)) {
        const cli = npmCli(dir);
        return cli ? { command: process.execPath, prefix: [cli] } : { command: cmd, prefix: [], shell: true };
      }
    } else {
      const p = join(dir, "claude");
      if (file(p)) return { command: p, prefix: [] };
    }
  }
  return null;
}

/** npm's global layout: <dir>/claude.cmd beside <dir>/node_modules/@anthropic-ai/claude-code/cli.js. */
function npmCli(dir: string): string | null {
  for (const name of ["cli.js", "cli.mjs"]) {
    const p = join(dir, "node_modules", "@anthropic-ai", "claude-code", name);
    if (existsSync(p)) return p;
  }
  return null;
}

/** An argument quoted for cmd.exe (only for the .cmd fallback). */
function cmdQuote(a: string): string {
  return /^[\w\-.:/\\=@,]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  shell: boolean;
}

export function spawnSpec(c: ClaudeCommand, args: string[]): SpawnSpec {
  const all = [...c.prefix, ...args];
  return c.shell ? { command: cmdQuote(c.command), args: all.map(cmdQuote), shell: true } : { command: c.command, args: all, shell: false };
}

/** Runs Claude Code briefly (--version, auth status) and gives its output. */
export function runBrief(c: ClaudeCommand, args: string[], timeoutMs = 15000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const s = spawnSpec(c, args);
    let out = "";
    let err = "";
    let child;
    try {
      child = spawn(s.command, s.args, { shell: s.shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, out: "", err: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, out, err: err || e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

export const INSTALL_FIX = "Install it with: npm install -g @anthropic-ai/claude-code   then run `claude` once in a terminal and log in with your Claude subscription.";
export const LOGIN_FIX = "Run `claude` in a terminal and log in with your Claude subscription (or `claude auth login`), then press Test again.";

/** Whether Claude Code is installed and logged in, with the fix when it is not. */
export async function claudeStatus(c: ClaudeCommand | null): Promise<ClaudeStatus> {
  if (!c) return { installed: false, loggedIn: null, problem: `Claude Code (the claude command) was not found. ${INSTALL_FIX}` };
  const v = await runBrief(c, ["--version"]);
  if (v.code !== 0) return { installed: false, loggedIn: null, problem: `claude --version failed: ${(v.err || v.out).trim().slice(0, 300) || `exit ${v.code}`}. ${INSTALL_FIX}` };
  const version = v.out.trim().split(/\r?\n/)[0];
  const a = await runBrief(c, ["auth", "status"]);
  if (a.code === null && !a.out) return { installed: true, version, loggedIn: null };
  try {
    const j = JSON.parse(a.out) as { loggedIn?: boolean; authMethod?: string };
    if (typeof j.loggedIn !== "boolean") return { installed: true, version, loggedIn: null };
    return { installed: true, version, loggedIn: j.loggedIn, ...(j.authMethod ? { authMethod: j.authMethod } : {}), ...(j.loggedIn ? {} : { problem: `Claude Code is not logged in. ${LOGIN_FIX}` }) };
  } catch {
    // An older Claude Code without `auth status`: the first ask tells.
    return { installed: true, version, loggedIn: null };
  }
}

/** Built-in tools a bridge session never gets (on top of offering none but Read). */
export const DENIED_TOOLS = ["Bash", "BashOutput", "KillShell", "PowerShell", "Edit", "MultiEdit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent", "Glob", "Grep", "LS", "TodoWrite", "SlashCommand", "Skill"];

/** A path as Claude Code's permission rules write an absolute one: "//home/me/x", "//c/Users/me/x". */
export function rulePath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  const posix = m ? `/${m[1].toLowerCase()}/${m[2]}` : p;
  return `/${posix.replace(/\\/g, "/").replace(/\/+$/, "")}`;
}

export interface RunOptions {
  mcpConfig: string;
  appendSystem: string;
  model?: BridgeModel;
  resume?: string;
  /** The session's attachments folder: Read is offered for it alone. */
  attachDir?: string;
}

/** The arguments of one headless run. The prompt goes on stdin (no length limit, no quoting). */
export function claudeArgs(o: RunOptions): string[] {
  const allowed = [`mcp__${MCP_SERVER_NAME}`, `${TOOL_PREFIX}*`, ...(o.attachDir ? [`Read(${rulePath(o.attachDir)}/**)`] : [])];
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--mcp-config",
    o.mcpConfig,
    "--strict-mcp-config",
    "--tools",
    o.attachDir ? "Read" : "",
    "--allowedTools",
    allowed.join(","),
    "--disallowedTools",
    DENIED_TOOLS.join(","),
    "--append-system-prompt",
    o.appendSystem,
    ...(o.model && o.model !== "default" ? ["--model", o.model] : []),
    ...(o.resume ? ["--resume", o.resume] : []),
  ];
}

/** The MCP config a run uses: Cocaide's server on the session's document, started with this Node and the tsx loader (no shell, no npx). */
export function mcpConfig(o: { serverPath: string; tsxLoader: string; docPath: string; scope: string[]; outDir: string }) {
  const scope = o.scope.length ? o.scope.join(",") : "*";
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "stdio",
        command: process.execPath,
        args: ["--import", o.tsxLoader, o.serverPath, "--doc", o.docPath, "--scope", scope, "--out", o.outDir],
      },
    },
  };
}

// ------------------------------------------------------------ stream-json

export type StreamEvent =
  | { kind: "init"; sessionId: string; model?: string; tools: number; mcp?: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; callId: string; name: string; args: string }
  | { kind: "toolResult"; callId: string; name: string; ok: boolean; error?: string; changed: boolean }
  | { kind: "notice"; text: string }
  | {
      kind: "result";
      ok: boolean;
      text: string;
      sessionId?: string;
      costUsd?: number;
      durationMs?: number;
      turns?: number;
      usage?: Record<string, number>;
      errorKind?: "login" | "rate-limit" | "error";
    }
  | { kind: "skip"; reason: string };

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => typeof v === "object" && v !== null && !Array.isArray(v);

/** What kind of failure a message from Claude Code describes. */
export function errorKindOf(text: string): "login" | "rate-limit" | "error" {
  if (/\/login|not logged in|invalid api key|authenticat|oauth token|credentials/i.test(text)) return "login";
  if (/usage limit|rate.?limit|quota|limit reached|too many requests|\b429\b|overloaded/i.test(text)) return "rate-limit";
  return "error";
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((b) => (isObj(b) && b.type === "text" && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  return "";
}

/** Reads Claude Code's stream-json lines into the bridge's events. Keeps which call is which, and whether text came as deltas. */
export class StreamReader {
  private names = new Map<string, string>();
  private deltas = false;
  sessionId: string | undefined;

  line(raw: string): StreamEvent[] {
    const s = raw.trim();
    if (!s) return [];
    let j: unknown;
    try {
      j = JSON.parse(s);
    } catch {
      return [{ kind: "skip", reason: `not JSON: ${s.slice(0, 200)}` }];
    }
    if (!isObj(j) || typeof j.type !== "string") return [{ kind: "skip", reason: "not an event" }];
    if (typeof j.session_id === "string") this.sessionId = j.session_id;
    switch (j.type) {
      case "system": {
        if (j.subtype !== "init") return [];
        const servers = Array.isArray(j.mcp_servers) ? j.mcp_servers.filter(isObj) : [];
        const ours = servers.find((m) => m.name === MCP_SERVER_NAME);
        const tools = Array.isArray(j.tools) ? j.tools.filter((t) => typeof t === "string" && t.startsWith(TOOL_PREFIX)).length : 0;
        return [
          {
            kind: "init",
            sessionId: String(j.session_id ?? ""),
            ...(typeof j.model === "string" ? { model: j.model } : {}),
            tools,
            ...(ours && typeof ours.status === "string" ? { mcp: ours.status } : {}),
          },
        ];
      }
      case "stream_event": {
        const e = j.event;
        if (isObj(e) && e.type === "content_block_delta" && isObj(e.delta) && e.delta.type === "text_delta" && typeof e.delta.text === "string") {
          this.deltas = true;
          return [{ kind: "text", text: e.delta.text }];
        }
        return [];
      }
      case "assistant": {
        const m = j.message;
        if (!isObj(m) || !Array.isArray(m.content)) return [];
        const out: StreamEvent[] = [];
        for (const b of m.content) {
          if (!isObj(b)) continue;
          if (b.type === "text" && typeof b.text === "string" && !this.deltas) out.push({ kind: "text", text: b.text });
          if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
            this.names.set(b.id, b.name);
            out.push({ kind: "tool", callId: b.id, name: cocaideTool(b.name) ?? b.name, args: shortArgs(b.input) });
          }
        }
        // A turn ends: the next one's text may come whole again.
        if (m.stop_reason) this.deltas = false;
        if (typeof j.error === "string") out.push({ kind: "notice", text: `Claude Code reported: ${j.error}` });
        return out;
      }
      case "user": {
        const m = j.message;
        if (!isObj(m) || !Array.isArray(m.content)) return [];
        const out: StreamEvent[] = [];
        for (const b of m.content) {
          if (!isObj(b) || b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
          const name = this.names.get(b.tool_use_id) ?? "";
          const text = resultText(b.content);
          let changed = false;
          try {
            const r = JSON.parse(text) as J;
            changed = r.changed === true || (typeof r.revision === "number" && r.ok === true && !!cocaideTool(name));
          } catch {
            // not Cocaide's JSON
          }
          const ok = b.is_error !== true;
          out.push({ kind: "toolResult", callId: b.tool_use_id, name: cocaideTool(name) ?? name, ok, ...(ok ? {} : { error: errorText(text) }), changed: ok && changed });
        }
        return out;
      }
      case "rate_limit_event": {
        const info = isObj(j.rate_limit_info) ? j.rate_limit_info : j;
        const status = typeof info.status === "string" ? info.status : "";
        if (status === "allowed") return [];
        const resets = typeof info.resetsAt === "number" ? ` (resets ${new Date(info.resetsAt * 1000).toLocaleString()})` : "";
        return [{ kind: "notice", text: `Claude Code rate limit: ${status || "limited"}${resets}` }];
      }
      case "result": {
        const text = typeof j.result === "string" ? j.result : Array.isArray(j.errors) ? j.errors.map(String).join("\n") : String(j.subtype ?? "");
        const ok = j.is_error !== true && (j.subtype === undefined || j.subtype === "success");
        const usage = isObj(j.usage) ? Object.fromEntries(Object.entries(j.usage).filter(([, v]) => typeof v === "number")) as Record<string, number> : undefined;
        return [
          {
            kind: "result",
            ok,
            text: ok ? text : text || `Claude Code stopped: ${String(j.subtype ?? "error")}`,
            ...(typeof j.session_id === "string" ? { sessionId: j.session_id } : {}),
            ...(typeof j.total_cost_usd === "number" ? { costUsd: j.total_cost_usd } : {}),
            ...(typeof j.duration_ms === "number" ? { durationMs: j.duration_ms } : {}),
            ...(typeof j.num_turns === "number" ? { turns: j.num_turns } : {}),
            ...(usage ? { usage } : {}),
            ...(ok ? {} : { errorKind: errorKindOf(text) }),
          },
        ];
      }
      default:
        return [];
    }
  }
}

/** A failed call's reason, short: Cocaide's {"ok":false,"error":"..."} or the text itself. */
function errorText(text: string): string {
  try {
    const r = JSON.parse(text) as J;
    if (typeof r.error === "string") return r.error.slice(0, 300);
  } catch {
    // plain text
  }
  return text.slice(0, 300) || "failed";
}

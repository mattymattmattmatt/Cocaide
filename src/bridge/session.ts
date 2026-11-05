// One ask from the app, run by Claude Code headless: the document is written
// to the session's working file, Claude Code is started with Cocaide's MCP
// server on that file (and no other tools), its stream is turned into the
// app's events, and every new version of the working file is pushed to the
// app as it is written. Ends with `done`: the reply, the session id for a
// follow-up, and what went wrong if anything did.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { claudeArgs, errorKindOf, INSTALL_FIX, LOGIN_FIX, mcpConfig, spawnSpec, StreamReader, type ClaudeCommand, type StreamEvent } from "./claude";
import type { ClientMessage, ServerMessage } from "./protocol";
import { DocWatcher } from "./watch";

export type AskMessage = Extract<ClientMessage, { type: "ask" }>;
type Done = Extract<ServerMessage, { type: "done" }>;

export interface SessionOptions {
  dataDir: string;
  claude: ClaudeCommand | null;
  /** src/mcp/server.ts, and the tsx loader as a file: URL. */
  serverPath: string;
  tsxLoader: string;
  /** The whole run's limit, and how long it may go without output. */
  timeoutMs?: number;
  idleMs?: number;
  emit(m: ServerMessage): void;
  /** Lines for the bridge's terminal (never tokens, never document text). */
  log?(line: string): void;
}

export const SYSTEM_APPEND = `You are working for the user inside Cocaide's AI panel, through a local bridge. The part is open in their browser: it is the document the "cocaide" MCP server holds, and every change you make there appears live in their 3D view.
- Use only the mcp__cocaide__ tools to read and change the part. Read the reference (the reference tool, or cocaide://reference) when unsure of an op or a field.
- Your changes are a proposal: when you finish, the user accepts or discards them in the app as one step. Do not ask for permission to edit; make the change, check it (partSummary, measure, a screenshot), and end with a short summary of what you changed and anything they should check.
- The write scope is set by the app and enforced by the server: a refused call means it is outside what the user allowed; say so instead of working around it.
- Do not export or save files unless the user asks.
- Files the user attached are listed in the prompt with their full paths; read them with the Read tool.`;

const safeName = (n: string) => basename(n).replace(/[^\w.\- ]+/g, "_").slice(0, 80) || "file";

/** The prompt sent on stdin: the request, the app's context packet, and the attachments. */
export function promptText(ask: AskMessage, files: string[], texts: { name: string; text: string }[]): string {
  return [
    ask.prompt.trim(),
    ask.context.trim() ? `\n--- Context from the Cocaide app (what the user pointed at, the part's outline) ---\n${ask.context.trim()}` : "",
    `\nWrite scope: ${ask.scope.length && !ask.scope.includes("*") ? ask.scope.join(", ") : "the whole part"}.`,
    files.length ? `\n--- Attached files (read them with the Read tool) ---\n${files.join("\n")}` : "",
    ...texts.map((t) => `\n--- Attached: ${t.name} ---\n${t.text}`),
  ].join("\n");
}

/** Ends a process and everything it started (the MCP server too). */
export function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 2000).unref();
}

export class BridgeSession {
  readonly dir: string;
  readonly docPath: string;
  private child: ChildProcess | null = null;
  private watcher: DocWatcher | null = null;
  private ended: Done["errorKind"] | null = null;
  private finished = false;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private idle: ReturnType<typeof setTimeout> | null = null;
  /** Resolves when the session has sent `done`. */
  readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor(
    readonly ask: AskMessage,
    private readonly o: SessionOptions,
  ) {
    const sid = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    this.dir = join(o.dataDir, "sessions", sid);
    this.docPath = join(this.dir, "part.cocaide.json");
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  private emit(m: ServerMessage) {
    this.o.emit(m);
  }

  start() {
    const { ask, o } = this;
    const id = ask.id;
    try {
      JSON.parse(ask.doc);
    } catch {
      return this.finish({ type: "done", id, ok: false, text: "The document sent to the bridge is not valid JSON.", errorKind: "error" });
    }
    if (!o.claude) return this.finish({ type: "done", id, ok: false, text: `Claude Code (the claude command) was not found on this computer. ${INSTALL_FIX}`, errorKind: "not-installed" });

    // The working folder: the document, its attachments, the MCP config. Claude Code runs in one shared folder so --resume finds earlier sessions.
    const attachDir = join(this.dir, "attachments");
    const work = join(o.dataDir, "work");
    mkdirSync(attachDir, { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(this.docPath, ask.doc);
    const files: string[] = [];
    const texts: { name: string; text: string }[] = [];
    for (const a of ask.attachments ?? []) {
      if (a.data) {
        let name = safeName(a.name);
        while (files.includes(join(attachDir, name))) name = `_${name}`;
        const p = join(attachDir, name);
        writeFileSync(p, Buffer.from(a.data, "base64"));
        files.push(p);
      } else if (a.text) texts.push({ name: a.name, text: a.text });
    }
    const configPath = join(this.dir, "mcp-config.json");
    writeFileSync(configPath, JSON.stringify(mcpConfig({ serverPath: o.serverPath, tsxLoader: o.tsxLoader, docPath: this.docPath, scope: ask.scope, outDir: join(this.dir, "out") }), null, 1));

    const args = claudeArgs({ mcpConfig: configPath, appendSystem: SYSTEM_APPEND, model: ask.model, resume: ask.resume, ...(files.length ? { attachDir } : {}) });
    const spec = spawnSpec(o.claude, args);
    this.emit({ type: "started", id });
    o.log?.(`ask ${id}: starting Claude Code in ${this.dir}${ask.resume ? " (follow-up)" : ""}`);

    this.watcher = new DocWatcher(this.docPath, { onChange: (text) => this.emit({ type: "doc", id, text }) }).start(ask.doc);
    let child: ChildProcess;
    try {
      child = spawn(spec.command, spec.args, { cwd: work, shell: spec.shell, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return this.finish({ type: "done", id, ok: false, text: `Could not start Claude Code: ${(e as Error).message}`, errorKind: "crash" });
    }
    this.child = child;
    const reader = new StreamReader();
    let result: Extract<StreamEvent, { kind: "result" }> | null = null;
    let stderr = "";
    let buf = "";
    let reply = "";
    const onEvent = (e: StreamEvent) => {
      switch (e.kind) {
        case "skip":
          o.log?.(`ask ${id}: skipped a line (${e.reason.slice(0, 120)})`);
          return;
        case "init":
          return this.emit({ type: "init", id, sessionId: e.sessionId, ...(e.model ? { model: e.model } : {}), tools: e.tools, ...(e.mcp ? { mcp: e.mcp } : {}) });
        case "text":
          reply += e.text;
          return this.emit({ type: "text", id, text: e.text });
        case "tool":
          reply = "";
          return this.emit({ type: "tool", id, callId: e.callId, name: e.name, args: e.args });
        case "toolResult":
          this.emit({ type: "toolResult", id, callId: e.callId, ok: e.ok, ...(e.error ? { error: e.error } : {}) });
          if (e.ok) this.watcher?.hint();
          return;
        case "notice":
          return this.emit({ type: "notice", id, text: e.text });
        case "result":
          result = e;
          return;
      }
    };
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      this.touch();
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        for (const e of reader.line(line)) onEvent(e);
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      this.touch();
      stderr = (stderr + chunk).slice(-4000);
    });
    child.stdin!.on("error", () => {}); // a process that exits before reading its prompt
    child.stdin!.end(promptText(ask, files, texts));

    const total = o.timeoutMs ?? 30 * 60_000;
    this.timers.push(setTimeout(() => this.stop("timeout"), total));
    this.touch();

    child.on("error", (e) => {
      const err = e as NodeJS.ErrnoException;
      this.finish({ type: "done", id, ok: false, text: err.code === "ENOENT" ? `Claude Code was not found. ${INSTALL_FIX}` : `Could not start Claude Code: ${err.message}`, errorKind: err.code === "ENOENT" ? "not-installed" : "crash" });
    });
    child.on("close", async (code, signal) => {
      if (buf.trim()) for (const e of reader.line(buf)) onEvent(e);
      // The last change may have landed just before the process ended.
      await this.watcher?.check(true);
      const r = result as Extract<StreamEvent, { kind: "result" }> | null;
      const doc = this.watcher?.text;
      const common = { id, ...(reader.sessionId ? { sessionId: reader.sessionId } : {}), ...(doc !== undefined ? { doc } : {}) };
      if (this.ended === "aborted") return this.finish({ type: "done", ...common, ok: false, text: "Stopped.", errorKind: "aborted" });
      if (this.ended === "timeout") return this.finish({ type: "done", ...common, ok: false, text: `Claude Code took too long (no answer in ${Math.round((this.idleHit ? (o.idleMs ?? 600_000) : total) / 60000)} minutes) and was stopped.`, errorKind: "timeout" });
      if (r) {
        const kind = r.ok ? undefined : r.errorKind;
        const text = !r.ok && kind === "login" ? `${r.text}\n${LOGIN_FIX}` : r.text || reply.trim();
        return this.finish({
          type: "done",
          ...common,
          ok: r.ok,
          text,
          ...(r.sessionId ? { sessionId: r.sessionId } : {}),
          ...(kind ? { errorKind: kind } : {}),
          ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
          ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
          ...(r.turns !== undefined ? { turns: r.turns } : {}),
          ...(r.usage ? { usage: r.usage } : {}),
        });
      }
      const said = stderr.trim().split(/\r?\n/).slice(-8).join("\n");
      const kind = errorKindOf(said);
      this.finish({
        type: "done",
        ...common,
        ok: false,
        text: `Claude Code ended without a result (${signal ? `signal ${signal}` : `exit code ${code}`}).${said ? `\n${said}` : ""}${kind === "login" ? `\n${LOGIN_FIX}` : ""}`,
        errorKind: kind === "error" ? "crash" : kind,
      });
    });
  }

  private idleHit = false;
  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.idleHit = true;
      this.stop("timeout");
    }, this.o.idleMs ?? 10 * 60_000);
  }

  /** Stops the run (the app's Cancel, a timeout, the app going away). */
  stop(why: "aborted" | "timeout" = "aborted") {
    if (this.finished || this.ended) return;
    this.ended = why;
    if (this.child) killTree(this.child);
    else this.finish({ type: "done", id: this.ask.id, ok: false, text: "Stopped.", errorKind: why });
  }

  private finish(m: Done) {
    if (this.finished) return;
    this.finished = true;
    this.watcher?.stop();
    for (const t of this.timers) clearTimeout(t);
    if (this.idle) clearTimeout(this.idle);
    this.o.log?.(`ask ${m.id}: ${m.ok ? "finished" : `ended (${m.errorKind ?? "error"})`}`);
    this.emit(m);
    this.resolveDone();
  }
}

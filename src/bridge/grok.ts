// xAI's Grok Build CLI on this computer (the `grok` command): finding it
// (PATH and its installer's ~/.grok/bin, also on Windows), whether it is
// signed in (`grok login` keeps ~/.grok/auth.json; XAI_API_KEY counts too),
// and the arguments of a headless run limited to Cocaide's tools. Its
// "streaming-messages-json" output is Claude Code's stream-json, so the same
// StreamReader reads it.
//
// Grok Build takes MCP servers from config files only (~/.grok/config.toml, a
// project's .mcp.json, ~/.claude.json), not from a flag: the bridge writes a
// .mcp.json naming Cocaide's server into the folder Grok runs in.

import { readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { runBrief, type ClaudeCommand } from "./claude";
import { GROK_MODEL_RE, MCP_SERVER_NAME, type ClaudeStatus } from "./protocol";

export const GROK_INSTALL_FIX =
  "Install xAI's Grok Build CLI (on Windows, in Git Bash or WSL): curl -fsSL https://x.ai/cli/install.sh | bash   then run `grok login` once in a terminal and sign in with your SuperGrok or X Premium+ account.";
export const GROK_LOGIN_FIX = "Run `grok login` in a terminal and sign in with your SuperGrok or X Premium+ account (or set XAI_API_KEY), then press Test again.";

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Where `grok` is: `override` (--grok, COCAIDE_GROK) as given, else PATH and ~/.grok/bin. A Windows .cmd/.bat runs through cmd.exe. */
export function findGrok(override?: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ClaudeCommand | null {
  if (override) {
    // A .js file (the tests' stand-in) runs with this Node.
    if (/\.(c|m)?js$/i.test(override)) return { command: process.execPath, prefix: [override] };
    return { command: override, prefix: [], ...(/\.(cmd|bat)$/i.test(override) ? { shell: true } : {}) };
  }
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean);
  const home = env.USERPROFILE ?? env.HOME;
  if (home) dirs.push(join(home, ".grok", "bin"), join(home, ".local", "bin"));
  for (const dir of dirs) {
    if (platform === "win32") {
      const exe = join(dir, "grok.exe");
      if (isFile(exe)) return { command: exe, prefix: [] };
      for (const shim of ["grok.cmd", "grok.bat"]) if (isFile(join(dir, shim))) return { command: join(dir, shim), prefix: [], shell: true };
    } else if (isFile(join(dir, "grok"))) return { command: join(dir, "grok"), prefix: [] };
  }
  return null;
}

/** Signed in: `grok login`'s ~/.grok/auth.json holds something, or XAI_API_KEY is set. Null: could not tell. */
export function grokSignedIn(env: NodeJS.ProcessEnv = process.env): { signedIn: boolean; method?: string } {
  if (env.XAI_API_KEY?.trim()) return { signedIn: true, method: "XAI_API_KEY" };
  const home = env.USERPROFILE ?? env.HOME;
  if (!home) return { signedIn: false };
  try {
    const text = readFileSync(join(home, ".grok", "auth.json"), "utf8").trim();
    if (!text || text === "{}" || text === "null") return { signedIn: false };
    return { signedIn: true, method: "grok login" };
  } catch {
    return { signedIn: false };
  }
}

/** Whether Grok Build is installed and signed in, with the fix when it is not. */
export async function grokStatus(c: ClaudeCommand | null, env: NodeJS.ProcessEnv = process.env): Promise<ClaudeStatus> {
  if (!c) return { installed: false, loggedIn: null, problem: `Grok Build (the grok command) was not found. ${GROK_INSTALL_FIX}` };
  const v = await runBrief(c, ["--version"]);
  if (v.code !== 0) return { installed: false, loggedIn: null, problem: `grok --version failed: ${(v.err || v.out).trim().slice(0, 300) || `exit ${v.code}`}. ${GROK_INSTALL_FIX}` };
  // "Grok Build 1.0.70" -> "1.0.70" (shown after the name anyway).
  const version = (v.out.trim() || v.err.trim()).split(/\r?\n/)[0].replace(/^grok(\s+build)?\s*/i, "").slice(0, 80);
  const auth = grokSignedIn(env);
  return { installed: true, version, loggedIn: auth.signedIn, ...(auth.method ? { authMethod: auth.method } : {}), ...(auth.signedIn ? {} : { problem: `Grok Build is not signed in. ${GROK_LOGIN_FIX}` }) };
}

/** Grok Build's own tools a bridge run never gets (it may run Cocaide's alone; reading an attachment is allowed when there is one). */
export const GROK_DENIED_TOOLS = [
  "run_terminal_command",
  "run_terminal_cmd",
  "search_replace",
  "write_file",
  "edit_file",
  "delete_file",
  "spawn_subagent",
  "web_search",
  "web_fetch",
  "Bash",
  "Edit",
  "Write",
  "MultiEdit",
  "WebFetch",
  "WebSearch",
  "Task",
];

export interface GrokRunOptions {
  /** The appended instructions (Grok Build's --rules). */
  rules: string;
  /** The prompt (Grok Build takes it as -p's argument). */
  prompt: string;
  model?: string;
  /** A Grok Build session to continue (its UUID). */
  resume?: string;
  /** There are attachments to read (its read_file tool is allowed). */
  attachments?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The arguments of one headless run: Claude Code's stream format, no
 * questions asked (a headless run can't answer them) but nothing allowed
 * beyond Cocaide's tools, the bridge's instructions as rules, then the prompt.
 */
export function grokArgs(o: GrokRunOptions): string[] {
  const allow = [`mcp__${MCP_SERVER_NAME}`, `mcp__${MCP_SERVER_NAME}__*`, ...(o.attachments ? ["read_file", "Read"] : [])];
  return [
    "--output-format",
    "streaming-messages-json",
    "--include-partial-messages",
    "--permission-mode",
    "dontAsk",
    ...(o.model && o.model !== "default" && GROK_MODEL_RE.test(o.model) ? ["-m", o.model] : []),
    "--rules",
    o.rules,
    ...allow.flatMap((r) => ["--allow", r]),
    ...GROK_DENIED_TOOLS.flatMap((r) => ["--deny", r]),
    ...(o.resume && UUID.test(o.resume) ? ["-r", o.resume] : []),
    "-p",
    o.prompt,
  ];
}

/** The .mcp.json Grok Build reads in the folder it runs in: Cocaide's server, as for Claude Code. */
export function grokMcpJson(config: { mcpServers: Record<string, unknown> }): string {
  return JSON.stringify(config, null, 1);
}

/** What to tell the user when Grok Build started without Cocaide's tools (it didn't read the folder's .mcp.json). */
export function grokNoToolsNote(workDir: string): string {
  return `Grok Build started without Cocaide's tools, so it can't change the part. It reads them from the .mcp.json in ${workDir}: open a terminal there, run \`grok\` once and trust the folder (or run \`grok mcp doctor\` to see why it isn't loaded), then ask again.`;
}

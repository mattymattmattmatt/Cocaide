// npm run bridge: lets the app's AI panel drive Claude Code on this computer
// (your own Claude subscription login) with Cocaide's MCP tools, live.
//
//   npm run bridge -- [--port 8787] [--data-dir ~/.cocaide-bridge] [--claude <path>] [--new-token]
//                     [--timeout-minutes 30]

import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { claudeStatus, findClaude } from "./claude";
import { BRIDGE_VERSION, DEFAULT_PORT, HOSTED_ORIGIN } from "./protocol";
import { defaultDataDir, startBridge } from "./server";

const here = dirname(fileURLToPath(import.meta.url));

/** The MCP server's file and the tsx loader as a file: URL (an absolute Windows path is not a valid --import specifier). */
export function serverFiles() {
  const require = createRequire(import.meta.url);
  return { serverPath: join(here, "..", "mcp", "server.ts"), tsxLoader: pathToFileURL(require.resolve("tsx")).href };
}

function parse(argv: string[]) {
  const o: { port: number; dataDir: string; claude?: string; newToken: boolean; timeoutMinutes?: number } = {
    port: Number(process.env.COCAIDE_BRIDGE_PORT) || DEFAULT_PORT,
    dataDir: process.env.COCAIDE_BRIDGE_DIR || defaultDataDir(),
    claude: process.env.COCAIDE_CLAUDE || undefined,
    newToken: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${a} needs a value`);
      return x;
    };
    if (a === "--port") o.port = Number(v());
    else if (a === "--data-dir") o.dataDir = resolve(v());
    else if (a === "--claude") o.claude = v();
    else if (a === "--new-token") o.newToken = true;
    else if (a === "--timeout-minutes") o.timeoutMinutes = Number(v());
    else if (a === "--help" || a === "-h") {
      console.log("npm run bridge -- [--port 8787] [--data-dir <folder>] [--claude <path to claude>] [--new-token] [--timeout-minutes 30]");
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error("--port takes a port number");
  return o;
}

async function main() {
  const o = parse(process.argv.slice(2));
  const status = await claudeStatus(findClaude(o.claude));
  const bridge = await startBridge({
    port: o.port,
    dataDir: o.dataDir,
    newToken: o.newToken,
    claudePath: o.claude,
    ...serverFiles(),
    ...(o.timeoutMinutes ? { timeoutMs: o.timeoutMinutes * 60_000 } : {}),
    log: (line) => console.log(`[${new Date().toLocaleTimeString()}] ${line}`),
  });
  const lines = [
    `Cocaide bridge ${BRIDGE_VERSION} on http://127.0.0.1:${bridge.port}`,
    `Answers ${HOSTED_ORIGIN} and http://localhost pages only.`,
    "",
    `Pairing token (paste it once into Settings → Assistant → Claude subscription):`,
    `    ${bridge.token}`,
    "",
    status.installed ? `Claude Code ${status.version ?? ""}: ${status.loggedIn === true ? "logged in" : status.loggedIn === false ? "NOT logged in" : "login unknown"}` : "Claude Code: NOT FOUND",
    ...(status.problem ? [status.problem] : []),
    `Session files: ${bridge.dataDir}`,
    "Leave this window open while you use it. Ctrl+C stops the bridge.",
  ];
  console.log(lines.join("\n"));
  const stop = () => void bridge.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  const err = e as NodeJS.ErrnoException;
  console.error(err.code === "EADDRINUSE" ? "cocaide bridge: the port is in use (another bridge running?). Start with --port <another> and set the same address in the app." : `cocaide bridge: ${err.message}`);
  process.exit(1);
});

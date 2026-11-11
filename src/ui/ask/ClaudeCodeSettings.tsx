// Settings → Assistant with "Your subscription (local bridge)" chosen: the
// bridge's address and pairing token, which assistants it found on this
// computer (Claude Code, xAI's Grok Build) and whether each is signed in (with
// the exact fix when not), which one to use (or whichever is ready), the
// model, the setup steps, and Live link (follow a part file that Claude Code
// in a terminal is editing).

import { useCallback, useEffect, useState } from "react";
import { BridgeClient, BridgeError } from "../../ask/bridge/client";
import { BRIDGE_MODELS, GROK_MODELS, pickEngine, type BridgeEngine, type BridgeModel, type ClaudeStatus } from "../../bridge/protocol";
import type { BridgeAskSettings } from "./settings";

interface Props {
  value: BridgeAskSettings;
  onChange(v: BridgeAskSettings): void;
  onFollow?(path: string, bridge: BridgeAskSettings): void;
}

type Status =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; bridge: string; claude: ClaudeStatus; grok: ClaudeStatus | null; note?: string | null }
  | { state: "problem"; message: string };

/** One line per thing that has to be right, and what to do about the first that isn't. */
function statusLines(s: Extract<Status, { state: "ok" }>): { ok: boolean; text: string }[] {
  const c = s.claude;
  const g = s.grok;
  const one = (name: string, x: ClaudeStatus) =>
    !x.installed
      ? `${name}: not installed`
      : `${name} ${x.version ?? ""}: ${x.loggedIn === true ? `signed in${x.authMethod ? ` (${x.authMethod})` : ""}` : x.loggedIn === false ? "not signed in" : "sign-in unknown (the first ask will tell)"}`;
  return [
    { ok: true, text: `Bridge ${s.bridge} answers and is paired` },
    { ok: c.installed && c.loggedIn !== false, text: one("Claude Code", c) },
    ...(g ? [{ ok: g.installed && g.loggedIn !== false, text: one("Grok Build", g) }] : []),
  ];
}

const ENGINE_CHOICES: { id: BridgeEngine; label: string }[] = [
  { id: "auto", label: "Whichever is installed and signed in" },
  { id: "claude", label: "Claude Code (Claude subscription)" },
  { id: "grok", label: "Grok Build (SuperGrok / X Premium+ subscription)" },
];

export function ClaudeCodeSettingsPanel({ value: b, onChange, onFollow }: Props) {
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [path, setPath] = useState(b.followPath);
  const set = (patch: Partial<BridgeAskSettings>) => onChange({ ...b, ...patch });

  const test = useCallback(async () => {
    setStatus({ state: "checking" });
    const c = new BridgeClient(b.url, b.token);
    try {
      const claude = await c.connect(10000);
      setStatus({ state: "ok", bridge: c.version, claude, grok: c.grok, note: c.versionNote });
    } catch (e) {
      setStatus({ state: "problem", message: e instanceof BridgeError ? e.message : (e as Error).message });
    } finally {
      c.close();
    }
  }, [b.url, b.token]);

  // Checked on opening when a token is there; Test checks again.
  useEffect(() => {
    if (b.token.trim()) void test();
    // Only on opening.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="bridge-settings" data-testid="bridge-settings">
      <p className="muted small">
        Uses your own subscription: Claude Code (Claude) or xAI's Grok Build (SuperGrok, X Premium+) runs on this computer, signed in as you, and works on
        the part with Cocaide's tools only. The bridge finds whichever you have. You watch it build in the 3D view; when it finishes you accept or discard
        the change. No API key.
      </p>
      <label className="field">
        <span className="field-label">Bridge address</span>
        <input value={b.url} onChange={(e) => set({ url: e.target.value })} placeholder="http://127.0.0.1:8787" data-testid="bridge-url" />
      </label>
      <label className="field">
        <span className="field-label">Pairing token</span>
        <input
          type="password"
          autoComplete="off"
          value={b.token}
          onChange={(e) => set({ token: e.target.value.trim() })}
          placeholder="Printed by npm run bridge"
          data-testid="bridge-token"
        />
      </label>
      <label className="field">
        <span className="field-label">Assistant</span>
        <select value={b.engine} onChange={(e) => set({ engine: e.target.value as BridgeEngine })} data-testid="bridge-engine">
          {ENGINE_CHOICES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      {b.engine !== "grok" && (
        <label className="field">
          <span className="field-label">{b.engine === "auto" ? "Claude model" : "Model"}</span>
          <select value={b.model} onChange={(e) => set({ model: e.target.value as BridgeModel })} data-testid="bridge-model">
            {BRIDGE_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {b.engine !== "claude" && (
        <label className="field">
          <span className="field-label">{b.engine === "auto" ? "Grok model" : "Model"}</span>
          <input list="grok-models" value={b.grokModel} onChange={(e) => set({ grokModel: e.target.value.trim() || "default" })} placeholder="default" data-testid="bridge-grok-model" />
          <datalist id="grok-models">
            {GROK_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </datalist>
        </label>
      )}
      <div className="row">
        <button type="button" onClick={() => void test()} disabled={status.state === "checking"} data-testid="bridge-test">
          {status.state === "checking" ? "Checking…" : "Test"}
        </button>
      </div>
      <div className="small" role="status" data-testid="bridge-status">
        {status.state === "problem" && <div className="bridge-status bad">{status.message}</div>}
        {status.state === "ok" && (
          <ul className="ask-changes">
            {statusLines(status).map((l) => (
              <li key={l.text} className={`bridge-status ${l.ok ? "ok" : "bad"}`}>
                {l.ok ? "✓" : "✗"} {l.text}
              </li>
            ))}
            {(() => {
              const use = pickEngine(b.engine, status.claude, status.grok ?? undefined);
              const st = use === "grok" ? status.grok : status.claude;
              const ready = !!st?.installed && st.loggedIn !== false;
              return (
                <>
                  {ready && (
                    <li className="bridge-status ok" data-testid="bridge-using">
                      → Asks will use {use === "grok" ? "Grok Build" : "Claude Code"}
                      {b.engine === "auto" && (use === "grok" ? " (found and signed in)" : status.grok?.installed ? " (Grok Build is there too: pick it above to use it)" : "")}
                    </li>
                  )}
                  {!ready && use === "grok" && !status.grok && <li className="bridge-status bad">This bridge is from before Grok support: close it and run start-cocaide.bat again.</li>}
                  {!ready && st?.problem && <li className="bridge-status bad">{st.problem}</li>}
                </>
              );
            })()}
            {status.note && <li className="bridge-status bad">{status.note}</li>}
          </ul>
        )}
      </div>
      <details className="bridge-help small" open={!b.token}>
        <summary>Set it up (once)</summary>
        <ol>
          <li>
            Install Claude Code: <code>npm install -g @anthropic-ai/claude-code</code>
          </li>
          <li>
            Run <code>claude</code> once in a terminal and log in with your Claude subscription, then quit it (<code>/exit</code>).
          </li>
          <li>
            In the Cocaide folder (a clone of the repository, after <code>npm install</code>), start the bridge and leave it open: <code>npm run bridge</code>
          </li>
          <li>Copy the pairing token it prints into the field above, then Test and Save.</li>
        </ol>
        <p className="muted">
          Windows, Git Bash: the same commands work. If you also add the cocaide MCP server to Claude Code yourself with <code>cmd /c</code>, start the line with{" "}
          <code>MSYS_NO_PATHCONV=1</code> so Git Bash leaves <code>/c</code> alone. The bridge itself needs no such care. If the browser asks whether this site
          may reach devices on your local network, allow it: the bridge runs on 127.0.0.1.
        </p>
        <p>
          <strong>Grok instead (or as well):</strong> install xAI's Grok Build CLI (Windows: in Git Bash or WSL) with{" "}
          <code>curl -fsSL https://x.ai/cli/install.sh | bash</code>, run <code>grok login</code> once and sign in with your SuperGrok or X Premium+ account,
          then start (or restart) the bridge: it finds <code>grok</code> by itself, and Test shows it here.
        </p>
        <p className="muted">Everything stays on this computer except what the assistant sends to Anthropic or xAI as it works, as when you use it in a terminal.</p>
      </details>
      <fieldset className="spin-steps">
        <legend>Live link: follow a part file</legend>
        <p className="muted small">
          Running <code>claude</code> in a terminal with the cocaide MCP server on a file? Follow that file here and the view shows each change as it is saved
          (read-only; your own part is kept).
        </p>
        <label className="field">
          <span className="field-label">File</span>
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="G:/CocaideParts/part.cocaide.json" data-testid="follow-path" />
        </label>
        <button type="button" disabled={!onFollow || !path.trim() || !b.token.trim()} onClick={() => onFollow?.(path.trim(), b)} data-testid="follow-start">
          Follow this file
        </button>
      </fieldset>
    </div>
  );
}

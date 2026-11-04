// Settings → Assistant with Ollama chosen: where the server is and whether it
// answers (with the exact fix when it doesn't), the installed models, pulling
// one, a test chat, and the model's options. The model runs on this computer;
// nothing is sent anywhere else.

import { useCallback, useEffect, useRef, useState } from "react";
import { OllamaClient, fixFor, type OllamaProblemKind } from "../../ask/ollama/client";
import { CONTEXT_CHOICES, CONTEXT_HELP, RECOMMENDED_MODELS, THINK_HELP } from "../../ask/ollama/guide";
import type { OllamaModelEntry, OllamaPullProgress } from "../../ask/ollama/wire";
import type { OllamaSettings, ThinkSetting } from "./settings";

interface Props {
  value: OllamaSettings;
  onChange(v: OllamaSettings): void;
}

type Status = { state: "checking" } | { state: "ok"; version?: string } | { state: "problem"; kind: OllamaProblemKind; message: string };

interface Caps {
  tools: boolean;
  vision: boolean;
  thinking: boolean;
  contextLength?: number;
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

export function OllamaSettingsPanel({ value: o, onChange }: Props) {
  const [status, setStatus] = useState<Status>({ state: "checking" });
  const [models, setModels] = useState<OllamaModelEntry[]>([]);
  const [caps, setCaps] = useState<Caps | null>(null);
  const [pullName, setPullName] = useState(RECOMMENDED_MODELS[0].tag);
  const [pull, setPull] = useState<{ status: string; completed?: number; total?: number; error?: string; done?: boolean } | null>(null);
  const [test, setTest] = useState<string | null>(null);
  const pullAbort = useRef<AbortController | null>(null);
  const client = useCallback(() => new OllamaClient(o.baseUrl, { origin: location.origin }), [o.baseUrl]);

  const refresh = useCallback(async () => {
    setStatus({ state: "checking" });
    const c = client();
    const conn = await c.connect();
    if (!conn.ok) {
      setStatus({ state: "problem", kind: conn.problem ?? "unreachable", message: conn.message ?? "" });
      setModels([]);
      return;
    }
    setStatus({ state: "ok", version: conn.version });
    try {
      setModels((await c.tags()).models);
    } catch (e) {
      setStatus({ state: "problem", kind: "http", message: (e as Error).message });
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    // Only on opening and on a new address (refresh changes with it).
  }, [refresh]);

  // What the chosen model can do.
  useEffect(() => {
    setCaps(null);
    if (status.state !== "ok" || !o.model) return;
    let live = true;
    void (async () => {
      try {
        const { modelInfo } = await import("../../ask/ollama/model");
        const info = modelInfo(await client().show(o.model));
        if (live) setCaps(info);
      } catch {
        if (live) setCaps(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [o.model, status.state, client]);

  const set = (patch: Partial<OllamaSettings>) => onChange({ ...o, ...patch });

  const startPull = async () => {
    const name = pullName.trim();
    if (!name) return;
    pullAbort.current?.abort();
    const ctl = new AbortController();
    pullAbort.current = ctl;
    setPull({ status: "starting" });
    try {
      await client().pull(name, (p: OllamaPullProgress) => setPull({ status: p.status, completed: p.completed, total: p.total }), ctl.signal);
      setPull({ status: "success", done: true });
      await refresh();
      set({ model: name });
    } catch (e) {
      setPull({ status: "failed", error: ctl.signal.aborted ? "cancelled" : (e as Error).message });
    }
  };

  const runTest = async () => {
    if (!o.model) return;
    setTest("Asking the model…");
    const t0 = performance.now();
    try {
      const r = await client().chat({
        model: o.model,
        messages: [{ role: "user", content: "Reply with the single word OK." }],
        options: { num_ctx: Math.min(o.numCtx, 4096), num_predict: 16, temperature: 0 },
        ...(caps?.thinking ? { think: false } : {}),
        keep_alive: o.keepAlive || undefined,
      });
      const s = ((performance.now() - t0) / 1000).toFixed(1);
      setTest(`The model answered "${r.content.trim().slice(0, 40)}" in ${s} s (the first answer includes loading the model).`);
    } catch (e) {
      setTest(`Test failed: ${(e as Error).message}`);
    }
  };

  const fix = status.state === "problem" ? fixFor(status.kind, { baseUrl: o.baseUrl, origin: location.origin, model: o.model }) : null;
  const known = models.some((m) => m.name === o.model);

  return (
    <div className="ollama-settings" data-testid="ask-ollama">
      <p className="muted small" data-testid="ask-ollama-local">
        Runs locally: the model runs in Ollama on this computer and nothing is sent anywhere else. No API key is needed. Every change is still a proposal you
        accept or discard.
      </p>
      <label className="field">
        <span className="field-label">Ollama address</span>
        <span className="row">
          <input value={o.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} spellCheck={false} data-testid="ask-ollama-url" />
          <button type="button" onClick={() => void refresh()} data-testid="ask-ollama-refresh">
            Refresh
          </button>
        </span>
      </label>
      <div className={`ollama-status ${status.state}`} role="status" data-testid="ask-ollama-status">
        {status.state === "checking" && "Checking the connection…"}
        {status.state === "ok" &&
          `Connected to Ollama${status.version ? ` ${status.version}` : ""}: ${models.length} model${models.length === 1 ? "" : "s"} installed.`}
        {status.state === "problem" && (
          <>
            <strong>Not connected.</strong> {fix?.text}
          </>
        )}
      </div>
      {fix?.command && (
        <div className="ollama-fix" data-testid="ask-ollama-fix">
          <code>{fix.command}</code>
          <button type="button" onClick={() => void navigator.clipboard?.writeText(fix.command!)} title="Copy the command">
            Copy
          </button>
        </div>
      )}

      <label className="field">
        <span className="field-label">Model</span>
        <select value={o.model} onChange={(e) => set({ model: e.target.value })} data-testid="ask-ollama-model">
          <option value="">{models.length ? "Choose an installed model…" : "No models listed"}</option>
          {o.model && !known && <option value={o.model}>{o.model} (not listed)</option>}
          {models.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name} · {gb(m.size)}
              {m.details?.parameter_size ? ` · ${m.details.parameter_size}` : ""}
              {m.details?.quantization_level ? ` · ${m.details.quantization_level}` : ""}
            </option>
          ))}
        </select>
      </label>
      {o.model && (
        <p className="small" data-testid="ask-ollama-selected">
          Using <strong>{o.model}</strong>, locally.
          {caps && (
            <>
              {" "}
              {caps.tools ? "Tools ✓" : "No tool support: choose another model."}{" "}
              {caps.vision ? "· Vision ✓ (drawings, photos, screenshots)" : "· No vision: drawings and photos need a vision model."}
              {caps.thinking ? " · Thinking ✓" : ""}
              {caps.contextLength ? ` · up to ${Math.round(caps.contextLength / 1024)}k context` : ""}
            </>
          )}
        </p>
      )}

      <div className="field">
        <span className="field-label">Pull a model</span>
        <span className="row">
          <input
            value={pullName}
            onChange={(e) => setPullName(e.target.value)}
            spellCheck={false}
            placeholder="qwen3.5:9b"
            data-testid="ask-ollama-pull-name"
          />
          {pull && !pull.done && !pull.error ? (
            <button type="button" onClick={() => pullAbort.current?.abort()}>
              Cancel
            </button>
          ) : (
            <button type="button" onClick={() => void startPull()} disabled={status.state !== "ok"} data-testid="ask-ollama-pull">
              Pull
            </button>
          )}
        </span>
      </div>
      {pull && (
        <div className="small" data-testid="ask-ollama-pull-progress">
          {pull.error ? `Pull failed: ${pull.error}` : pull.status}
          {pull.total ? (
            <>
              {" "}
              <progress max={pull.total} value={pull.completed ?? 0} /> {gb(pull.completed ?? 0)} of {gb(pull.total)}
            </>
          ) : null}
        </div>
      )}

      <div className="row">
        <button type="button" onClick={() => void runTest()} disabled={!o.model || status.state !== "ok"} data-testid="ask-ollama-test">
          Test connection
        </button>
        {test && (
          <span className="small" data-testid="ask-ollama-test-result">
            {test}
          </span>
        )}
      </div>

      <label className="field">
        <span className="field-label">Context length</span>
        <select value={o.numCtx} onChange={(e) => set({ numCtx: Number(e.target.value) })} data-testid="ask-ollama-ctx">
          {[...CONTEXT_CHOICES, ...(CONTEXT_CHOICES.some((c) => c.value === o.numCtx) ? [] : [{ value: o.numCtx, label: `${o.numCtx}` }])].map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">{CONTEXT_HELP}</p>
      <label className="field">
        <span className="field-label">Thinking</span>
        <select
          value={o.think}
          onChange={(e) => set({ think: e.target.value as ThinkSetting })}
          disabled={caps ? !caps.thinking : false}
          data-testid="ask-ollama-think"
        >
          <option value="off">Off (fastest)</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="on">On</option>
        </select>
      </label>
      <p className="muted small">{caps && !caps.thinking ? "This model has no thinking mode." : THINK_HELP}</p>
      <label className="field">
        <span className="field-label">Keep loaded</span>
        <input
          value={o.keepAlive}
          onChange={(e) => set({ keepAlive: e.target.value })}
          placeholder="10m"
          title='How long Ollama keeps the model in memory after an ask: "10m", "1h", "-1" (always)'
          data-testid="ask-ollama-keepalive"
        />
      </label>
      <label className="field">
        <span className="field-label">Temperature</span>
        <input
          type="number"
          min={0}
          max={2}
          step={0.1}
          value={o.temperature}
          onChange={(e) => set({ temperature: Number(e.target.value) })}
          data-testid="ask-ollama-temperature"
        />
      </label>

      <details className="small" data-testid="ask-ollama-help">
        <summary>Which model, and setting up Ollama</summary>
        <ul>
          {RECOMMENDED_MODELS.map((m) => (
            <li key={m.tag}>
              <code>{m.tag}</code>, {m.size}: {m.note}
            </li>
          ))}
        </ul>
        <p>
          Install Ollama from ollama.com/download, then pull a model here or with <code>ollama pull qwen3.5:9b</code>. To use it from the hosted site, Ollama
          must allow the site's origin: on Windows run <code>setx OLLAMA_ORIGINS "https://mattymattmattmatt.github.io,http://localhost:*"</code> and restart
          Ollama from its tray icon. A local copy (<code>npm run dev</code> or <code>npm run preview</code>) on localhost is allowed by default.{" "}
          <code>ollama ps</code> shows whether the model runs on the GPU.
        </p>
      </details>
    </div>
  );
}

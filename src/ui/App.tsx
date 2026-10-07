import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import bracketText from "../../examples/bracket.cocaide.json?raw";
import plateText from "../../examples/mounting-plate.cocaide.json?raw";
import { FILE_EXTENSION, formatDocument, parseDocumentText } from "../doc/format";
import { KernelClient } from "../worker/client";
import type { RebuildView } from "../worker/protocol";
import { DocumentEditor, type EditorHandle } from "./DocumentEditor";
import { FeaturePanel } from "./FeaturePanel";
import { MeasurementsPanel } from "./MeasurementsPanel";
import { Viewport } from "./Viewport";

const EXAMPLES: Record<string, string> = { bracket: bracketText, "mounting plate": plateText };
const STORAGE_KEY = "cocaide.document.v1";
const REBUILD_DELAY_MS = 350;

type KernelState = { phase: "loading" } | { phase: "ready"; loadMs: number } | { phase: "failed"; message: string };

function readStored(): { text: string; savedText: string } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileBase(name: string): string {
  return name.replace(/[^\w.-]+/g, "_") || "part";
}

export function App() {
  const kernel = useMemo(() => new KernelClient(), []);
  const [kernelState, setKernelState] = useState<KernelState>({ phase: "loading" });
  const stored = useMemo(readStored, []);
  const [text, setText] = useState(stored?.text ?? bracketText);
  const [savedText, setSavedText] = useState(stored?.savedText ?? bracketText);
  const [view, setView] = useState<RebuildView | null>(null);
  const [rebuildMs, setRebuildMs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [fitToken, setFitToken] = useState(0);
  const [dragging, setDragging] = useState(false);
  const editor = useRef<EditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const latest = useRef(0);
  const needsFit = useRef(true);

  const parsed = useMemo(() => parseDocumentText(text), [text]);

  useEffect(() => {
    kernel.ready.then(
      (loadMs) => setKernelState({ phase: "ready", loadMs }),
      (e: Error) => setKernelState({ phase: "failed", message: e.message }),
    );
    return () => kernel.dispose();
  }, [kernel]);

  // Rebuild whenever the document text parses; the newest request wins.
  useEffect(() => {
    if (!parsed.ok) return;
    const ticket = ++latest.current;
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        const { view: v, ms } = await kernel.rebuild(parsed.value);
        if (ticket !== latest.current) return;
        setView(v);
        setRebuildMs(ms);
        if (needsFit.current && v.mesh) {
          needsFit.current = false;
          setFitToken((t) => t + 1);
        }
      } catch (e) {
        if (ticket === latest.current) setNotice({ kind: "error", text: `Rebuild crashed: ${(e as Error).message}` });
      } finally {
        if (ticket === latest.current) setBusy(false);
      }
    }, REBUILD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [parsed, kernel]);

  // Keep the working document across reloads.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ text, savedText }));
    } catch {
      // storage full or disabled: not fatal
    }
  }, [text, savedText]);

  const loadText = useCallback((next: string, origin: string) => {
    const p = parseDocumentText(next);
    if (!p.ok) {
      setNotice({ kind: "error", text: `${origin}: ${p.error}` });
      return;
    }
    needsFit.current = true;
    setText(next);
    setSavedText(next);
    setNotice({ kind: "info", text: `Opened ${origin}` });
  }, []);

  const openFile = useCallback(
    async (file: File) => loadText(await file.text(), file.name),
    [loadText],
  );

  const save = () => {
    if (!parsed.ok) {
      setNotice({ kind: "error", text: `Not saved: ${parsed.error}` });
      return;
    }
    const formatted = formatDocument(parsed.value);
    const name = view?.name ?? "part";
    download(`${fileBase(name)}${FILE_EXTENSION}`, formatted, "application/json");
    setText(formatted);
    setSavedText(formatted);
    setNotice({ kind: "info", text: `Saved ${fileBase(name)}${FILE_EXTENSION}` });
  };

  const exportStep = async () => {
    if (!parsed.ok) {
      setNotice({ kind: "error", text: `Not exported: ${parsed.error}` });
      return;
    }
    const r = await kernel.exportStep(parsed.value);
    if (!r.ok) {
      const n = r.errors.length;
      setNotice({ kind: "error", text: `STEP not exported: ${n} rebuild error${n === 1 ? "" : "s"}. ${r.errors[0]}` });
      return;
    }
    download(`${fileBase(r.name)}.step`, r.text, "model/step");
    setNotice({ kind: "info", text: `Exported ${fileBase(r.name)}.step` });
  };

  const dirty = text !== savedText;
  const status =
    kernelState.phase === "loading"
      ? "Loading OpenCascade…"
      : kernelState.phase === "failed"
        ? kernelState.message
        : busy
          ? "Rebuilding…"
          : !parsed.ok
            ? "JSON has a syntax error"
            : view
              ? `${view.ok ? "Rebuilt" : `${view.errors.length} error${view.errors.length === 1 ? "" : "s"}`}${rebuildMs !== null ? ` · ${Math.round(rebuildMs)} ms` : ""}`
              : "Waiting for kernel…";

  return (
    <div
      className={`app${dragging ? " dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) openFile(file);
      }}
    >
      <header className="topbar">
        <div className="brand">
          <img src="/cocaide-mark-256.png" alt="" width={28} height={28} />
          <span className="wordmark">Cocaide</span>
        </div>
        <div className="doc-title" title={dirty ? "Unsaved changes" : undefined}>
          {view?.name ?? (parsed.ok ? "untitled" : "—")}
          {FILE_EXTENSION}
          {dirty && <span className="dirty">•</span>}
        </div>
        <nav className="actions">
          <select
            aria-label="Open an example"
            value=""
            onChange={(e) => {
              if (e.target.value) loadText(EXAMPLES[e.target.value], `example "${e.target.value}"`);
            }}
          >
            <option value="">Examples…</option>
            {Object.keys(EXAMPLES).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <button onClick={() => fileInput.current?.click()}>Open</button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) openFile(file);
              e.target.value = "";
            }}
          />
          <button onClick={save}>Save</button>
          <button className="primary" onClick={exportStep} disabled={kernelState.phase !== "ready"}>
            Export STEP
          </button>
        </nav>
        <div
          className={`status ${view && !view.ok ? "bad" : ""} ${kernelState.phase === "failed" ? "bad" : ""}`}
          data-testid="status"
        >
          {status}
        </div>
      </header>

      {notice && (
        <div className={`notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
          <span>{notice.text}</span>
          <button aria-label="Dismiss" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}

      <main className="workspace">
        <aside className="side left">
          <FeaturePanel view={view} onSelect={(id) => editor.current?.reveal(id)} />
          <MeasurementsPanel measurements={view?.measurements ?? null} />
        </aside>
        <section className="center">
          <Viewport view={view} fitToken={fitToken} />
        </section>
        <aside className="side right">
          <DocumentEditor ref={editor} text={text} onChange={setText} parseError={parsed.ok ? null : parsed.error} />
        </aside>
      </main>
    </div>
  );
}

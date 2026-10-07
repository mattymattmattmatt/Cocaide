import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import bracketText from "../../examples/bracket.cocaide.json?raw";
import flangeText from "../../examples/flange.cocaide.json?raw";
import plateText from "../../examples/mounting-plate.cocaide.json?raw";
import { targetLabel, type AskTarget, type PacketKind } from "../ask/packet";
import { nextId, type Command, type RawDocument } from "../doc/commands";
import { FILE_EXTENSION, formatDocument, parseDocumentText } from "../doc/format";
import { documentParameters, resolvedDocument, restoreExpressions } from "../doc/parameters";
import { exportRefusal, mmPerPixel, photoOf } from "../doc/photo";
import type { DatumPlane, SketchEntity, SketchFeature, Vec2, Vec3 } from "../doc/types";
import { facePlaneFrame, planeFrame, to2D } from "../geom/frame";
import { dot3 } from "../geom/vec";
import { edgesSelectorFor, faceSelectorFor } from "../kernel/synthesize";
import { KernelClient } from "../worker/client";
import type { RebuildView } from "../worker/protocol";
import { AskPopover } from "./ask/AskPopover";
import { AskSettingsDialog } from "./ask/AskSettingsDialog";
import { useAsk } from "./ask/useAsk";
import type { Drawing, Photo } from "../ask/part";
import { loadPhoto, savePhoto } from "../photo/store";
import { DocumentEditor, type EditorHandle } from "./DocumentEditor";
import { FeatureTree } from "./FeatureTree";
import { ParametersContext, TextInput } from "./fields";
import { MeasurementsPanel } from "./MeasurementsPanel";
import { ParametersPanel } from "./ParametersPanel";
import { PhotoBar } from "./PhotoBar";
import { PropertyPanel } from "./PropertyPanel";
import { SketchMode, type SketchSession } from "./sketcher/SketchMode";
import { useDocument } from "./useDocument";
import { EMPTY_SELECTION, Viewport, type PickTarget, type Selection, type Underlay } from "./Viewport";

const EXAMPLES: Record<string, string> = { bracket: bracketText, "mounting plate": plateText, flange: flangeText };
const STORAGE_KEY = "cocaide.document.v1";
const REBUILD_DELAY_MS = 250;
const BLANK = formatDocument({ version: 1, units: "mm", name: "part", features: [] });

const PLANES: [string, DatumPlane][] = [
  ["Top (XY)", { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }],
  ["Front (XZ)", { type: "datum", normal: [0, -1, 0], origin: [0, 0, 0] }],
  ["Right (YZ)", { type: "datum", normal: [1, 0, 0], origin: [0, 0, 0] }],
];

type KernelState = { phase: "loading" } | { phase: "ready"; loadMs: number } | { phase: "failed"; message: string };
type Notice = { kind: "info" | "error"; text: string };

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

const round3 = (x: number) => Math.round(x * 1000) / 1000 + 0;
/** Files that open the part-level ask as a drawing rather than as a document. */
const DRAWING_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"];

export function App() {
  const kernel = useMemo(() => new KernelClient(), []);
  const [kernelState, setKernelState] = useState<KernelState>({ phase: "loading" });
  const stored = useMemo(readStored, []);
  const d = useDocument({ text: stored?.text ?? bracketText, savedText: stored?.savedText ?? bracketText });
  const [view, setView] = useState<RebuildView | null>(null);
  const [rebuildMs, setRebuildMs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [fitToken, setFitToken] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [selectedFeature, setSelectedFeature] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<"properties" | "document">("properties");
  const [sketch, setSketch] = useState<SketchSession | null>(null);
  const [planeMenu, setPlaneMenu] = useState(false);
  const editor = useRef<EditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const latest = useRef(0);
  const needsFit = useRef(true);

  const { parsed, doc } = d;
  const params = useMemo(() => documentParameters(doc), [doc]);
  const ask = useAsk({ kernel: kernel.port, doc, replaceDoc: d.replaceDoc });
  /** In the sketcher: replaces the draft with an accepted ask's sketch. */
  const sketchApply = useRef<((f: SketchFeature) => void) | null>(null);
  /** What the viewport shows: the document, or an open proposal while it is previewed. */
  const shown = useMemo(() => ask.previewDoc ?? (parsed.ok ? parsed.value : null), [ask.previewDoc, parsed]);

  // The photo pinned under the part (the document's, or an open proposal's): its pixels live in this browser.
  const shownPhoto = photoOf(shown);
  const photos = useRef(new Map<string, Photo>());
  const [photoImage, setPhotoImage] = useState<{ sha256: string; photo: Photo | null } | null>(null);
  const [photoOpacity, setPhotoOpacity] = useState(0.7);
  const [photoPick, setPhotoPick] = useState<{ from?: Vec2 } | null>(null);
  const photoSha = shownPhoto?.sha256 ?? null;
  useEffect(() => {
    if (!photoSha) return;
    let live = true;
    const cached = photos.current.get(photoSha);
    if (cached) setPhotoImage({ sha256: photoSha, photo: cached });
    else void loadPhoto(photoSha).then((p) => live && setPhotoImage({ sha256: photoSha, photo: p }));
    return () => {
      live = false;
    };
  }, [photoSha]);
  const photoShown = photoImage && photoImage.sha256 === photoSha ? photoImage.photo : null;
  const underlay = useMemo<Underlay | null>(() => {
    if (!shownPhoto || !photoShown) return null;
    const { scale } = shownPhoto;
    return {
      url: `data:${photoShown.mediaType};base64,${photoShown.data}`,
      width: shownPhoto.width,
      height: shownPhoto.height,
      origin: shownPhoto.origin,
      mmPerPx: mmPerPixel(scale),
      scale: { from: scale.from, to: scale.to, confirmed: scale.confirmed },
      opacity: photoOpacity,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(shownPhoto), photoShown, photoOpacity]);
  /** Picking the scale's two points on the photo. */
  const onPhotoPoint = useCallback(
    (px: Vec2) => {
      const at: Vec2 = [Math.round(px[0] * 10) / 10, Math.round(px[1] * 10) / 10];
      if (!photoPick?.from) return setPhotoPick({ from: at });
      setPhotoPick(null);
      const problem = d.dispatch({ type: "setPhotoScale", from: photoPick.from, to: at });
      if (problem) setNotice({ kind: "error", text: problem });
    },
    [photoPick, d],
  );
  useEffect(() => {
    if (!photoPick) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPhotoPick(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [photoPick]);
  /** Keep a dropped photo for the underlay: this session, and this browser. */
  const keepPhoto = (p: Photo) => {
    photos.current.set(p.sha256, p);
    void savePhoto(p);
  };

  useEffect(() => {
    kernel.ready.then(
      (loadMs) => setKernelState({ phase: "ready", loadMs }),
      (e: Error) => setKernelState({ phase: "failed", message: e.message }),
    );
    return () => kernel.dispose();
  }, [kernel]);

  // Rebuild whenever the document text parses; the newest request wins.
  useEffect(() => {
    if (shown === null) return;
    const ticket = ++latest.current;
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        const { view: v, ms } = await kernel.rebuild(shown);
        if (ticket !== latest.current) return;
        setView(v);
        setRebuildMs(ms);
        setSelection(EMPTY_SELECTION); // face and edge indices belong to the previous solid
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
  }, [shown, kernel]);

  // Keep the working document across reloads.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ text: d.text, savedText: d.savedText }));
    } catch {
      // storage full or disabled: not fatal
    }
  }, [d.text, d.savedText]);

  // A selected feature that no longer exists (undo, delete) is deselected.
  useEffect(() => {
    if (selectedFeature && !doc?.features.some((f) => f.id === selectedFeature)) setSelectedFeature(null);
  }, [doc, selectedFeature]);

  const run = useCallback(
    (cmd: Command): string | null => {
      const problem = d.dispatch(cmd);
      if (problem) setNotice({ kind: "error", text: problem });
      return problem;
    },
    [d],
  );

  /** Adds a feature, selects it and shows its properties. */
  const create = (feature: Record<string, unknown>) => {
    if (run({ type: "addFeature", feature }) === null) {
      setSelectedFeature(String(feature.id));
      setRightTab("properties");
      setSelection(EMPTY_SELECTION);
      setNotice(null);
    }
  };

  /** Loads a whole document (new, example, file). Starts a fresh undo history. */
  const replaceDocument = (text: string, origin: string) => {
    const p = parseDocumentText(text);
    if (!p.ok) {
      setNotice({ kind: "error", text: `${origin}: ${p.error}` });
      return;
    }
    needsFit.current = true;
    d.load(text);
    setSelectedFeature(null);
    setSketch(null);
    setNotice({ kind: "info", text: origin });
  };

  const openFile = useCallback(
    async (file: File) => replaceDocument(await file.text(), `Opened ${file.name}`),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const save = () => {
    if (!parsed.ok) {
      setNotice({ kind: "error", text: `Not saved: ${parsed.error}` });
      return;
    }
    const formatted = formatDocument(parsed.value);
    const name = view?.name ?? "part";
    download(`${fileBase(name)}${FILE_EXTENSION}`, formatted, "application/json");
    d.markSaved(formatted);
    setNotice({ kind: "info", text: `Saved ${fileBase(name)}${FILE_EXTENSION}` });
  };

  const exportStep = async () => {
    if (!parsed.ok) {
      setNotice({ kind: "error", text: `Not exported: ${parsed.error}` });
      return;
    }
    // A part estimated from a photo waits for its scale (spec 5.3). The worker checks this too.
    const refused = exportRefusal(parsed.value);
    if (refused) return setNotice({ kind: "error", text: refused });
    const r = await kernel.exportStep(parsed.value);
    if (!r.ok) {
      const n = r.errors.length;
      setNotice({ kind: "error", text: `STEP not exported: ${n} rebuild error${n === 1 ? "" : "s"}. ${r.errors[0]}` });
      return;
    }
    download(`${fileBase(r.name)}.step`, r.text, "model/step");
    setNotice({
      kind: "info",
      text: `Exported ${fileBase(r.name)}.step${photoOf(parsed.value) ? ". It was estimated from a photo: check every size against the part before making it." : ""}`,
    });
  };

  // ------------------------------------------------------------ tools

  const features = (doc?.features ?? []) as Record<string, unknown>[];
  /** The features with expressions evaluated, for anything that computes with their numbers. */
  const resolved = useMemo(() => (doc ? (resolvedDocument(doc).features as Record<string, unknown>[]) : []), [doc]);
  const selected = resolved.find((f) => f.id === selectedFeature);

  const startSketch = (plane: DatumPlane) => {
    setPlaneMenu(false);
    if (!doc) return setNotice({ kind: "error", text: "Fix the document JSON first." });
    setSketch({ id: nextId(doc, "sketch"), isNew: true, plane, entities: [], constraints: [] });
    setSelection(EMPTY_SELECTION);
  };

  const sketchOnFace = () => {
    setPlaneMenu(false);
    const f = view?.faces[selection.faces[0]];
    if (selection.faces.length !== 1 || f?.type !== "plane" || !f.normal) {
      return setNotice({ kind: "error", text: "Click a flat face first, then Sketch → On selected face." });
    }
    const n = f.normal.map(round9) as Vec3;
    startSketch({ type: "datum", normal: n, origin: n.map((c) => round9(c * (f.offset ?? 0))) as Vec3 });
  };

  const editSketch = (id: string) => {
    // The sketcher works on numbers; finishSketch puts back the expressions it did not change.
    const f = resolved.find((g) => g.id === id) as Partial<SketchFeature> | undefined;
    if (!f || f.op !== "sketch" || !f.plane) return;
    setSketch({
      id,
      isNew: false,
      plane: f.plane,
      entities: (f.entities ?? []) as SketchEntity[],
      constraints: f.constraints ?? [],
      suppressed: f.suppressed,
    });
    setSelection(EMPTY_SELECTION);
  };

  const finishSketch = (feature: SketchFeature) => {
    if (!sketch) return;
    const original = features.find((g) => g.id === sketch.id);
    const problem = sketch.isNew
      ? run({ type: "addFeature", feature })
      : run({ type: "replaceFeature", id: sketch.id, feature: restoreExpressions(original, feature, params) as Record<string, unknown> });
    if (problem) return; // stay in the sketch; the notice says why
    setSketch(null);
    setSelectedFeature(feature.id);
    setRightTab("properties");
    setNotice(null);
  };

  const sketchFor = (): Record<string, unknown> | undefined =>
    selected?.op === "sketch" ? selected : [...resolved].reverse().find((f) => f.op === "sketch");

  const extrude = (op: "extrude" | "cut") => {
    const sk = sketchFor();
    if (!doc || !sk) return setNotice({ kind: "error", text: `Make a sketch first, then ${op === "cut" ? "Cut" : "Extrude"}.` });
    const plane = sk.plane as DatumPlane;
    const feature: Record<string, unknown> = { id: nextId(doc, op), op, sketch: sk.id, distance: op === "cut" ? 5 : 10 };
    if (op === "cut" && view?.measurements?.boundingBox) {
      // Cut toward the material: if nothing of the part lies in front of the sketch plane, cut backwards.
      const { min, max } = view.measurements.boundingBox;
      const n = planeFrame(plane.normal, plane.origin).z;
      let far = -Infinity;
      for (let i = 0; i < 8; i++) {
        const c: Vec3 = [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
        far = Math.max(far, dot3(n, c) - dot3(n, plane.origin));
      }
      if (far <= 1e-6) feature.direction = n.map((c) => -c);
    }
    create(feature);
  };

  const hole = () => {
    const f = view?.faces[selection.faces[0]];
    if (!doc || selection.faces.length !== 1 || !f || !selection.point) {
      return setNotice({ kind: "error", text: "Click a flat face where the hole goes, then Hole." });
    }
    const s = faceSelectorFor(view!.faces, selection.faces[0]);
    if (!s.ok || f.type !== "plane") return setNotice({ kind: "error", text: s.ok ? "A hole needs a flat face." : s.error });
    const frame = facePlaneFrame(f.normal!, f.point!);
    const c = to2D(frame, selection.point).map(round3) as [number, number];
    create({ id: nextId(doc, "hole"), op: "hole", face: s.selector, center: c, diameter: 5, depth: "through" });
  };

  const edgeFeature = (op: "fillet" | "chamfer") => {
    if (!doc || !view || selection.edges.length === 0) {
      return setNotice({ kind: "error", text: `Click one or more edges (shift-click for more), then ${op === "fillet" ? "Fillet" : "Chamfer"}.` });
    }
    const s = edgesSelectorFor(view.edges, view.faces, selection.edges);
    if (!s.ok) return setNotice({ kind: "error", text: s.error });
    create(op === "fillet" ? { id: nextId(doc, op), op, edges: s.selector, radius: 1 } : { id: nextId(doc, op), op, edges: s.selector, distance: 1 });
  };

  const patternFeature = (op: "linearPattern" | "circularPattern") => {
    if (!doc || !selected || !["extrude", "cut", "hole"].includes(String(selected.op))) {
      return setNotice({ kind: "error", text: "Select an extrude, cut or hole in the feature tree, then Pattern." });
    }
    const id = nextId(doc, op === "linearPattern" ? "pattern" : "circular");
    create(
      op === "linearPattern"
        ? { id, op, feature: selected.id, direction: [1, 0, 0], spacing: 10, count: 3 }
        : { id, op, feature: selected.id, axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, count: 4 },
    );
  };

  // ------------------------------------------------------------ right-click ask

  const openAsk = (target: AskTarget, x: number, y: number, draftSketch?: SketchFeature, dropped?: { drawing: Drawing; photo?: Photo; readAs: "drawing" | "photo" }) => {
    if (!doc) return setNotice({ kind: "error", text: "Fix the document JSON first." });
    if (ask.previewDoc && (target.kind === "face" || target.kind === "edge" || target.kind === "part")) {
      return setNotice({ kind: "error", text: "Accept or discard the open proposal first: the viewport is showing it." });
    }
    // In the sketcher the ask sees the draft, and accepting updates the draft.
    let askDoc: RawDocument = doc;
    let sketchCtx: { id: string; apply(f: SketchFeature): void } | undefined;
    if (draftSketch) {
      const f = draftSketch as unknown as Record<string, unknown>;
      const i = doc.features.findIndex((g) => g.id === draftSketch.id);
      askDoc = { ...doc, features: i >= 0 ? doc.features.map((g, k) => (k === i ? f : g)) : [...doc.features, f] };
      sketchCtx = { id: draftSketch.id, apply: (g) => sketchApply.current?.(g) };
    }
    const topo = view ? { faces: view.faces, edges: view.edges, faceOrigins: [] } : null;
    const op = target.kind === "feature" ? askDoc.features.find((g) => g.id === target.id)?.op : undefined;
    const kind: PacketKind = target.kind === "feature" ? (op === "sketch" ? "sketch" : "feature") : target.kind;
    ask.open({ target, label: targetLabel(askDoc, target, topo), kind, doc: askDoc, sketch: sketchCtx, ...dropped, x, y });
  };

  /**
   * A dropped drawing (PDF or image) opens the part-level ask with it attached.
   * An image may be a photo instead: it is prepared as both, with a guess the
   * user can switch. The photo already pinned under the part, dropped again,
   * just pins it again.
   */
  const openDrawing = async (file: File, x: number, y: number) => {
    if (file.size > 20 * 2 ** 20) return setNotice({ kind: "error", text: `${file.name} is over 20 MB; send a smaller drawing.` });
    setNotice({ kind: "info", text: `Reading ${file.name}…` });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let photo: Photo | undefined;
      let readAs: "drawing" | "photo" = "drawing";
      if (file.type !== "application/pdf") {
        const { preparePhoto } = await import("../photo/prepare");
        const prepared = await preparePhoto({ name: file.name, type: file.type, bytes });
        photo = prepared.photo;
        readAs = prepared.guess;
        if (photo.sha256 === photoOf(doc)?.sha256) {
          keepPhoto(photo);
          setPhotoImage({ sha256: photo.sha256, photo });
          return setNotice({ kind: "info", text: `Pinned ${file.name} under the part again.` });
        }
        keepPhoto(photo);
      }
      // Rasterise at 200 dpi (pdf.js loads on first use), keep the text layer, measure legibility.
      const { prepareDrawing } = await import("../drawing/rasterize");
      const drawing = await prepareDrawing({ name: file.name, type: file.type, bytes });
      setNotice(null);
      openAskRef.current({ kind: "part" }, x, y, undefined, { drawing, photo, readAs });
    } catch (e) {
      setNotice({ kind: "error", text: `Could not open ${file.name}: ${(e as Error).message}` });
    }
  };
  const openAskRef = useRef(openAsk);
  openAskRef.current = openAsk;
  const onContext = useCallback((target: PickTarget | null, x: number, y: number) => {
    // Empty space: the whole part, the weakest scope.
    if (!target) return openAskRef.current({ kind: "part" }, x, y);
    // Select what was right-clicked, so it stays outlined while the ask is open.
    setSelection(target.kind === "face" ? { faces: [target.index], edges: [], point: target.point } : { faces: [], edges: [target.index] });
    openAskRef.current({ kind: target.kind, index: target.index }, x, y);
  }, []);

  const onPick = useCallback((target: PickTarget | null, additive: boolean) => {
    setSelection((sel) => {
      if (!target) return additive ? sel : EMPTY_SELECTION;
      if (target.kind === "face") return { faces: [target.index], edges: [], point: target.point };
      const has = sel.edges.includes(target.index);
      if (additive) return { faces: [], edges: has ? sel.edges.filter((e) => e !== target.index) : [...sel.edges, target.index] };
      return { faces: [], edges: [target.index] };
    });
  }, []);

  // Undo / redo from the keyboard, except while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sketch) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) {
        if (e.key === "Escape") setSelection(EMPTY_SELECTION);
        return;
      }
      if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) d.redo();
        else d.undo();
      } else if (e.key.toLowerCase() === "y") {
        e.preventDefault();
        d.redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [d, sketch]);

  const reference = useMemo(() => (sketch && view ? projectEdges(view, sketch.plane) : new Float32Array(0)), [sketch, view]);

  const dirty = d.text !== d.savedText;
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
              ? view.errors.length === 1 && view.errors[0].startsWith("document: no solid")
                ? "No solid yet"
                : `${view.ok ? "Rebuilt" : `${view.errors.length} error${view.errors.length === 1 ? "" : "s"}`}${rebuildMs !== null ? ` · ${Math.round(rebuildMs)} ms` : ""}`
              : "Waiting for kernel…";

  return (
    <ParametersContext.Provider value={params}>
      <div
        className={`app${dragging ? " dragging" : ""}${sketch ? " sketching" : ""}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files[0];
          if (DRAWING_TYPES.includes(file.type)) void openDrawing(file, e.clientX, e.clientY);
          else openFile(file);
        }}
      >
        <header className="topbar">
          <div className="brand">
            <img src="/cocaide-mark-256.png" alt="" width={28} height={28} />
            <span className="wordmark">Cocaide</span>
          </div>
          <div className="doc-title" title={dirty ? "Unsaved changes" : "Click to rename"}>
            {doc && typeof doc.name === "string" ? (
              <TextInput value={doc.name} onCommit={(name) => run({ type: "setName", name })} testId="doc-name" />
            ) : (
              "—"
            )}
            {FILE_EXTENSION}
            {dirty && <span className="dirty">•</span>}
          </div>
          <nav className="actions">
            <select
              aria-label="Open an example"
              value=""
              onChange={(e) => {
                if (e.target.value) replaceDocument(EXAMPLES[e.target.value], `Opened example "${e.target.value}"`);
              }}
            >
              <option value="">Examples…</option>
              {Object.keys(EXAMPLES).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <button onClick={() => replaceDocument(BLANK, "New part")} data-testid="new-part">
              New
            </button>
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
          <button onClick={() => ask.setSettingsOpen(true)} title="Model and key for right-click asks" data-testid="ask-settings-open">
            Ask…
          </button>
            <button className="primary" onClick={exportStep} disabled={kernelState.phase !== "ready" || !!sketch}>
              Export STEP
            </button>
          </nav>
          <div
            className={`status ${(view && !view.ok && status !== "No solid yet") || kernelState.phase === "failed" ? "bad" : ""}`}
            data-testid="status"
          >
            {status}
          </div>
        </header>

        {!sketch && (
          <div className="toolbar" role="toolbar" aria-label="Modelling">
            <button onClick={d.undo} disabled={!d.canUndo} title="Undo (Ctrl+Z)" data-testid="undo">
              ↶ Undo
            </button>
            <button onClick={d.redo} disabled={!d.canRedo} title="Redo (Ctrl+Shift+Z)" data-testid="redo">
              ↷ Redo
            </button>
            <span className="sep" />
            <div className="menu">
              <button onClick={() => setPlaneMenu((m) => !m)} aria-expanded={planeMenu} data-testid="tool-sketch">
                Sketch ▾
              </button>
              {planeMenu && (
                <div className="menu-items" role="menu">
                  {PLANES.map(([label, plane]) => (
                    <button key={label} role="menuitem" onClick={() => startSketch(plane)} data-testid={`plane-${label.split(" ")[0].toLowerCase()}`}>
                      {label}
                    </button>
                  ))}
                  <button role="menuitem" onClick={sketchOnFace} disabled={selection.faces.length !== 1}>
                    On selected face
                  </button>
                </div>
              )}
            </div>
            <button onClick={() => extrude("extrude")} data-testid="tool-extrude">
              Extrude
            </button>
            <button onClick={() => extrude("cut")} data-testid="tool-cut">
              Cut
            </button>
            <button onClick={hole} data-testid="tool-hole" title="Click a flat face, then Hole">
              Hole
            </button>
            <button onClick={() => edgeFeature("fillet")} data-testid="tool-fillet" title="Click edges, then Fillet">
              Fillet
            </button>
            <button onClick={() => edgeFeature("chamfer")} data-testid="tool-chamfer" title="Click edges, then Chamfer">
              Chamfer
            </button>
            <button onClick={() => patternFeature("linearPattern")} data-testid="tool-linear-pattern" title="Select a feature in the tree, then Pattern">
              Linear pattern
            </button>
            <button onClick={() => patternFeature("circularPattern")} data-testid="tool-circular-pattern">
              Circular pattern
            </button>
          </div>
        )}

        {notice && (
          <div className={`notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"} data-testid="notice">
            <span>{notice.text}</span>
            <button aria-label="Dismiss" onClick={() => setNotice(null)}>
              ×
            </button>
          </div>
        )}

        <main className="workspace">
          <aside className="side left">
            <FeatureTree
              doc={doc}
              view={view}
              selectedId={selectedFeature}
              onSelect={(id) => {
                setSelectedFeature(id);
                if (id) setRightTab("properties");
              }}
              onEditSketch={editSketch}
              dispatch={d.dispatch}
              onError={(text) => setNotice({ kind: "error", text })}
              onAsk={sketch ? undefined : openAsk}
            />
            <ParametersPanel doc={doc} dispatch={d.dispatch} onError={(text) => setNotice({ kind: "error", text })} onAsk={sketch ? undefined : openAsk} />
            <MeasurementsPanel measurements={view?.measurements ?? null} />
          </aside>
          {sketch ? (
            <SketchMode
              key={sketch.id}
              session={sketch}
              reference={reference}
              onFinish={finishSketch}
              onCancel={() => setSketch(null)}
              applyRef={sketchApply}
              onAsk={(t, draft, x, y) =>
                openAsk(t.kind === "entity" ? { kind: "entity", sketch: draft.id, entity: t.entity } : { kind: "constraint", sketch: draft.id, index: t.index }, x, y, draft)
              }
            />
          ) : (
            <>
              <section className="center">
                <Viewport
                  view={view}
                  fitToken={fitToken}
                  selection={selection}
                  onPick={onPick}
                  onContext={onContext}
                  underlay={underlay}
                  onPhotoPoint={photoPick ? onPhotoPoint : null}
                />
              {ask.previewDoc && (
                <div className="preview-banner" data-testid="preview-banner">
                  Previewing the proposal
                </div>
              )}
              {!ask.previewDoc && shownPhoto && doc && (
                <PhotoBar
                  photo={shownPhoto}
                  stored={!photoImage || photoImage.sha256 !== photoSha ? "loading" : photoShown ? "shown" : "missing"}
                  picking={photoPick ? (photoPick.from ? "to" : "from") : null}
                  opacity={photoOpacity}
                  onOpacity={setPhotoOpacity}
                  onPick={() => setPhotoPick({})}
                  onCancelPick={() => setPhotoPick(null)}
                  dispatch={d.dispatch}
                  onError={(text) => setNotice({ kind: "error", text })}
                />
              )}
              </section>
              <aside className="side right">
                <div className="tabs" role="tablist">
                  <button role="tab" aria-selected={rightTab === "properties"} onClick={() => setRightTab("properties")}>
                    Properties
                  </button>
                  <button role="tab" aria-selected={rightTab === "document"} onClick={() => setRightTab("document")} data-testid="tab-document">
                    Document
                  </button>
                </div>
                {rightTab === "properties" ? (
                  <section className="panel">
                    {doc && selectedFeature ? (
                      <PropertyPanel
                        doc={doc}
                        featureId={selectedFeature}
                        view={view}
                        selection={selection}
                        dispatch={d.dispatch}
                        onEditSketch={editSketch}
                        onSelectFeature={setSelectedFeature}
                        onAsk={openAsk}
                      />
                    ) : (
                      <Help />
                    )}
                  </section>
                ) : (
                  <DocumentEditor ref={editor} text={d.text} onChange={d.setText} parseError={parsed.ok ? null : parsed.error} />
                )}
              </aside>
            </>
          )}
        </main>
        <AskPopover ask={ask} />
        {ask.settingsOpen && <AskSettingsDialog settings={ask.settings} onSave={ask.setSettings} onClose={() => ask.setSettingsOpen(false)} />}
      </div>
    </ParametersContext.Provider>
  );
}

function Help() {
  return (
    <div className="help muted">
      <p>
        <strong>Sketch ▾</strong> starts a sketch on a datum plane. Draw, select geometry to add dimensions, then <strong>Finish sketch</strong>.
      </p>
      <p>
        <strong>Extrude</strong> and <strong>Cut</strong> use the selected (or latest) sketch. Click a face for <strong>Hole</strong>; click edges
        (shift-click for more) for <strong>Fillet</strong> and <strong>Chamfer</strong>; select a feature in the tree to pattern it.
      </p>
      <p>Select a feature in the tree to edit it. Ctrl+Z undoes any change.</p>
      <p>
        <strong>Right-click</strong> a feature, a failed rebuild, a face, an edge, a parameter, or (in the sketcher) an entity or constraint to ask
        about it. The answer or proposed change is scoped to what you clicked. Right-click empty space to ask about the whole part or describe a
        new one, or drop a drawing (PDF or image) or a photo of a part on the window.
      </p>
    </div>
  );
}

/** Model edges projected onto a sketch plane, as 2D segment pairs. */
function projectEdges(view: RebuildView, plane: DatumPlane): Float32Array {
  if (!view.mesh) return new Float32Array(0);
  const frame = planeFrame(plane.normal, plane.origin, plane.xDir);
  const segs = view.mesh.edges;
  const out: number[] = [];
  view.mesh.edgeRanges.forEach((r, i) => {
    if (view.edges[i]?.seam) return;
    for (let k = r.start; k < r.start + r.count; k++) {
      const a = to2D(frame, [segs[k * 6], segs[k * 6 + 1], segs[k * 6 + 2]]);
      const b = to2D(frame, [segs[k * 6 + 3], segs[k * 6 + 4], segs[k * 6 + 5]]);
      out.push(a[0], a[1], b[0], b[1]);
    }
  });
  return new Float32Array(out);
}

function round9(x: number): number {
  return Math.round(x * 1e9) / 1e9 + 0;
}


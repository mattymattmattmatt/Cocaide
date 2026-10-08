import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import bracketText from "../../examples/bracket.cocaide.json?raw";
import flangeText from "../../examples/flange.cocaide.json?raw";
import plateText from "../../examples/mounting-plate.cocaide.json?raw";
import standText from "../../examples/stand.cocaide.json?raw";
import framingText from "../../examples/frame-members.cocaide.json?raw";
import tableText from "../../examples/table-frame.cocaide.json?raw";
import type { DrawingGeometry } from "../ask/kernel";
import { featureKind, isDrawingTarget, targetLabel, type AskTarget, type PacketKind } from "../ask/packet";
import { geometryKey } from "../doc/drawing";
import { drawingChecks } from "../drafting/checks";
import { composeSheet } from "../drafting/compose";
import { sheetPDF } from "../drafting/pdf";
import { DEFAULT_VIEWS, planDrawing, visibleLength } from "../drafting/plan";
import { sheetSVG } from "../drafting/svg";
import { bodyPart, bodyPartFile } from "../doc/bodyPart";
import { apply, nextId, type Command, type RawDocument } from "../doc/commands";
import { FILE_EXTENSION, formatDocument, parseDocumentText } from "../doc/format";
import { documentParameters, resolvedDocument, restoreExpressions } from "../doc/parameters";
import { exportRefusal, mmPerPixel, photoOf } from "../doc/photo";
import { DEFAULT_BODY, type Constraint, type DatumPlane, type Material, type ProfileDef, type SketchEntity, type SketchFeature, type Vec2, type Vec3 } from "../doc/types";
import { validateDocument } from "../doc/validate";
import { facePlaneFrame, planeFrame, to2D } from "../geom/frame";
import { STEEL_DENSITY } from "../geom/section";
import { dot3 } from "../geom/vec";
import { edgesSelectorFor, faceSelectorFor } from "../kernel/synthesize";
import { KernelClient } from "../worker/client";
import type { RebuildView } from "../worker/protocol";
import { AskPopover } from "./ask/AskPopover";
import { AskSettingsDialog } from "./ask/AskSettingsDialog";
import { canAsk, modelFor } from "./ask/settings";
import type { ProfileFacts } from "../ask/profile";
import { BodiesPanel } from "./BodiesPanel";
import { CutListPanel } from "./CutListPanel";
import type { FrameActions } from "./FrameProps";
import { NodesPanel, type PathRequest, type SizeChoice } from "./NodesPanel";
import { useAsk } from "./ask/useAsk";
import type { Drawing, Photo } from "../ask/part";
import { loadPhoto, savePhoto } from "../photo/store";
import { addFramePath } from "../weldment/frame";
import { addLibraryMember, ensureCopy, exportLibrary, mergeLibrary, placeMember, toEntry, updatePartCopy, type LibraryEntry } from "../weldment/library";
import { deleteProfile, listProfiles, saveProfile, saveProfiles } from "../weldment/store";
import { DocumentEditor, type EditorHandle } from "./DocumentEditor";
import { FeatureTree } from "./FeatureTree";
import { ParametersContext, TextInput } from "./fields";
import { MeasurementsPanel } from "./MeasurementsPanel";
import { ParametersPanel } from "./ParametersPanel";
import { PhotoBar } from "./PhotoBar";
import { ProfileCard } from "./ProfileCard";
import { nextBodyName, PropertyPanel } from "./PropertyPanel";
import { SectionsPanel } from "./SectionsPanel";
import { SketchMode, type SketchSession } from "./sketcher/SketchMode";
import { useDocument } from "./useDocument";
import { DrawingSide, DrawingTree, nextDrawingId } from "./drawing/DrawingPanels";
import { SheetView, type SheetTarget } from "./drawing/SheetView";
import { Icon, type IconName } from "./icons";
import { MenuItem, ToolButton, ToolMenu } from "./tools";
import { EMPTY_SELECTION, Viewport, type FrameNode, type PickTarget, type Selection, type Underlay } from "./Viewport";

const EXAMPLES: Record<string, string> = {
  bracket: bracketText,
  "mounting plate": plateText,
  flange: flangeText,
  "stand (two bodies)": standText,
  "members (weldment)": framingText,
  "table frame (weldment)": tableText,
};
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

function download(filename: string, text: string | Uint8Array, type: string) {
  const url = URL.createObjectURL(new Blob([text as BlobPart], { type }));
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
  const [rightTab, setRightTab] = useState<"properties" | "sections" | "cutlist" | "document">("properties");
  const [sketch, setSketch] = useState<SketchSession | null>(null);
  const [hiddenBodies, setHiddenBodies] = useState<ReadonlySet<string>>(new Set());
  /** The section library in this browser (Phase I). */
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  /** The sketch whose profile card is open. */
  const [profileCard, setProfileCard] = useState<string | null>(null);
  const [savedProfile, setSavedProfile] = useState<string | null>(null);
  /** The 3D model, or the part's drawing (Phase L). */
  const [mode, setMode] = useState<"model" | "drawing">("model");
  /** The views projected for the drawing, for the geometry and view directions in `key`. */
  const [geometry, setGeometry] = useState<{ key: string; g: DrawingGeometry | null } | null>(null);
  const [drawingSel, setDrawingSel] = useState<string | null>(null);
  const editor = useRef<EditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const latest = useRef(0);
  const needsFit = useRef(true);

  const { parsed, doc } = d;
  const params = useMemo(() => documentParameters(doc), [doc]);
  const ask = useAsk({ kernel: kernel.port, doc, replaceDoc: d.replaceDoc, library });
  /** In the sketcher: replaces the draft with an accepted ask's sketch. */
  const sketchApply = useRef<((f: SketchFeature) => void) | null>(null);
  /** What the viewport shows: the document, or an open proposal while it is previewed. */
  const shown = useMemo(() => ask.previewDoc ?? (parsed.ok ? parsed.value : null), [ask.previewDoc, parsed]);
  /** The frame's nodes, where the viewport draws them. */
  const shownNodes = useMemo<FrameNode[]>(() => (shown ? Object.entries(validateDocument(shown).nodes).map(([name, at]) => ({ name, at })) : []), [shown]);
  /** The drawing as shown (an open proposal's, while it is previewed), and as it is in the document. */
  const shownDrawing = useMemo(() => (shown ? validateDocument(shown).drawing : null), [shown]);
  const docDrawing = useMemo(() => (doc ? validateDocument(doc).drawing : null), [doc]);

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

  const reloadLibrary = useCallback(
    () =>
      listProfiles().then(
        (entries) => {
          setLibrary(entries);
          setLibraryError(null);
        },
        (e: Error) => setLibraryError(`The section library is not available in this browser: ${e.message}`),
      ),
    [],
  );
  useEffect(() => {
    void reloadLibrary();
  }, [reloadLibrary]);

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

  // In the drawing: project the rebuilt part for its views. The worker reuses its rebuild, so this is only the projection.
  const viewsKey = shownDrawing ? shownDrawing.views.map((v) => `${v.id}:${v.look}`).join(",") : "";
  const projectionKey = shown && shownDrawing && view ? `${geometryKey(shown)}|${viewsKey}` : null;
  useEffect(() => {
    if (mode !== "drawing" || !projectionKey || !shown || !shownDrawing || geometry?.key === projectionKey) return;
    let live = true;
    kernel.port.project(shown, shownDrawing.views.map((v) => ({ id: v.id, look: v.look }))).then(
      (g) => live && setGeometry({ key: projectionKey, g }),
      (e: Error) => live && setNotice({ kind: "error", text: `Could not project the views: ${e.message}` }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, projectionKey]);
  const sheet = useMemo(
    () => (shown && shownDrawing ? composeSheet(shown, { measurements: view?.measurements ?? null, geometry: geometry?.g ?? null }) : null),
    [shown, shownDrawing, view, geometry],
  );
  const drawingChecksNow = useMemo(() => (sheet && shown ? drawingChecks(sheet, shown, view?.measurements ?? null, geometry?.g ?? null) : []), [sheet, shown, view, geometry]);
  const failedIds = useMemo(() => (sheet ? sheet.annotations.filter((a) => a.problem).map((a) => a.id) : []), [sheet]);

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
    if (!doc) return setNotice({ kind: "error", text: "Fix the document JSON first." });
    setSketch({ id: nextId(doc, "sketch"), isNew: true, plane, entities: [], constraints: [] });
    setSelection(EMPTY_SELECTION);
  };

  const sketchOnFace = () => {
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
    // A dimension written as "=b" goes in with its value, and the expression beside it, so the sketcher shows and keeps it.
    const raw = (features.find((g) => g.id === id)?.constraints ?? []) as { value?: unknown }[];
    const constraints = (f.constraints ?? []).map((c, i) => (typeof raw[i]?.value === "string" ? ({ ...c, expr: raw[i].value } as unknown as Constraint) : c));
    setSketch({
      id,
      isNew: false,
      plane: f.plane,
      entities: (f.entities ?? []) as SketchEntity[],
      constraints,
      suppressed: f.suppressed,
      ...(f.profile ? { profile: f.profile } : {}),
    });
    setSelection(EMPTY_SELECTION);
  };

  /** `weldment`: the sketch's "Weldment profile" box is ticked; the profile card opens. */
  const finishSketch = (feature: SketchFeature, weldment = false) => {
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
    if (weldment) setProfileCard(feature.id);
  };

  // ------------------------------------------------------------ weldment profiles

  const density = (doc?.material as { densityKgPerM3?: number } | undefined)?.densityKgPerM3 ?? STEEL_DENSITY;

  /** The profile card's Save: into the library, and the sketch marked as that profile (one undo step). */
  const saveProfileCard = async (def: ProfileDef, favourite: boolean, previous: LibraryEntry | undefined) => {
    const sketchId = profileCard;
    if (!sketchId) return;
    const entry = { ...toEntry(def, previous, crypto.randomUUID()), favourite };
    try {
      await saveProfile(entry);
    } catch (e) {
      return setNotice({ kind: "error", text: `Not saved to the section library: ${(e as Error).message}` });
    }
    setProfileCard(null);
    run({ type: "updateFeature", id: sketchId, patch: { profile: { name: entry.name, library: { id: entry.id, version: entry.version } } } });
    await reloadLibrary();
    setSavedProfile(entry.id);
    setRightTab("sections");
    const sizes = entry.sizes.length;
    setNotice({
      kind: "info",
      text: `${entry.name} ${previous ? `is now v${entry.version}` : "is in the section library"}, with ${sizes} size${sizes === 1 ? "" : "s"}. Use + Member to put it in a part.`,
    });
  };

  /** The profile card's Suggest: the model names the section from its measurements (Phase K). */
  const suggestNames = async (facts: ProfileFacts) => {
    if (!canAsk(ask.settings)) {
      ask.setSettingsOpen(true);
      throw new Error("set up a model in Settings first");
    }
    const [model, { suggestProfile }] = await Promise.all([modelFor(ask.settings), import("../ask/profile")]);
    return suggestProfile(model, facts);
  };

  /** A member of a library size: the part's copy of the profile and the member, as one undo step. */
  const addMember = (entry: LibraryEntry, designation: string) => {
    if (!doc) return setNotice({ kind: "error", text: "Fix the document JSON first." });
    const r = addLibraryMember(doc, entry, designation);
    if (!r.ok) return setNotice({ kind: "error", text: r.error });
    d.replaceDoc(r.doc);
    setSelectedFeature(r.id);
    setRightTab("properties");
    setNotice(r.note ? { kind: "info", text: r.note } : null);
    const used = { ...entry, uses: entry.uses + 1 };
    setLibrary((l) => l.map((e) => (e.id === entry.id ? used : e)));
    void saveProfile(used).catch(() => undefined);
  };

  /** The toolbar's Member: another of the selected (or last) member, else the library. */
  const memberTool = () => {
    if (!doc) return setNotice({ kind: "error", text: "Fix the document JSON first." });
    const like = (selected?.op === "member" ? selected : [...resolved].reverse().find((f) => f.op === "member")) as { profile: string; size: string } | undefined;
    if (!like || !(doc.profiles as Record<string, ProfileDef> | undefined)?.[like.profile]) {
      setRightTab("sections");
      return setNotice({
        kind: "info",
        text: library.length
          ? "Pick a size in Sections, then + Member."
          : "The section library is empty: draw a section as a sketch, tick Weldment profile and finish it.",
      });
    }
    const r = placeMember(doc, like.profile, like.size);
    if (!r.ok) return setNotice({ kind: "error", text: r.error });
    d.replaceDoc(r.doc);
    setSelectedFeature(r.id);
    setRightTab("properties");
    setNotice(null);
  };

  const updateCopy = (entry: LibraryEntry) => {
    if (!doc) return;
    const r = updatePartCopy(doc, entry);
    if (!r.ok) return setNotice({ kind: "error", text: `${entry.name} not updated: ${r.error}` });
    d.replaceDoc(r.doc);
    setNotice({ kind: "info", text: `This part's copy of ${r.name} is now v${entry.version}. Ctrl+Z puts the old one back.` });
  };

  /** Several commands as one undo step (switching every member of a size, adding a weld). */
  const batch = (cmds: Command[]): string | null => {
    if (!doc) return "fix the document JSON first";
    let next: RawDocument = doc;
    for (const cmd of cmds) {
      const r = apply(next, cmd, { user: true });
      if (!r.ok) return r.error;
      next = r.doc;
    }
    d.replaceDoc(next);
    return null;
  };
  const frameActions: FrameActions = { onCreate: create, onBatch: batch };

  /** Sizes for a path of members: the part's own profiles first, then the library's. */
  const sizeChoices = useMemo<SizeChoice[]>(() => {
    const out: SizeChoice[] = [];
    const copies = (doc?.profiles ?? {}) as Record<string, ProfileDef>;
    for (const [name, p] of Object.entries(copies)) for (const sz of p.sizes) out.push({ value: `part|${name}|${sz.designation}`, label: `${sz.designation} (in this part)` });
    for (const e of library) {
      const copy = Object.values(copies).find((p) => p.library?.id === e.id);
      for (const sz of e.sizes) if (!copy?.sizes.some((x) => x.designation === sz.designation)) out.push({ value: `lib|${e.id}|${sz.designation}`, label: `${sz.designation} (library)` });
    }
    return out;
  }, [doc, library]);

  /** Members along a path of nodes, with the part's copy of a library profile if it needs one: one undo step. */
  const addPath = (req: PathRequest): boolean => {
    if (!doc) return false;
    const [where, key, size] = req.size.split("|");
    let next: RawDocument = doc;
    let profile = key;
    let note: string | undefined;
    const entry = where === "lib" ? library.find((e) => e.id === key) : undefined;
    if (where === "lib") {
      if (!entry) return setNotice({ kind: "error", text: "That section is no longer in the library." }), false;
      const copy = ensureCopy(doc, entry, size);
      if (!copy.ok) return setNotice({ kind: "error", text: copy.error }), false;
      next = copy.doc;
      profile = copy.name;
      note = copy.note;
    }
    const r = addFramePath(next, { profile, size, path: req.path, line: req.line, mitre: req.mitre });
    if (!r.ok) return setNotice({ kind: "error", text: r.error }), false;
    d.replaceDoc(r.doc);
    const joints = r.joints.length ? ` and ${r.joints.length} mitre${r.joints.length === 1 ? "" : "s"}` : "";
    setNotice({ kind: "info", text: `Added ${r.members.length} member${r.members.length === 1 ? "" : "s"} of ${size}${joints}.${note ? ` ${note}` : ""}` });
    if (entry) {
      const used = { ...entry, uses: entry.uses + r.members.length };
      setLibrary((l) => l.map((e) => (e.id === entry.id ? used : e)));
      void saveProfile(used).catch(() => undefined);
    }
    return true;
  };

  const favourite = (entry: LibraryEntry) => {
    const next = { ...entry, favourite: !entry.favourite };
    setLibrary((l) => l.map((e) => (e.id === entry.id ? next : e)));
    void saveProfile(next).catch((e: Error) => setNotice({ kind: "error", text: e.message }));
  };

  const removeSection = async (entry: LibraryEntry) => {
    try {
      await deleteProfile(entry.id);
    } catch (e) {
      return setNotice({ kind: "error", text: `${entry.name} not deleted: ${(e as Error).message}` });
    }
    await reloadLibrary();
    setNotice({ kind: "info", text: `${entry.name} is out of the section library. Parts that use it keep their copies.` });
  };

  const exportSections = () => {
    download("sections.cocaide-sections.json", JSON.stringify(exportLibrary(library), null, 2), "application/json");
  };

  const importSections = async (file: File) => {
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch (e) {
      return setNotice({ kind: "error", text: `${file.name} is not JSON: ${(e as Error).message}` });
    }
    const merged = mergeLibrary(library, data);
    if ("error" in merged) return setNotice({ kind: "error", text: `${file.name}: ${merged.error}` });
    try {
      await saveProfiles(merged.entries);
    } catch (e) {
      return setNotice({ kind: "error", text: `Not imported: ${(e as Error).message}` });
    }
    await reloadLibrary();
    const skipped = merged.skipped.length ? ` Skipped ${merged.skipped.length}: ${merged.skipped.join("; ")}.` : "";
    setNotice({ kind: merged.skipped.length ? "error" : "info", text: `Imported ${file.name}: ${merged.added} new, ${merged.updated} updated.${skipped}` });
  };

  const sketchFor = (): Record<string, unknown> | undefined =>
    selected?.op === "sketch" ? selected : [...resolved].reverse().find((f) => f.op === "sketch");

  const extrude = (op: "extrude" | "cut") => {
    const sk = sketchFor();
    if (!doc || !sk) return setNotice({ kind: "error", text: `Make a sketch first, then ${op === "cut" ? "Cut" : "Extrude"}.` });
    const plane = sk.plane as DatumPlane;
    const feature: Record<string, unknown> = { id: nextId(doc, op), op, sketch: sk.id, distance: op === "cut" ? 5 : 10 };
    // Where new material goes: the one body there is, or, in a part of several, a new body.
    const bodies = validateDocument(doc).bodies;
    if (op === "extrude" && bodies.length === 1 && bodies[0] !== DEFAULT_BODY) feature.body = bodies[0];
    if (op === "extrude" && bodies.length > 1) feature.newBody = nextBodyName(bodies);
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
    // In a part of several bodies, the hole drills the body that was clicked.
    create({ id: nextId(doc, "hole"), op: "hole", face: s.selector, center: c, diameter: 5, depth: "through", ...(f.body ? { bodies: [f.body] } : {}) });
  };

  const combine = () => {
    const names = view?.bodies.map((b) => b.name) ?? [];
    if (!doc || names.length < 2) return setNotice({ kind: "error", text: "Combine needs two bodies or more." });
    // The clicked face's body goes into the first other body; change either in Properties.
    const picked = selection.faces.length ? view?.faces[selection.faces[0]]?.body : undefined;
    const tool = picked ?? names[1];
    const target = names.find((n) => n !== tool)!;
    create({ id: nextId(doc, "combine"), op: "combine", operation: "add", target, tools: [tool] });
  };

  const edgeFeature = (op: "fillet" | "chamfer") => {
    if (!doc || !view || selection.edges.length === 0) {
      return setNotice({ kind: "error", text: `Click one or more edges (shift-click for more), then ${op === "fillet" ? "Fillet" : "Chamfer"}.` });
    }
    const s = edgesSelectorFor(view.edges, view.faces, selection.edges);
    if (!s.ok) return setNotice({ kind: "error", text: s.error });
    create(op === "fillet" ? { id: nextId(doc, op), op, edges: s.selector, radius: 1 } : { id: nextId(doc, op), op, edges: s.selector, distance: 1 });
  };

  // ------------------------------------------------------------ multibody tools (Phase M)

  /** The body a body tool works on: the clicked face's, else the newest. */
  const pickedBody = (): string | undefined => (selection.faces.length ? view?.faces[selection.faces[0]]?.body : undefined) ?? view?.bodies.at(-1)?.name;
  const bodyBox = (name: string) => view?.measurements?.bodies.find((b) => b.name === name)?.boundingBox ?? view?.measurements?.boundingBox ?? null;
  const yz = (x: number) => ({ type: "datum", normal: [1, 0, 0], origin: [round3(x), 0, 0] });

  /** Mirror: the selected feature about the part's middle, or the clicked body beside itself. */
  const mirrorTool = () => {
    const bb = view?.measurements?.boundingBox;
    if (!doc || !bb) return setNotice({ kind: "error", text: "Mirror needs a part to mirror." });
    if (selected && ["extrude", "cut", "hole", "member"].includes(String(selected.op))) {
      return create({ id: nextId(doc, "mirror"), op: "mirror", plane: yz((bb.min[0] + bb.max[0]) / 2), feature: selected.id });
    }
    const body = pickedBody();
    const box = body ? bodyBox(body) : null;
    if (!body || !box) return setNotice({ kind: "error", text: "Select a feature in the tree, or click a body, then Mirror." });
    create({ id: nextId(doc, "mirror"), op: "mirror", plane: yz(box.max[0]), bodies: [body] });
  };

  const splitTool = () => {
    const body = pickedBody();
    const box = body ? bodyBox(body) : null;
    if (!doc || !body || !box) return setNotice({ kind: "error", text: "Split needs a body: click one, then Split." });
    create({ id: nextId(doc, "split"), op: "split", body, plane: yz((box.min[0] + box.max[0]) / 2) });
  };

  const moveTool = () => {
    const body = pickedBody();
    const box = body ? bodyBox(body) : null;
    if (!doc || !body || !box) return setNotice({ kind: "error", text: "Move/Copy needs a body: click one, then Move/Copy." });
    create({ id: nextId(doc, "move"), op: "move", bodies: [body], translate: [round3(box.size[0] + 20), 0, 0], copy: true });
  };

  const deleteBodyTool = (name = pickedBody()) => {
    if (!doc || !name) return;
    if ((view?.bodies.length ?? 0) < 2) return setNotice({ kind: "error", text: "A part's only body can't be deleted." });
    create({ id: nextId(doc, "delete"), op: "deleteBody", bodies: [name] });
  };

  const saveBody = (name: string) => {
    if (!doc) return;
    const r = bodyPart(doc, name);
    if (!r.ok) return setNotice({ kind: "error", text: `${name} not saved: ${r.error}` });
    const file = bodyPartFile(doc, name);
    download(file, formatDocument(r.doc), "application/json");
    setNotice({ kind: "info", text: `Saved ${file}: this part keeping only ${name}, as a part of its own. Open it to work on it alone.` });
  };

  const patternFeature = (op: "linearPattern" | "circularPattern") => {
    if (!doc || !selected || !["extrude", "cut", "hole", "member"].includes(String(selected.op))) {
      return setNotice({ kind: "error", text: "Select an extrude, cut, hole or member in the feature tree, then Pattern." });
    }
    const id = nextId(doc, op === "linearPattern" ? "pattern" : "circular");
    create(
      op === "linearPattern"
        ? { id, op, feature: selected.id, direction: [1, 0, 0], spacing: 10, count: 3 }
        : { id, op, feature: selected.id, axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, count: 4 },
    );
  };

  // ------------------------------------------------------------ drawing

  /** New drawing: code plans the sheet from the part as rebuilt (Phase L). Ctrl+Z puts the old one back. */
  const newDrawing = async () => {
    if (!doc || !view?.measurements) return setNotice({ kind: "error", text: "The part needs to rebuild before it can be drawn." });
    try {
      const g = await kernel.port.project(doc, DEFAULT_VIEWS);
      const drawing = planDrawing(doc, view.measurements, g, { date: new Date().toISOString().slice(0, 10) });
      if (run({ type: "setDrawing", drawing }) === null) {
        setDrawingSel(null);
        setNotice({ kind: "info", text: `New drawing: ${drawing.sheet.size}, ${drawing.views.length} views, ${drawing.annotations.length} annotations.${docDrawing ? " Ctrl+Z puts the old one back." : ""}` });
      }
    } catch (e) {
      setNotice({ kind: "error", text: `No drawing: ${(e as Error).message}` });
    }
  };

  /** A balloon for every cut list item without one, on the member of it its view shows most of. */
  const balloonAll = () => {
    if (!docDrawing || !sheet) return;
    const ballooned = new Set(sheet.annotations.filter((a) => a.type === "balloon" && !a.problem).map((a) => a.item));
    const missing = sheet.cutList.filter((i) => !ballooned.has(i.item));
    if (!missing.length) return setNotice({ kind: "info", text: "Every cut list item has a balloon." });
    const viewId = (docDrawing.views.find((v) => v.look === "iso") ?? docDrawing.views[0])?.id;
    if (!viewId) return setNotice({ kind: "error", text: "Add a view first." });
    const members = view?.measurements?.members ?? [];
    let d = docDrawing;
    const cmds: Command[] = [];
    for (const item of missing) {
      const member = [...item.members].sort((a, b) => visibleLength(geometry?.g ?? null, viewId, members.find((m) => m.id === b)?.body ?? b) - visibleLength(geometry?.g ?? null, viewId, members.find((m) => m.id === a)?.body ?? a))[0];
      const id = nextDrawingId(d, "b");
      const annotation = { type: "balloon" as const, view: viewId, member };
      cmds.push({ type: "setAnnotation", id, annotation });
      d = { ...d, annotations: [...d.annotations, { id, ...annotation }] };
    }
    const problem = batch(cmds);
    if (problem) setNotice({ kind: "error", text: problem });
    else setNotice({ kind: "info", text: `Ballooned ${missing.length} item${missing.length === 1 ? "" : "s"} in ${viewId}.` });
  };

  const exportDrawing = (kind: "pdf" | "svg") => {
    if (!sheet) return setNotice({ kind: "error", text: "There is no drawing to export." });
    const name = `${fileBase(view?.name ?? "part")}-drawing.${kind}`;
    if (kind === "pdf") download(name, sheetPDF(sheet, { title: docDrawing?.sheet.title ?? view?.name ?? "drawing" }), "application/pdf");
    else download(name, sheetSVG(sheet), "image/svg+xml");
    const failing = drawingChecksNow.filter((c) => !c.ok).length;
    setNotice({ kind: "info", text: `Exported ${name}.${failing ? ` ${failing} drawing check${failing === 1 ? "" : "s"} fail${failing === 1 ? "s" : ""}: see Checks.` : ""}` });
  };

  const moveView = (id: string, at: Vec2) => {
    const v = docDrawing?.views.find((x) => x.id === id);
    if (!v) return;
    const { id: _id, ...rest } = v;
    run({ type: "setView", id, view: { ...rest, at } });
  };

  const moveAnnotation = (id: string, delta: Vec2) => {
    const a = docDrawing?.annotations.find((x) => x.id === id);
    const placed = sheet?.annotations.find((x) => x.id === id)?.at;
    if (!a || !placed) return;
    const moved: Vec2 = [placed[0] + delta[0], placed[1] + delta[1]];
    const cv = "view" in a ? sheet?.views.find((v) => v.id === a.view) : undefined;
    // Balloons, callouts and weld symbols are held relative to their view, so they move with it.
    const at: Vec2 = cv ? [moved[0] - cv.centre[0], moved[1] - cv.centre[1]] : moved;
    const { id: _id, ...rest } = a;
    run({ type: "setAnnotation", id, annotation: { ...rest, at: at.map((x) => Math.round(x * 10) / 10 + 0) } });
  };

  const sheetContext = (t: SheetTarget | null, x: number, y: number) => {
    if (t) setDrawingSel(t.id);
    openAskRef.current(t ? (t.kind === "view" ? { kind: "view", id: t.id } : { kind: "annotation", id: t.id }) : { kind: "drawing" }, x, y);
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
    if (isDrawingTarget(target) && !validateDocument(askDoc).drawing) return setNotice({ kind: "error", text: "Make a drawing first: New drawing." });
    const op = target.kind === "feature" ? askDoc.features.find((g) => g.id === target.id)?.op : undefined;
    const kind: PacketKind = target.kind === "feature" ? featureKind(op) : target.kind;
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
      // Ctrl+S saves the part, from anywhere but the sketcher (it saves on Finish).
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!sketch) saveRef.current();
        return;
      }
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

  const saveRef = useRef(save);
  saveRef.current = save;

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
          <div className="mode-switch" role="tablist" aria-label="Model or drawing">
            <button role="tab" aria-selected={mode === "model"} onClick={() => setMode("model")} data-testid="mode-model">
              <Icon name="model" />
              Model
            </button>
            <button role="tab" aria-selected={mode === "drawing"} onClick={() => setMode("drawing")} disabled={!!sketch} data-testid="mode-drawing">
              <Icon name="drawing" />
              Drawing
            </button>
          </div>
          <nav className="actions" aria-label="File">
            <label className="examples" title="Open one of the example parts">
              <Icon name="examples" />
              <select
                aria-label="Open an example"
                value=""
                onChange={(e) => {
                  if (e.target.value) replaceDocument(EXAMPLES[e.target.value], `Opened example "${e.target.value}"`);
                }}
              >
                <option value="">Examples</option>
                {Object.keys(EXAMPLES).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <button aria-label="New" onClick={() => replaceDocument(BLANK, "New part")} title="A new, empty part (Ctrl+Z brings the last one back)" data-testid="new-part">
              <Icon name="new" />
              <span className="label">New</span>
            </button>
            <button aria-label="Open" onClick={() => fileInput.current?.click()} title="Open a .cocaide.json part">
              <Icon name="open" />
              <span className="label">Open</span>
            </button>
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
            <button aria-label="Save" onClick={save} title="Download the part as .cocaide.json (Ctrl+S)">
              <Icon name="save" />
              <span className="label">Save</span>
            </button>
            <span className="sep" />
            <button aria-label="Settings" onClick={() => ask.setSettingsOpen(true)} title="Settings: units, and the model and key for right-click asks" data-testid="ask-settings-open">
              <Icon name="settings" />
              <span className="label">Settings</span>
            </button>
            <button className="primary" onClick={exportStep} disabled={kernelState.phase !== "ready" || !!sketch} title="Download the solid as STEP, for other CAD and CAM">
              <Icon name="export" />
              Export STEP
            </button>
          </nav>
          <div className="units" title="Units: millimetres (metric). Lengths in mm, angles in degrees, mass in kg." data-testid="units">
            mm
          </div>
          <div
            className={`status ${(view && !view.ok && status !== "No solid yet") || kernelState.phase === "failed" ? "bad" : ""}`}
            data-testid="status"
          >
            {status}
          </div>
        </header>

        {!sketch && mode === "drawing" && (
          <div className="toolbar" role="toolbar" aria-label="Drawing">
            <ToolButton icon="undo" label="Undo" onClick={d.undo} disabled={!d.canUndo} title="Undo (Ctrl+Z)" testId="undo" />
            <ToolButton icon="redo" label="Redo" onClick={d.redo} disabled={!d.canRedo} title="Redo (Ctrl+Shift+Z)" testId="redo" />
            <span className="sep" />
            <ToolButton
              icon="drawing"
              label="New drawing"
              onClick={() => void newDrawing()}
              disabled={kernelState.phase !== "ready"}
              title="Plan the sheet from the part: views, overall size, holes, balloons, tables"
              testId="drawing-new"
            />
            <ToolButton icon="balloon" label="Balloon all" onClick={balloonAll} disabled={!sheet || sheet.cutList.length === 0} title="A balloon for every cut list item that has none" testId="drawing-balloon-all" />
            <span className="sep" />
            <ToolButton icon="export" label="Export PDF" onClick={() => exportDrawing("pdf")} disabled={!sheet} title="Download the sheet as a PDF, to print or send" testId="drawing-export-pdf" />
            <ToolButton icon="export" label="Export SVG" onClick={() => exportDrawing("svg")} disabled={!sheet} title="Download the sheet as an SVG drawing" testId="drawing-export-svg" />
          </div>
        )}
        {!sketch && mode === "model" && (
          <div className="toolbar" role="toolbar" aria-label="Modelling">
            <ToolButton icon="undo" label="Undo" onClick={d.undo} disabled={!d.canUndo} title="Undo (Ctrl+Z)" testId="undo" />
            <ToolButton icon="redo" label="Redo" onClick={d.redo} disabled={!d.canRedo} title="Redo (Ctrl+Shift+Z)" testId="redo" />
            <span className="sep" />
            <ToolMenu icon="sketch" label="Sketch" title="Start a sketch on a plane or a flat face" testId="tool-sketch">
              {(close) => (
                <>
                  {PLANES.map(([label, plane]) => (
                    <MenuItem
                      key={label}
                      icon={label.startsWith("Top") ? "top" : label.startsWith("Front") ? "front" : "right"}
                      label={label}
                      onClick={() => {
                        close();
                        startSketch(plane);
                      }}
                      testId={`plane-${label.split(" ")[0].toLowerCase()}`}
                    />
                  ))}
                  <MenuItem
                    icon="select"
                    label="On selected face"
                    hint="Click a flat face first"
                    onClick={() => {
                      close();
                      sketchOnFace();
                    }}
                    disabled={selection.faces.length !== 1}
                  />
                </>
              )}
            </ToolMenu>
            <span className="sep" />
            <ToolButton icon="extrude" label="Extrude" onClick={() => extrude("extrude")} title="Add material: push the selected (or latest) sketch out" testId="tool-extrude" />
            <ToolButton icon="cut" label="Cut" onClick={() => extrude("cut")} title="Remove material: cut the selected (or latest) sketch in" testId="tool-cut" />
            <ToolButton icon="hole" label="Hole" onClick={hole} title="Click a flat face, then Hole" testId="tool-hole" />
            <ToolButton icon="fillet" label="Fillet" onClick={() => edgeFeature("fillet")} title="Round edges: click edges (shift-click for more), then Fillet" testId="tool-fillet" />
            <ToolButton icon="chamfer" label="Chamfer" onClick={() => edgeFeature("chamfer")} title="Bevel edges: click edges (shift-click for more), then Chamfer" testId="tool-chamfer" />
            <span className="sep" />
            <ToolMenu icon="pattern" label="Pattern" title="Repeat the selected feature in a row or around an axis" testId="tool-pattern">
              {(close) => (
                <>
                  <MenuItem
                    icon="linearPattern"
                    label="Linear pattern"
                    hint="Copies in a row (or a grid)"
                    onClick={() => {
                      close();
                      patternFeature("linearPattern");
                    }}
                    testId="tool-linear-pattern"
                  />
                  <MenuItem
                    icon="circularPattern"
                    label="Circular pattern"
                    hint="Copies around an axis"
                    onClick={() => {
                      close();
                      patternFeature("circularPattern");
                    }}
                    testId="tool-circular-pattern"
                  />
                </>
              )}
            </ToolMenu>
            <ToolButton icon="mirror" label="Mirror" onClick={mirrorTool} title="Mirror the selected feature, or the clicked body, about a plane" testId="tool-mirror" />
            <span className="sep" />
            <ToolButton
              icon="combine"
              label="Combine"
              onClick={combine}
              disabled={(view?.bodies.length ?? 0) < 2}
              title={(view?.bodies.length ?? 0) < 2 ? "Combine needs two or more bodies" : "Join, subtract or intersect bodies"}
              testId="tool-combine"
            />
            <ToolButton icon="split" label="Split" onClick={splitTool} title="Cut the clicked body in two with a plane" testId="tool-split" />
            <ToolButton icon="move" label="Move" onClick={moveTool} title="Move, turn or copy the clicked body" testId="tool-move" />
            <ToolButton
              icon="deleteBody"
              label="Delete body"
              onClick={() => deleteBodyTool()}
              disabled={(view?.bodies.length ?? 0) < 2}
              title={(view?.bodies.length ?? 0) < 2 ? "A part needs at least one body" : "Delete the clicked body, or keep only some"}
              testId="tool-delete-body"
            />
            <span className="sep" />
            <ToolButton icon="member" label="Member" onClick={memberTool} title="A straight member of a weldment profile: another like the selected one, or pick a size in Sections" testId="tool-member" />
          </div>
        )}

        {notice && (
          <div className={`notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"} data-testid="notice">
            <span>{notice.text}</span>
            <button aria-label="Dismiss" onClick={() => setNotice(null)}>
              <Icon name="x" size={15} />
            </button>
          </div>
        )}

        <main className="workspace">
          {mode === "drawing" && !sketch ? (
            <>
              <aside className="side left">
                {doc && docDrawing ? (
                  <DrawingTree
                    doc={doc}
                    drawing={docDrawing}
                    sheet={sheet}
                    selected={drawingSel}
                    dispatch={d.dispatch}
                    onError={(text) => setNotice({ kind: "error", text })}
                    onSelect={(t) => setDrawingSel(t?.id ?? null)}
                    onAsk={sheetContext}
                  />
                ) : (
                  <section className="panel muted">
                    <p>This part has no drawing yet.</p>
                  </section>
                )}
              </aside>
              <section className="center sheet-center">
                {sheet ? (
                  <SheetView
                    sheet={sheet}
                    selected={drawingSel}
                    failed={failedIds}
                    onSelect={(t) => setDrawingSel(t?.id ?? null)}
                    onContext={sheetContext}
                    onMoveView={moveView}
                    onMoveAnnotation={moveAnnotation}
                  />
                ) : (
                  <div className="sheet-empty" data-testid="sheet-empty">
                    <p>Views of the part, dimensioned and ballooned from the rebuild, with its cut list and title block.</p>
                    <button className="primary" onClick={() => void newDrawing()} disabled={kernelState.phase !== "ready" || !view?.measurements} data-testid="drawing-new-empty">
                      New drawing
                    </button>
                  </div>
                )}
                {ask.previewDoc && (
                  <div className="preview-banner" data-testid="preview-banner">
                    Previewing the proposal
                  </div>
                )}
              </section>
              <aside className="side right">
                {doc && docDrawing ? (
                  <DrawingSide
                    doc={doc}
                    drawing={docDrawing}
                    sheet={sheet}
                    checks={drawingChecksNow}
                    selected={drawingSel}
                    dispatch={d.dispatch}
                    onError={(text) => setNotice({ kind: "error", text })}
                    onSelect={(t) => setDrawingSel(t?.id ?? null)}
                  />
                ) : (
                  <section className="panel">
                    <DrawingHelp />
                  </section>
                )}
              </aside>
            </>
          ) : (
          <>
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
            <NodesPanel doc={doc} dispatch={d.dispatch} onError={(text) => setNotice({ kind: "error", text })} sizes={sizeChoices} onPath={addPath} />
            <BodiesPanel
              measurements={view?.measurements ?? null}
              bodies={view?.bodies ?? []}
              hidden={hiddenBodies}
              onToggle={(name) =>
                setHiddenBodies((h) => {
                  const next = new Set(h);
                  if (next.has(name)) next.delete(name);
                  else next.add(name);
                  return next;
                })
              }
              onSelect={(b) => setSelection({ faces: Array.from({ length: b.faces[1] - b.faces[0] }, (_, i) => b.faces[0] + i), edges: [] })}
              onAsk={sketch ? undefined : (name, x, y) => openAsk({ kind: "body", name }, x, y)}
              onSelectMember={(id) => {
                setSelectedFeature(id);
                setRightTab("properties");
              }}
              materials={(doc?.bodyMaterials ?? {}) as Record<string, Material>}
              onMaterial={(body, material) => run({ type: "setBodyMaterial", body, material })}
              onDelete={(name) => deleteBodyTool(name)}
              onSave={saveBody}
            />
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
                  hiddenBodies={hiddenBodies}
                  nodes={shownNodes}
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
                  <button role="tab" aria-selected={rightTab === "properties"} onClick={() => setRightTab("properties")} data-testid="tab-properties">
                    Properties
                  </button>
                  <button role="tab" aria-selected={rightTab === "sections"} onClick={() => setRightTab("sections")} data-testid="tab-sections">
                    Sections
                  </button>
                  <button role="tab" aria-selected={rightTab === "cutlist"} onClick={() => setRightTab("cutlist")} data-testid="tab-cutlist">
                    Cut list
                  </button>
                  <button role="tab" aria-selected={rightTab === "document"} onClick={() => setRightTab("document")} data-testid="tab-document">
                    Document
                  </button>
                </div>
                {rightTab === "sections" ? (
                  <SectionsPanel
                    entries={library}
                    error={libraryError}
                    doc={doc}
                    density={density}
                    highlight={savedProfile}
                    onAddMember={addMember}
                    onFavourite={favourite}
                    onDelete={(e) => void removeSection(e)}
                    onUpdatePart={updateCopy}
                    onExport={exportSections}
                    onImport={(f) => void importSections(f)}
                  />
                ) : rightTab === "cutlist" ? (
                  <CutListPanel
                    doc={doc}
                    measurements={view?.measurements ?? null}
                    dispatch={d.dispatch}
                    onError={(text) => setNotice({ kind: "error", text })}
                    onSelect={(id) => {
                      setSelectedFeature(id);
                      setRightTab("properties");
                    }}
                    onDownload={(name, text) => download(name, text, "text/csv")}
                    fileBase={fileBase(view?.name ?? "part")}
                  />
                ) : rightTab === "properties" ? (
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
                        onProfileCard={setProfileCard}
                        frame={frameActions}
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
          </>
          )}
        </main>
        <AskPopover ask={ask} />
        {profileCard && doc && (
          <ProfileCard
            key={profileCard}
            doc={doc}
            sketchId={profileCard}
            library={library}
            onSave={(def, fav, prev) => void saveProfileCard(def, fav, prev)}
            onClose={() => setProfileCard(null)}
            onSuggest={suggestNames}
          />
        )}
        {ask.settingsOpen && <AskSettingsDialog settings={ask.settings} onSave={ask.setSettings} onClose={() => ask.setSettingsOpen(false)} />}
      </div>
    </ParametersContext.Provider>
  );
}

/** What to do first, when nothing is selected: the toolbar's tools, in the order a part is made. */
function Help() {
  const step = (icon: IconName, title: string, text: ReactNode) => (
    <li>
      <span className="help-icon">
        <Icon name={icon} />
      </span>
      <span>
        <strong>{title}</strong> {text}
      </span>
    </li>
  );
  return (
    <div className="help" data-testid="help">
      <h2>Getting started</h2>
      <ol className="help-steps">
        {step("sketch", "Sketch", <>on a plane or a flat face. Draw, click geometry to dimension it, then Finish sketch.</>)}
        {step("extrude", "Extrude or Cut", "the selected (or latest) sketch into a solid, or out of one.")}
        {step("hole", "Hole, Fillet, Chamfer", "on what you click: a flat face for a hole, edges (shift-click for more) for a fillet or chamfer.")}
        {step("pattern", "Pattern or Mirror", "the feature selected in the tree; Mirror, Split and Move work on the clicked body too.")}
        {step("member", "Member", "for weldments: tick Weldment profile on a sketch to add a section, then add members from Sections.")}
        {step("ask", "Right-click", "anything (a feature, face, edge, parameter, or empty space) to ask about it or describe a change.")}
      </ol>
      <p className="muted small">
        Select a feature in the tree to edit it. Every change can be undone (Ctrl+Z). Drop a part file, a drawing (PDF or image) or a photo of a part on the
        window to start from it. All lengths are in millimetres.
      </p>
    </div>
  );
}

/** Drawing mode before there is a drawing: what it will make, and how to work on it. */
function DrawingHelp() {
  const step = (icon: IconName, title: string, text: string) => (
    <li>
      <span className="help-icon">
        <Icon name={icon} />
      </span>
      <span>
        <strong>{title}</strong> {text}
      </span>
    </li>
  );
  return (
    <div className="help" data-testid="help">
      <h2>Drawings</h2>
      <ol className="help-steps">
        {step("drawing", "New drawing", "plans a sheet from the part: views, overall sizes, hole callouts, balloons and the cut list.")}
        {step("view", "Drag a view", "to place it; click a view or an annotation to edit it on the right.")}
        {step("ask", "Right-click", "a view or an annotation to ask for a change, like a missing dimension.")}
        {step("export", "Export PDF or SVG", "when the checks are all green.")}
      </ol>
      <p className="muted small">The sheet follows the model: change a size and the drawing updates.</p>
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


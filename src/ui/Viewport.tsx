import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import type { Vec2, Vec3 } from "../doc/types";
import { DEFAULT_DATUMS, type Datum } from "../features/datum";
import type { EdgeInfo, FaceInfo } from "../kernel";
import type { RebuildView } from "../worker/protocol";
import { CadControls } from "./cadControls";
import {
  DEFAULT_DISPLAY,
  DISPLAY_STYLES,
  loadView,
  nextViewName,
  pushView,
  removeNamedView,
  renameNamedView,
  saveNamedView,
  saveView,
  type CameraState,
  type DisplayState,
  type DisplayStyle,
  type NamedView,
} from "./evaluate/display";
import type { Dimension3D } from "./evaluate/dimensions3d";
import { allows, boxOf, boxSelect, FILTER_KINDS, NO_FILTER, type Projected, type SelectFilter } from "./evaluate/filter";
import { alongAxis, dragValue, type HandleSpec } from "./evaluate/handles";
import { activePlanes, cutsBody, offsetArrow, sectionPlane, setPlane, type SectionView } from "./evaluate/section";
import { Icon, type IconName } from "./icons";
import { inputPrefs, keyHint, pointer, useCommands, useInputPrefs } from "./input";
import { datumShapes, datumVisible, DEFAULT_DATUM_VIEW, DEFAULT_PLANES, type DatumShape, type DatumView } from "./model/datumDisplay";
import { describeDatum, describeEdge, describeFace, describeVertex, EMPTY_SELECTION, fmt, selectionText, vertexPoint, type PickTarget, type Selection, type VertexPick } from "./model/selection";
import { MenuItem, Popup } from "./tools";
import { DatumLayer, type DatumLabel } from "./viewport/datums";
import { EvalLayer, type EvalOverlay } from "./viewport/evalLayer";
import { areaZoom, blendRig, ease, framePoints, nearestToRay, poseOf, rigOf, rotationCentre, VIEW_GLIDE_MS, type CentreWhy, type Pose } from "./viewport/orbit";
import { SectionCaps, type CapSource } from "./viewport/sectionCaps";
import { clipMaterial, clipPlanesOf, SectionPlanes } from "./viewport/sectionLayer";
import { nextBehind, otherLabel, underPointer, type UnderPointer } from "./viewport/selectOther";
import { adjacency, silhouette, type Adjacency } from "./viewport/silhouette";
import { Triad, ViewCube, type CubeTurn } from "./viewport/viewCube";
import { reducedMotion, setViewPrefs, useViewPrefs, viewPrefs } from "./viewport/viewPrefs";
import { triadView, upFor, VIEW_LABEL, VIEW_ORDER, VIEWS, type ViewName } from "./viewport/views";

export type { ViewName } from "./viewport/views";

// What a click picks and what is selected: plain data, in a pure module (src/ui/model/selection.ts).
export { EMPTY_SELECTION, type PickTarget, type Selection } from "./model/selection";
export type { EvalOverlay } from "./viewport/evalLayer";

/** A photo pinned under the part on XY (spec 5.3): pixel x along +X, pixel y along -Y. Never geometry. */
export interface Underlay {
  /** The image, as a data URL. */
  url: string;
  width: number;
  height: number;
  /** The photo pixel at the model origin. */
  origin: Vec2;
  mmPerPx: number;
  scale: { from: Vec2; to: Vec2; confirmed: boolean };
  opacity: number;
}

/** A handle being dragged: which, and the value it gives now. */
export type HandlePhase = "start" | "move" | "end" | "cancel";

interface Props {
  view: RebuildView | null;
  /** Bump to re-frame the camera on the current model. */
  fitToken: number;
  selection: Selection;
  /** A click on the part (target) or on empty space (null). `additive` when Ctrl, Shift or Cmd is held: the target goes in or out of the selection. */
  onPick(target: PickTarget | null, additive: boolean): void;
  /** A right-click (press and release without dragging): what is under the cursor, and where. */
  onContext?(target: PickTarget | null, clientX: number, clientY: number): void;
  underlay?: Underlay | null;
  /** While set, a click on the photo reports the pixel clicked instead of picking the part. */
  onPhotoPoint?: ((px: Vec2) => void) | null;
  /** Bodies not drawn (and not picked). */
  hiddenBodies?: ReadonlySet<string>;
  /** A frame's nodes (Phase J), drawn as labelled points with the sketches. */
  nodes?: FrameNode[];
  /** A short note for the user (a view command that needs a selection, say). */
  onMessage?(text: string): void;
  /** Set by the view: runs one of its commands ("view.fit", "view.normal", "view.top"…), for the right-click menu; `at` is where it was asked (Select Other lists what is under it). */
  commandsRef?: { current: ((id: string, at?: { x: number; y: number }) => void) | null };
  /** What is shown of the reference geometry (planes, axes, points, the origin): view state, kept by the app. */
  datumView?: DatumView;
  /** The "Planes" toggle (and its key): every plane, axis and point shown or hidden. */
  onDatumView?(next: DatumView): void;
  /** How the part is drawn: display style and perspective (view state, kept by the app per document). */
  display?: DisplayState;
  onDisplay?(next: DisplayState): void;
  /** The document's name: the camera is remembered under it in this browser, and comes back when the view does. */
  memoryKey?: string;
  /** The section view (null: none set up; off: set up but not shown). */
  section?: SectionView | null;
  /** The section changed in the view: a plane's arrow dragged (live), its label clicked (that plane to the panel). */
  onSection?(next: SectionView): void;
  /** The view bar's Section toggle: on or off, or set up when there is none. */
  onSectionToggle?(): void;
  /** Show the section's panel (its tag clicked, an arrow's value clicked). */
  onSectionPanel?(): void;
  /** The Evaluate tools' marks: measured lines, points, the centre of mass. */
  overlay?: EvalOverlay | null;
  /** A feature's dimensions shown on the model; a double-click on one asks to edit it. */
  dims?: Dimension3D[];
  onDimension?(d: Dimension3D, clientX: number, clientY: number): void;
  /** Drag handles (direct manipulation), and what dragging one does: start, the value as it moves, end or cancel. */
  handles?: HandleSpec[];
  onHandle?(h: HandleSpec, phase: HandlePhase, value: number): void;
  /** A click on a handle's value: type one there. */
  onHandleLabel?(h: HandleSpec, clientX: number, clientY: number): void;
  /** The selection filter: only these kinds are picked (empty: anything). */
  filter?: SelectFilter;
  onFilter?(next: SelectFilter): void;
  /** A box dragged over the view (left drag on empty space): what it selected, and whether Ctrl or Shift was held. */
  onBox?(sel: Selection, additive: boolean): void;
  /** A double-click on the part (or empty space: null). */
  onDoubleClick?(target: PickTarget | null): void;
}

export interface FrameNode {
  name: string;
  at: Vec3;
}

const NO_NODES: FrameNode[] = [];
const NO_DIMS: Dimension3D[] = [];
const NO_HANDLES: HandleSpec[] = [];

/** Body colours, in the order bodies are made, for a part of more than one. */
export const BODY_COLORS = ["#c4cad3", "#8fb8e3", "#e3b98f", "#a9d39f", "#d3a9d6", "#e09c9c", "#94d1cf", "#d6cf96"];

const SKETCH_OPACITY = 0.55;
const PICK_PIXELS = 6;
/** How near (pixels) to the end of an edge a click picks the vertex there. */
const VERTEX_PIXELS = 8;
const SELECT_COLOR = 0xf28c28;
const HOVER_COLOR = 0x2f7bff;
const SCALE_COLOR = 0xe8590c;
const SCALE_CONFIRMED_COLOR = 0x2b8a3e;
/** Pixels of pointer travel before a left press becomes a box. */
const BOX_SLOP = 5;

interface Hover {
  x: number;
  y: number;
  target: PickTarget;
}

// The standard views (where each looks from, which way is up) are in src/ui/viewport/views.ts.
const VIEW_ICON: Record<ViewName, IconName> = { front: "front", back: "front", left: "right", right: "right", top: "top", bottom: "top", iso: "iso", dimetric: "iso", trimetric: "iso" };
/** The quick buttons under the view. */
const QUICK_VIEWS: ViewName[] = ["iso", "top", "front", "right"];
const FILTER_ICON: Record<string, IconName> = { faces: "filterFaces", edges: "filterEdges", vertices: "filterVertices", planes: "filterPlanes" };

/** Reads a CSS custom property so the scene follows the page theme. */
function cssColor(el: Element, name: string, fallback: string): THREE.Color {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return new THREE.Color(v || fallback);
}

interface ViewportApi {
  setModel(view: RebuildView | null): void;
  /** The reference geometry shown (already filtered), and the origin triad's arm length (null: hidden). */
  setDatums(shapes: DatumShape[], originSize: number | null): void;
  setHiddenBodies(hidden: ReadonlySet<string>): void;
  setSelection(sel: Selection): void;
  setSketchesVisible(visible: boolean): void;
  setNodes(nodes: FrameNode[]): void;
  setUnderlay(u: Underlay | null): void;
  /** See the photo through the part (while picking points on it). */
  setGhost(ghost: boolean): void;
  /** Frame the whole photo from above. */
  fitPhoto(): void;
  fit(dir?: Vec3, up?: Vec3): void;
  /** Square to a face: from its outside, or from behind if already looking at it. */
  normalTo(normal: Vec3): void;
  /** Frames the part from a standard view (gliding, unless `instant`); a standard view unpins the rotation centre. */
  orient(name: ViewName, instant?: boolean): void;
  /** Keyboard view moves: degrees (about the rotation centre), pixels, a zoom factor. */
  turn(yawDeg: number, pitchDeg: number): void;
  pan(dx: number, dy: number): void;
  zoom(factor: number): void;
  roll(deg: number): void;
  /** How the part is drawn. */
  setDisplay(d: DisplayState): void;
  setSection(s: SectionView | null): void;
  setOverlay(o: EvalOverlay | null): void;
  setDims(d: Dimension3D[]): void;
  setHandles(h: HandleSpec[]): void;
  setFilter(f: SelectFilter): void;
  /** Frames what is selected, from where the camera is. False when nothing is selected. */
  zoomToSelection(sel: Selection): boolean;
  /** Back to the view before this one. False when there is none. */
  previousView(): boolean;
  /** The camera now, to save under a name. */
  camera(): CameraState;
  /** Glides to a saved camera. */
  goTo(c: CameraState): void;
  /** A view cube click or arrow, or a triad click. */
  look(dir: Vec3, up: Vec3): void;
  cubeTurn(kind: CubeTurn): void;
  /** Zoom to area: the next left-drag draws the area (true), or not. */
  setAreaMode(on: boolean): void;
  /** Every face and edge under these client pixels, nearest first (Select Other). */
  under(clientX: number, clientY: number): UnderPointer[];
  /** Lights one up while the Select Other list is hovered (null: none). */
  preview(t: PickTarget | null): void;
  /** Clears the pinned rotation centre. */
  unpin(): void;
  setCubeVisible(v: boolean): void;
  dispose(): void;
}

const NO_BODIES: ReadonlySet<string> = new Set();
const NO_PLANES: THREE.Plane[] = [];

export function Viewport({
  view,
  fitToken,
  selection,
  onPick,
  onContext,
  underlay = null,
  onPhotoPoint = null,
  hiddenBodies = NO_BODIES,
  nodes = NO_NODES,
  onMessage,
  commandsRef,
  datumView = DEFAULT_DATUM_VIEW,
  onDatumView,
  display = DEFAULT_DISPLAY,
  onDisplay,
  memoryKey = "",
  section = null,
  onSection,
  onSectionToggle,
  onSectionPanel,
  overlay = null,
  dims = NO_DIMS,
  onDimension,
  handles = NO_HANDLES,
  onHandle,
  onHandleLabel,
  filter = NO_FILTER,
  onFilter,
  onBox,
  onDoubleClick,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<ViewportApi | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const contextRef = useRef(onContext);
  contextRef.current = onContext;
  const photoPointRef = useRef(onPhotoPoint);
  photoPointRef.current = onPhotoPoint;
  // Read by the view's own listeners, which are made once: always the newest.
  const live = useRef({ onHandle, onHandleLabel, onDimension, onBox, onDoubleClick, memoryKey, onMessage, onSection, onSectionPanel, section, onArea: (on: boolean) => setAreaMode(on), onPinned: (on: boolean) => setPinned(on) });
  live.current = { onHandle, onHandleLabel, onDimension, onBox, onDoubleClick, memoryKey, onMessage, onSection, onSectionPanel, section, onArea: (on: boolean) => setAreaMode(on), onPinned: (on: boolean) => setPinned(on) };
  const [hover, setHover] = useState<Hover | null>(null);
  const [showSketches, setShowSketches] = useState(true);
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number; crossing: boolean; area?: boolean } | null>(null);
  /** Zoom to area is waiting for its box. */
  const [areaMode, setAreaMode] = useState(false);
  /** Select Other's list, at the pointer. */
  const [others, setOthers] = useState<{ x: number; y: number; list: UnderPointer[] } | null>(null);
  /** A rotation centre is pinned (a middle-click on the part). */
  const [pinned, setPinned] = useState(false);
  const infoRef = useRef<{ faces: FaceInfo[]; edges: EdgeInfo[]; datums: Record<string, Datum> }>({ faces: [], edges: [], datums: {} });
  infoRef.current = { faces: view?.faces ?? [], edges: view?.edges ?? [], datums: view?.datums ?? {} };
  /** The camera as it is when the view mounts: none remembered, or the one this document's view was left at. */
  const restoredAtMount = useRef(false);

  useEffect(() => {
    const el = host.current!;
    // A stencil buffer for the section view's caps.
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, stencil: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.localClippingEnabled = true;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
    camera.up.set(0, 0, 1);
    // Orthographic view: the same eye, target and up as the perspective camera (which the controls move),
    // its frame the size the perspective one sees at the target. Zoom, pan and rotate work the same either way.
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    let perspective = DEFAULT_DISPLAY.perspective;
    /** The camera that draws and picks: perspective or orthographic. */
    const eye = (): THREE.PerspectiveCamera | THREE.OrthographicCamera => (perspective ? camera : ortho);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x6f7480, 1.1);
    hemi.position.set(0, 0, 1); // sky is +Z in this Z-up scene
    scene.add(hemi);
    // Key and fill are in camera space (x right, y up, z toward the viewer), so
    // lighting follows the view: faces that point up-screen read brightest.
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(0.35, 1, 0.55);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-0.8, -0.3, 0.6);
    // Their targets ride with the camera too, so the light comes from the same side of the view however near the
    // eye is to the part (zoomed in, or orthographic, where the eye's place along the line of sight is arbitrary).
    camera.add(key, fill, key.target, fill.target);
    scene.add(camera);

    const model = new THREE.Group();
    const overlays = new THREE.Group();
    const helpers = new THREE.Group();
    const marks = new THREE.Group(); // hover and selection highlights
    const photoGroup = new THREE.Group(); // the pinned photo and its scale line
    const nodeGroup = new THREE.Group(); // a frame's nodes
    // Planes, axes, points and the origin triad.
    const datums = new DatumLayer({ plane: 0x4f7fbf, border: 0x3a6aa6, axis: 0x3a4a63, point: 0x2f4f7f, select: SELECT_COLOR, hover: HOVER_COLOR });
    // The section's caps and drawn planes, and the Evaluate tools' marks, handles and labels.
    const capColor = cssColor(el, "--section-cap", "#e9a23b");
    const capHatch = cssColor(el, "--section-hatch", "#9a5b10");
    const caps = new SectionCaps();
    const sectionPlanes = new SectionPlanes({ fill: cssColor(el, "--section-plane", "#3a8dde"), border: cssColor(el, "--section-plane-border", "#2f74c0"), active: cssColor(el, "--section-plane-active", "#1c64b8") });
    const evalLayer = new EvalLayer(el, {
      onDimension: (d, x, y) => live.current.onDimension?.(d, x, y),
      onHandleLabel: (h, x, y) => (h.kind === "section" ? sectionLabel(h) : live.current.onHandleLabel?.(h, x, y)),
    });
    scene.add(helpers, photoGroup, model, datums.group, caps.group, sectionPlanes.group, overlays, marks, nodeGroup, evalLayer.group);
    let photoMesh: THREE.Mesh | null = null;
    let photo: Underlay | null = null;
    let photoTexture: { url: string; texture: THREE.Texture } | null = null;

    let mesh: THREE.Mesh | null = null;
    /** Every edge, body by body (a material each, so a section can leave a body whole). */
    let edgeLines: THREE.LineSegments | null = null;
    /** The edges again, dashed, drawn only where they are hidden (Hidden lines visible). */
    let hiddenLines: THREE.LineSegments | null = null;
    /** Which body each of the edge lines' material groups is. */
    let edgeGroupBodies: (string | undefined)[] = [];
    /** The outlines of curved faces, for the line styles; recomputed as the view turns. Two when a section leaves some bodies whole: the cut bodies', the others'. */
    let outlines: { adj: Adjacency; seen: THREE.LineSegments; hidden: THREE.LineSegments; cut: boolean }[] = [];
    /** The section's bodies when the outlines were made (they split by it). */
    let outlineCutKey = "";
    /** Segment index -> B-rep edge index, for the drawn (non-seam) edges. */
    let segmentEdge: Int32Array = new Int32Array(0);
    let faceRanges: { start: number; count: number }[] = [];
    let edgeRanges: { start: number; count: number }[] = [];
    let edgeSegments: Float32Array = new Float32Array(0);
    let selection: Selection = EMPTY_SELECTION;
    let hovered: PickTarget | null = null;
    /** The row of Select Other's list under the pointer (shown through what is in front of it). */
    let peek: PickTarget | null = null;
    /** One end of an edge per vertex of the part (the lowest edge that ends there stands for it), for picking vertices. */
    let vertices: (VertexPick & { p: Vec3 })[] = [];
    let shownView: RebuildView | null = null;
    let hidden: ReadonlySet<string> = NO_BODIES;
    /** Per mesh vertex: the index of its body (as in view.bodies; 0 for a part of one), or −1 in a hidden body. */
    let vertexBody: Int16Array = new Int16Array(0);
    /** The visible bodies' bounding box: what a rotation turns about while it is on screen, and what Fit frames. */
    let visibleBox: THREE.Box3 | null = null;
    let style: DisplayStyle = DEFAULT_DISPLAY.style;
    let pickFilter: SelectFilter = NO_FILTER;
    let handleList: HandleSpec[] = [];
    /** The section view, and its active planes as three clips with them (keeps where the distance is ≥ 0): the same array while only their numbers change. */
    let sectionState: SectionView | null = null;
    let clipPlanes: THREE.Plane[] = [];
    /** The planes that clip this body: none for a body the section leaves whole. */
    const clipFor = (body: string | undefined): THREE.Plane[] => (cutsBody(sectionState, body) ? clipPlanes : NO_PLANES);
    /** Is this face or edge in a hidden body? */
    const isHidden = (body: string | undefined) => body !== undefined && hidden.has(body);
    /** The active planes' equations (normal into the cut side; normal·p > c is cut), for testing points quickly. */
    let cutTests: { n: Vec3; c: number }[] = [];
    /** Is this point cut away by the section (on the cut side of every active plane, in a body it cuts)? Same rule as cutAwayBy. */
    const cutAway = (p: THREE.Vector3 | Vec3, body?: string) => {
      if (!cutTests.length || !cutsBody(sectionState, body)) return false;
      const [x, y, z] = Array.isArray(p) ? p : [p.x, p.y, p.z];
      return cutTests.every((t) => t.n[0] * x + t.n[1] * y + t.n[2] * z - t.c > 1e-6);
    };
    const bodyName = (i: number): string | undefined => shownView?.bodies?.[i]?.name;

    let radius = 50;
    let center = new THREE.Vector3();

    // Node labels are HTML over the canvas, moved after every render.
    const labels = document.createElement("div");
    labels.className = "node-labels";
    el.appendChild(labels);
    let nodeList: FrameNode[] = [];
    const placeLabels = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      nodeList.forEach((n, i) => {
        const tag = labels.children[i] as HTMLElement | undefined;
        if (!tag) return;
        const v = new THREE.Vector3(...n.at).project(eye());
        const shown = overlays.visible && v.z < 1;
        tag.style.display = shown ? "" : "none";
        tag.style.transform = `translate(${((v.x + 1) / 2) * w + 6}px, ${((1 - v.y) / 2) * h - 18}px)`;
      });
    };
    // The datums' names are HTML over the canvas too.
    const datumTags = document.createElement("div");
    datumTags.className = "datum-labels";
    el.appendChild(datumTags);
    let datumLabels: DatumLabel[] = [];
    const placeDatumLabels = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      datumLabels.forEach((l, i) => {
        const tag = datumTags.children[i] as HTMLElement | undefined;
        if (!tag) return;
        const v = new THREE.Vector3(...l.at).project(eye());
        tag.style.display = v.z < 1 ? "" : "none";
        tag.style.transform = `translate(${((v.x + 1) / 2) * w + 4}px, ${((1 - v.y) / 2) * h - 16}px)`;
      });
    };
    const relabelDatums = () => {
      datumLabels = datums.labels();
      datumTags.replaceChildren(
        ...datumLabels.map((l) => {
          const tag = document.createElement("span");
          tag.className = l.className;
          tag.textContent = l.text;
          tag.dataset.datum = l.key;
          return tag;
        }),
      );
    };

    /** The orthographic camera moved to where the perspective one is, framing what it frames at the target. */
    const syncOrtho = () => {
      const dist = camera.position.distanceTo(controls.target);
      const halfH = dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const halfW = halfH * camera.aspect;
      ortho.left = -halfW;
      ortho.right = halfW;
      ortho.top = halfH;
      ortho.bottom = -halfH;
      ortho.position.copy(camera.position);
      ortho.quaternion.copy(camera.quaternion);
      ortho.up.copy(camera.up);
      // Nothing of the part is cut off in front of the eye, however close it is.
      const reach = Math.max(radius, 1) * 20 + center.distanceTo(controls.target);
      ortho.near = -reach;
      ortho.far = dist + reach;
      ortho.updateProjectionMatrix();
      ortho.updateMatrixWorld();
    };

    /** The outline of the curved faces as seen now (line styles only). */
    const updateOutline = () => {
      const want = style === "hiddenRemoved" || style === "hiddenVisible" || style === "wireframe";
      const look = controls.target.clone().sub(camera.position).normalize();
      for (const outline of outlines) {
        outline.seen.visible = want;
        outline.hidden.visible = want && style === "hiddenVisible";
        if (!want) continue;
        const segs = silhouette(outline.adj, perspective ? (camera.position.toArray() as Vec3) : null, look.toArray() as Vec3);
        for (const obj of [outline.seen, outline.hidden]) {
          obj.geometry.setAttribute("position", new THREE.BufferAttribute(segs, 3));
          obj.geometry.computeBoundingSphere();
        }
        outline.hidden.computeLineDistances();
      }
    };

    const render = () => {
      if (!perspective) syncOrtho();
      updateOutline();
      renderer.render(scene, eye());
      evalLayer.update(eye(), controls.worldPerPixel(), el.clientWidth, el.clientHeight);
      placeLabels();
      placeDatumLabels();
      cube.update(camera);
      triad.update(camera);
      settleSoon();
    };

    // The camera, once it has stopped moving: remembered for this document, and kept for Previous view.
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let history: CameraState[] = [];
    const cameraState = (): CameraState => ({ position: camera.position.toArray() as Vec3, target: controls.target.toArray() as Vec3, up: camera.up.toArray() as Vec3 });
    const settleSoon = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        const cam = cameraState();
        history = pushView(history, cam);
        if (live.current.memoryKey && mesh) saveView(live.current.memoryKey, { camera: cam });
      }, 400);
    };
    const poseOfCamera = (c: CameraState): Pose | null => {
      const target = new THREE.Vector3(...c.target);
      if (new THREE.Vector3(...c.position).distanceTo(target) < 1e-9) return null;
      return { position: new THREE.Vector3(...c.position), target, up: new THREE.Vector3(...c.up) };
    };
    const restoreCamera = (c: CameraState, instant = false) => {
      const p = poseOfCamera(c);
      if (p) glideTo(p, instant);
    };

    // View changes glide (Settings > Mouse, on by default; never with the system's reduce motion): the orientation
    // turns the short way round, the target and distance ease. In the automated tests they jump, unless a test
    // turns gliding on through the hook (and it can finish one at once).
    const automated = new URLSearchParams(location.search).has("e2e");
    let testGlides = false;
    /** How long a glide takes (a test may slow it down, to see it partway on a slow machine). */
    let glideMs = VIEW_GLIDE_MS;
    let glideAnim: { at: (t: number) => Pose; frame: number } | null = null;
    const glides = () => viewPrefs().animate && !reducedMotion() && (!automated || testGlides);
    /** Ends a glide now, at the view it was going to. */
    const finishGlide = () => {
      if (!glideAnim) return;
      const a = glideAnim;
      glideAnim = null;
      cancelAnimationFrame(a.frame);
      controls.setPose(a.at(1));
    };
    /** Moves the camera through at(t) for t from 0 to 1 (eased), or straight to at(1). */
    const glide = (at: (t: number) => Pose, instant = false) => {
      finishGlide();
      if (instant || !glides()) return controls.setPose(at(1));
      const start = performance.now();
      const step = () => {
        if (!glideAnim) return;
        const t = Math.min(1, (performance.now() - start) / glideMs);
        if (t >= 1) {
          glideAnim = null;
          controls.setPose(at(1));
          return;
        }
        controls.setPose(at(ease(t)));
        glideAnim.frame = requestAnimationFrame(step);
      };
      glideAnim = { at, frame: requestAnimationFrame(step) };
    };
    /** Glides from the camera now to `to`, ending exactly there. */
    const glideTo = (to: Pose, instant = false) => {
      const a = rigOf(controls.pose());
      const b = rigOf(to);
      glide((t) => (t >= 1 ? to : poseOf(blendRig(a, b, t))), instant);
    };

    // The pinned rotation centre: a ring round a dot, the same size at any zoom, drawn over the part.
    const pivotGroup = new THREE.Group();
    scene.add(pivotGroup);
    const pivotTexture = (() => {
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      const g = c.getContext("2d");
      if (!g) return null;
      g.lineWidth = 7;
      g.strokeStyle = "rgba(255,255,255,0.95)";
      g.beginPath();
      g.arc(32, 32, 20, 0, Math.PI * 2);
      g.stroke();
      g.lineWidth = 4;
      g.strokeStyle = "#1c64b8";
      g.beginPath();
      g.arc(32, 32, 20, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = "#1c64b8";
      g.beginPath();
      g.arc(32, 32, 6.5, 0, Math.PI * 2);
      g.fill();
      g.lineWidth = 2.5;
      g.strokeStyle = "#fff";
      g.stroke();
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();

    // What the last rotation turned about, and why (for the tests).
    let lastCentre: { point: THREE.Vector3; why: CentreWhy } | null = null;
    /** The centre a rotation starting now turns about: the pinned point, the visible part's middle while it is mostly on screen, else the part under the middle of the view (or the nearest point of it). */
    const centreNow = (): THREE.Vector3 => {
      if (!perspective) syncOrtho();
      const cam = eye();
      cam.updateMatrixWorld();
      const rect = renderer.domElement.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const r = rotationCentre({
        camera: cam,
        box: visibleBox,
        pinned: controls.pinned,
        underCentre: () => {
          aim(cx, cy);
          const hit = pickPart(cx, cy, true);
          return hit ? new THREE.Vector3(...hit.target.point) : null;
        },
        nearestToCentre: () => {
          const pos = mesh?.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
          if (!pos) return null;
          aim(cx, cy);
          const arr = pos.array as ArrayLike<number>;
          return nearestToRay(arr, raycaster.ray.origin, raycaster.ray.direction, {
            ahead: perspective,
            keep: (i) => vertexBody[i] >= 0 && !cutAway([arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]], bodyName(vertexBody[i])),
          });
        },
        fallback: controls.target,
      });
      lastCentre = r;
      return r.point;
    };

    // The view cube (top right) and the orientation triad (bottom left), turning with the camera.
    const cube = new ViewCube(el, {
      pick: (t) => look(t.dir, t.up),
      turn: (kind) => cubeTurn(kind),
      home: () => orient("iso"),
    });
    cube.setVisible(viewPrefs().viewCube);
    const triad = new Triad(el, (axis) => {
      const v = triadView(axis, camera.position.clone().sub(controls.target).toArray() as Vec3);
      look(v.dir, v.up);
    });

    const controls = new CadControls(camera, renderer.domElement, {
      pick: (x, y) => {
        const t = pickAt(x, y, true);
        return t && t.kind !== "datum" ? new THREE.Vector3(...t.point) : null;
      },
      fit: () => fit(),
      showPivot: (p) => {
        disposeGroup(pivotGroup);
        if (p) {
          const g = new THREE.BufferGeometry().setFromPoints([p]);
          const dot = new THREE.Points(g, new THREE.PointsMaterial({ map: pivotTexture ?? undefined, color: pivotTexture ? 0xffffff : 0x1c64b8, size: 22, sizeAttenuation: false, depthTest: false, transparent: true }));
          dot.renderOrder = 11;
          pivotGroup.add(dot);
        }
        live.current.onPinned(!!p);
        render();
      },
      centre: centreNow,
      interrupt: finishGlide,
      changed: render,
    });
    controls.orthographic = !perspective;

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = el;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      for (const m of fatMaterials) m.resolution.set(w, h);
      datums.resize(w, h);
      evalLayer.resize(w, h);
      sectionPlanes.resize(w, h);
      render();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const disposeGroup = (g: THREE.Group) => {
      for (const child of [...g.children]) {
        g.remove(child);
        child.traverse((o) => {
          const obj = o as THREE.Mesh;
          obj.geometry?.dispose();
          const mat = obj.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else if (mat && !fatMaterials.includes(mat as LineMaterial)) mat.dispose();
        });
      }
    };

    // Fat lines for the selection and the hover, and the photo's scale line. The selection's and hover's come twice:
    // clipped by the section, and whole (for an edge of a body the section leaves whole).
    const fatMaterials = [SELECT_COLOR, HOVER_COLOR, SCALE_COLOR, SCALE_CONFIRMED_COLOR, SELECT_COLOR, HOVER_COLOR].map(
      (color) => new LineMaterial({ color, linewidth: 3.5, depthTest: false, transparent: true }),
    );
    const [selectEdgeMat, hoverEdgeMat, scaleMat, scaleConfirmedMat, selectEdgeWhole, hoverEdgeWhole] = fatMaterials;

    const rebuildHelpers = () => {
      disposeGroup(helpers);
      const size = Math.max(10, 10 ** Math.ceil(Math.log10(radius * 2.5)));
      const grid = new THREE.GridHelper(size, 20, cssColor(el, "--grid-major", "#b7bcc6"), cssColor(el, "--grid-minor", "#d9dce2"));
      grid.rotation.x = Math.PI / 2; // into the XY plane
      grid.visible = !photo; // the photo is the backdrop instead
      (grid.material as THREE.Material).transparent = true;
      (grid.material as THREE.Material).opacity = 0.7;
      helpers.add(grid);
      // The origin's triad is drawn with the reference geometry (the datum layer).
    };

    type Frame = { center: THREE.Vector3; radius: number } | { points: ArrayLike<number> };
    /**
     * The camera that frames the part (or `on`: a sphere, or points) from `dir`, or from where the camera looks
     * now: tight on what you see from there (the visible bodies' own outline, not a sphere round them).
     */
    const framed = (dir?: Vec3, on?: Frame, up?: Vec3): Pose => {
      const d = new THREE.Vector3(...(dir ?? (camera.position.clone().sub(controls.target).toArray() as Vec3)));
      if (d.lengthSq() === 0) d.set(...VIEWS.iso.dir);
      d.normalize();
      // Looking straight down or up, +Y is up the screen (-Y from below); otherwise +Z.
      const u = new THREE.Vector3(...(up ?? (dir ? upFor(d.toArray() as Vec3) : (camera.up.toArray() as Vec3))));
      const sphere = (c: THREE.Vector3, r: number): Pose => {
        const dist = (r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.15;
        return { position: c.clone().addScaledVector(d, dist), target: c.clone(), up: u };
      };
      if (on && "center" in on) return sphere(on.center, on.radius);
      const pos = mesh?.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
      const pts = on ? on.points : (pos?.array as ArrayLike<number> | undefined);
      const f = pts ? framePoints(pts, d, u, camera.aspect, camera.fov, { perspective, keep: on ? undefined : (i) => vertexBody[i] >= 0 }) : null;
      if (!f) return sphere(center, radius);
      return { position: f.target.clone().addScaledVector(d, f.dist), target: f.target, up: u };
    };
    /** Frames the part (or `on`) from `dir`, or from where the camera is now: gliding there unless `instant`. */
    const fit = (dir?: Vec3, on?: Frame, up?: Vec3, instant = false) => glideTo(framed(dir, on, up), instant);
    /** A standard view: from its direction, the part fitted; it unpins the rotation centre. */
    const orient = (name: ViewName, instant = false) => {
      controls.pin(null);
      fit(VIEWS[name].dir, undefined, VIEWS[name].up, instant);
    };
    /** A view cube or triad click: look from `dir` with this up, the part fitted (a standard view: unpins). */
    const look = (dir: Vec3, up: Vec3) => {
      controls.pin(null);
      fit(dir, undefined, up);
    };
    /** Turns about the rotation centre (degrees), gliding: the arrow keys, the cube's arrows. */
    const turnBy = (yawDeg: number, pitchDeg: number) => {
      finishGlide();
      const c = centreNow();
      const start = controls.pose();
      const yaw = THREE.MathUtils.degToRad(yawDeg);
      const pitch = THREE.MathUtils.degToRad(pitchDeg);
      glide((t) => controls.turned(yaw * t, pitch * t, c, start));
    };
    const rollBy = (deg: number) => {
      finishGlide();
      const start = controls.pose();
      const a = THREE.MathUtils.degToRad(deg);
      glide((t) => controls.rolled(a * t, start));
    };
    const cubeTurn = (kind: CubeTurn) => {
      if (kind === "left") turnBy(90, 0);
      else if (kind === "right") turnBy(-90, 0);
      else if (kind === "up") turnBy(0, 90);
      else if (kind === "down") turnBy(0, -90);
      else rollBy(kind === "ccw" ? 90 : -90);
    };

    /** Triangles of some faces, sharing the part's vertex buffer. */
    const faceGeometry = (indices: number[]) => {
      if (!mesh || indices.length === 0) return null;
      const src = mesh.geometry;
      const all = src.getIndex()!.array as Uint32Array;
      const parts = indices.filter((i) => faceRanges[i]).map((i) => all.subarray(faceRanges[i].start, faceRanges[i].start + faceRanges[i].count));
      const merged = new Uint32Array(parts.reduce((t, p) => t + p.length, 0));
      let at = 0;
      for (const p of parts) {
        merged.set(p, at);
        at += p.length;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", src.getAttribute("position"));
      g.setAttribute("normal", src.getAttribute("normal"));
      g.setIndex(new THREE.BufferAttribute(merged, 1));
      return g;
    };
    /** Splits faces or edges by whether the section cuts their body. */
    const byCut = (indices: number[], bodyOf: (i: number) => string | undefined): [number[], number[]] => {
      const cut: number[] = [];
      const whole: number[] = [];
      for (const i of indices) (cutsBody(sectionState, bodyOf(i)) ? cut : whole).push(i);
      return [cut, whole];
    };
    const faceBody = (i: number) => shownView?.faces[i]?.body;
    const edgeBody = (i: number) => shownView?.edges[i]?.body;
    /** Faces lit up (selected, hovered), clipped with their bodies; `xray`: seen through whatever is in front (Select Other's list). */
    const faceMesh = (indices: number[], color: number, opacity: number, xray = false) => {
      const group = new THREE.Group();
      byCut(indices, faceBody).forEach((list, k) => {
        const g = faceGeometry(list);
        if (!g) return;
        const m = new THREE.Mesh(
          g,
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, depthTest: !xray, side: xray ? THREE.DoubleSide : THREE.FrontSide, clippingPlanes: k === 0 ? clipPlanes : NO_PLANES, clipIntersection: clipPlanes.length > 1 }),
        );
        m.renderOrder = xray ? 8 : 4;
        group.add(m);
      });
      return group.children.length ? group : null;
    };

    /** Fat lines along some B-rep edges (`whole`: the material for edges of bodies the section leaves whole). */
    const edgeMarks = (indices: number[], material: LineMaterial, whole: LineMaterial) => {
      const group = new THREE.Group();
      byCut(indices, edgeBody).forEach((list, k) => {
        const pts: number[] = [];
        for (const i of list) {
          const r = edgeRanges[i];
          if (!r) continue;
          for (let n = r.start * 6; n < (r.start + r.count) * 6; n++) pts.push(edgeSegments[n]);
        }
        if (pts.length === 0) return;
        const g = new LineSegmentsGeometry();
        g.setPositions(pts);
        const line = new LineSegments2(g, k === 0 ? material : whole);
        line.renderOrder = 5;
        group.add(line);
      });
      return group.children.length ? group : null;
    };

    /** Dots on vertices (selected, or the one under the pointer). */
    const vertexDots = (points: Vec3[], color: number, size: number) => {
      if (!points.length) return null;
      const g = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(...p)));
      // A section that leaves some bodies whole doesn't clip the dots (picking already skips what is cut away).
      const planes = sectionState?.bodies ? NO_PLANES : clipPlanes;
      const dots = new THREE.Points(g, new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false, clippingPlanes: planes, clipIntersection: planes.length > 1 }));
      dots.renderOrder = 6;
      return dots;
    };

    const redrawMarks = () => {
      disposeGroup(marks);
      const edges = shownView?.edges ?? [];
      const pickedVertices = (selection.vertices ?? []).map((v) => vertexPoint(v, edges)).filter((p): p is Vec3 => !!p);
      const sel = [faceMesh(selection.faces, SELECT_COLOR, 0.45), edgeMarks(selection.edges, selectEdgeMat, selectEdgeWhole), vertexDots(pickedVertices, SELECT_COLOR, 10)];
      const hov =
        hovered?.kind === "face" && !selection.faces.includes(hovered.index)
          ? faceMesh([hovered.index], HOVER_COLOR, 0.3)
          : hovered?.kind === "edge" && !selection.edges.includes(hovered.index)
            ? edgeMarks([hovered.index], hoverEdgeMat, hoverEdgeWhole)
            : hovered?.kind === "vertex"
              ? vertexDots([hovered.point], HOVER_COLOR, 10)
              : null;
      // Select Other's row under the pointer: lit up through whatever hides it.
      const look = peek?.kind === "face" ? faceMesh([peek.index], HOVER_COLOR, 0.42, true) : peek?.kind === "edge" ? edgeMarks([peek.index], hoverEdgeMat, hoverEdgeWhole) : null;
      for (const o of [...sel, hov, look]) if (o) marks.add(o);
      datums.mark(selection.datums ?? [], hovered?.kind === "datum" ? hovered.id : null);
      relabelDatums();
      render();
    };

    const edgeMaterials = (obj: THREE.LineSegments | null) => (obj ? ([obj.material].flat() as THREE.LineBasicMaterial[]) : []);
    /** Draws the part the way the display style says: surfaces, edges, hidden edges dashed, outlines. */
    const applyDisplay = () => {
      if (mesh) {
        const lines = style === "hiddenRemoved" || style === "hiddenVisible" || style === "wireframe";
        mesh.visible = style !== "wireframe";
        // Lines only: the surfaces still hide what is behind them, but draw nothing themselves (and go first).
        mesh.renderOrder = lines ? -1 : 0;
        for (const m of [mesh.material].flat() as THREE.MeshStandardMaterial[]) {
          m.colorWrite = !lines;
          m.needsUpdate = true;
        }
      }
      if (edgeLines) {
        edgeLines.visible = style !== "shaded";
        for (const mat of edgeMaterials(edgeLines)) {
          mat.depthTest = style !== "wireframe";
          mat.needsUpdate = true;
        }
      }
      if (hiddenLines) hiddenLines.visible = style === "hiddenVisible";
      for (const outline of outlines) {
        (outline.seen.material as THREE.LineBasicMaterial).depthTest = style !== "wireframe";
        (outline.seen.material as THREE.Material).needsUpdate = true;
      }
      render();
    };

    // ------------------------------------------------------------ the section view

    /** What the caps are made from, kept while the part, the hidden bodies, the bodies cut and the cap colour stay the same (so a drag never rebuilds them). */
    let capCache: { key: string; sources: CapSource[] } | null = null;
    const dropCapCache = () => {
      for (const src of capCache?.sources ?? []) if (src.geometry !== mesh?.geometry) src.geometry.dispose();
      capCache = null;
    };
    let modelVersion = 0;
    const capSources = (): CapSource[] => {
      if (!mesh || !sectionState || !clipPlanes.length) return [];
      const perBody = sectionState.capColour === "bodies" && (shownView?.bodies.length ?? 0) > 1;
      const key = JSON.stringify([modelVersion, [...hidden].sort(), sectionState.bodies, perBody]);
      if (capCache?.key === key) return capCache.sources;
      dropCapCache();
      const faces = shownView?.faces ?? [];
      const capped = (f: FaceInfo) => !isHidden(f.body) && cutsBody(sectionState, f.body);
      const sources: CapSource[] = [];
      if (perBody) {
        (shownView?.bodies ?? []).forEach((b, i) => {
          if (hidden.has(b.name) || !cutsBody(sectionState, b.name)) return;
          const g = faceGeometry(Array.from({ length: b.faces[1] - b.faces[0] }, (_, k) => b.faces[0] + k));
          const color = new THREE.Color(BODY_COLORS[i % BODY_COLORS.length]);
          if (g) sources.push({ geometry: g, color, hatch: color.clone().multiplyScalar(0.62) });
        });
      } else {
        const all = faces.every(capped);
        const g = all ? mesh.geometry : faceGeometry(faces.map((f, i) => (capped(f) ? i : -1)).filter((i) => i >= 0));
        if (g) sources.push({ geometry: g, color: capColor, hatch: capHatch });
      }
      capCache = { key, sources };
      return sources;
    };

    /** The visible box as plain numbers (where the section's planes are drawn and their slider runs). */
    const boxNow = (): { min: Vec3; max: Vec3 } | null => (visibleBox && !visibleBox.isEmpty() ? { min: visibleBox.min.toArray() as Vec3, max: visibleBox.max.toArray() as Vec3 } : null);
    /** The section's drag arrows: one per active plane, while the planes are drawn. */
    let sectionHandles: HandleSpec[] = [];
    const makeSectionHandles = (): HandleSpec[] => {
      const v = sectionState;
      if (!v?.on || !v.showPlane) return [];
      return v.planes.flatMap((s, i): HandleSpec[] => {
        if (s.enabled === false) return [];
        const a = offsetArrow(s, boxNow());
        if (!a) return [];
        return [{ id: `section:${i}`, feature: "", key: "offset", origin: a.origin, dir: a.dir, value: s.offset, scale: a.scale, min: null, label: v.planes.length > 1 ? `Section ${i + 1}` : "Section", kind: "section", plane: i }];
      });
    };
    /** Every handle drawn: the feature's, then the section's. */
    const allHandles = () => [...handleList, ...sectionHandles];
    const refreshHandles = () => {
      const all = allHandles();
      // While one is dragged, it keeps its drag (the new numbers are the drag's own).
      const still = drag ? all.find((x) => x.id === drag!.h.id) : undefined;
      if (drag && !still) drag = null;
      evalLayer.setHandles(all, drag ? { h: drag.h, value: drag.value } : null);
    };

    /** Clips each body's materials: by the active planes, or not at all for a body the section leaves whole. */
    const clipModel = () => {
      if (mesh) {
        const mats = [mesh.material].flat() as THREE.Material[];
        const bodies = shownView?.bodies ?? [];
        mats.forEach((m, i) => clipMaterial(m, clipFor(mats.length > 1 ? bodies[i]?.name : bodies[0]?.name)));
      }
      for (const obj of [edgeLines, hiddenLines]) edgeMaterials(obj).forEach((m, k) => clipMaterial(m, clipFor(edgeGroupBodies[k])));
      for (const o of outlines) for (const m of [o.seen.material, o.hidden.material] as THREE.Material[]) clipMaterial(m, o.cut ? clipPlanes : NO_PLANES);
      for (const m of [selectEdgeMat, hoverEdgeMat]) clipMaterial(m, clipPlanes);
    };

    /** The section on the part: each cut body's materials clipped, the cuts capped, the planes and their arrows drawn. */
    const applySection = () => {
      const planes = clipPlanesOf(sectionState);
      cutTests = activePlanes(sectionState).map((s) => {
        const p = sectionPlane(s);
        return { n: p.normal, c: p.constant };
      });
      // The same planes moved: their numbers change in place (every material reading them sees it, nothing recompiles).
      const moved = planes.length === clipPlanes.length && planes.length > 0;
      if (moved) planes.forEach((p, i) => clipPlanes[i].copy(p));
      else clipPlanes = planes;
      const cutKey = JSON.stringify(sectionState?.bodies ?? null);
      if (cutKey !== outlineCutKey) buildOutlines();
      clipModel();
      if (!moved) redrawMarks();
      caps.set(capSources(), clipPlanes, visibleBox && !visibleBox.isEmpty() ? visibleBox.getCenter(new THREE.Vector3()) : center, radius * 2 + 1);
      sectionPlanes.set(sectionState, boxNow());
      sectionHandles = makeSectionHandles();
      refreshHandles();
      render();
    };

    /** The curved faces' outlines (seen, and hidden dashed), for the line styles: split by whether the section cuts their body. */
    const buildOutlines = () => {
      for (const o of outlines) {
        model.remove(o.seen, o.hidden);
        o.seen.geometry.dispose();
        o.hidden.geometry.dispose();
        (o.seen.material as THREE.Material).dispose();
        (o.hidden.material as THREE.Material).dispose();
      }
      outlines = [];
      outlineCutKey = JSON.stringify(sectionState?.bodies ?? null);
      const v = shownView;
      if (!v?.mesh || !mesh) return;
      const edgeColor = cssColor(el, "--edge", "#1f2937");
      for (const cut of sectionState?.bodies ? [true, false] : [true]) {
        const curved = v.faces.map((f) => f.type !== "plane" && !isHidden(f.body) && cutsBody(sectionState, f.body) === cut);
        if (!curved.some(Boolean)) continue;
        const adj = adjacency(v.mesh.positions, v.mesh.indices, faceRanges, curved);
        const seen = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: edgeColor }));
        const hiddenOutline = new THREE.LineSegments(new THREE.BufferGeometry(), dashedMaterial(edgeColor));
        hiddenOutline.renderOrder = 1;
        model.add(seen, hiddenOutline);
        outlines.push({ adj, seen, hidden: hiddenOutline, cut });
      }
      for (const o of outlines) (o.seen.material as THREE.LineBasicMaterial).depthTest = style !== "wireframe";
    };
    /** Hidden lines: dashed and fainter, drawn only where something is in front of them. */
    const dashedMaterial = (color: THREE.Color) =>
      new THREE.LineDashedMaterial({ color, dashSize: radius / 45, gapSize: radius / 70, transparent: true, opacity: 0.45, depthFunc: THREE.GreaterDepth, depthWrite: false });

    const setModel = (v: RebuildView | null) => {
      shownView = v;
      modelVersion++;
      dropCapCache();
      disposeGroup(model);
      disposeGroup(overlays);
      mesh = null;
      edgeLines = null;
      hiddenLines = null;
      edgeGroupBodies = [];
      outlines = [];
      hovered = null;
      vertices = [];
      vertexBody = new Int16Array(0);
      visibleBox = null;
      faceRanges = v?.mesh?.faceRanges ?? [];
      edgeRanges = v?.mesh?.edgeRanges ?? [];
      edgeSegments = v?.mesh?.edges ?? new Float32Array(0);
      if (v?.mesh) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(v.mesh.positions, 3));
        g.setAttribute("normal", new THREE.BufferAttribute(v.mesh.normals, 3));
        g.setIndex(new THREE.BufferAttribute(v.mesh.indices, 1));
        g.computeBoundingSphere();
        const surface = (color: THREE.ColorRepresentation, visible = true) =>
          new THREE.MeshStandardMaterial({ color, metalness: 0.15, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, visible });
        // A part of several bodies: one colour each, as triangle groups (each body's faces are contiguous).
        const bodies = v.bodies ?? [];
        if (bodies.length > 1) {
          bodies.forEach((b, i) => {
            const first = faceRanges[b.faces[0]];
            const last = faceRanges[b.faces[1] - 1];
            if (first && last) g.addGroup(first.start, last.start + last.count - first.start, i);
          });
          mesh = new THREE.Mesh(g, bodies.map((b, i) => surface(BODY_COLORS[i % BODY_COLORS.length], !hidden.has(b.name))));
        } else {
          mesh = new THREE.Mesh(g, surface(cssColor(el, "--part", "#c4cad3")));
        }
        model.add(mesh);
        // Which body each vertex is in (−1: hidden), and the visible bodies' box: the rotation centre and Fit use them.
        const bodyIndex = new Map(bodies.map((b, i) => [b.name, i]));
        vertexBody = new Int16Array(v.mesh.positions.length / 3).fill(-1);
        const box = new THREE.Box3();
        const p = new THREE.Vector3();
        const idx = v.mesh.indices;
        const pos = v.mesh.positions;
        v.faces.forEach((f, i) => {
          if (isHidden(f.body) || !faceRanges[i]) return;
          const b = f.body !== undefined ? (bodyIndex.get(f.body) ?? 0) : 0;
          const r = faceRanges[i];
          for (let t = r.start; t < r.start + r.count; t++) {
            const vi = idx[t];
            if (vertexBody[vi] >= 0) continue;
            vertexBody[vi] = b;
            box.expandByPoint(p.set(pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]));
          }
        });
        visibleBox = box.isEmpty() ? null : box;
        // Draw every edge except seams, body by body (a material each); remember which edge each segment belongs to.
        const names = bodies.length > 1 ? bodies.map((b) => b.name) : [undefined];
        const known = new Set(names);
        const groupOf = (body: string | undefined) => (names.length > 1 && body !== undefined && known.has(body) ? body : names.length > 1 ? undefined : names[0]);
        const pts: number[] = [];
        const owners: number[] = [];
        const groups: { start: number; count: number; body: string | undefined }[] = [];
        for (const name of names.length > 1 ? [...names, undefined] : names) {
          const first = owners.length;
          edgeRanges.forEach((r, i) => {
            const e = v.edges[i];
            if (e?.seam || isHidden(e?.body) || groupOf(e?.body) !== name) return;
            for (let k = r.start; k < r.start + r.count; k++) {
              for (let c = 0; c < 6; c++) pts.push(edgeSegments[k * 6 + c]);
              owners.push(i);
            }
          });
          if (owners.length > first) groups.push({ start: first * 2, count: (owners.length - first) * 2, body: name });
        }
        segmentEdge = Int32Array.from(owners);
        edgeGroupBodies = groups.map((gr) => gr.body);
        // The part's vertices: the ends of its drawn edges (not a whole circle's seam point), one edge standing for each.
        const seen = new Map<string, VertexPick & { p: Vec3 }>();
        v.edges.forEach((e, i) => {
          if (e.seam || isHidden(e.body) || Math.hypot(e.end[0] - e.start[0], e.end[1] - e.start[1], e.end[2] - e.start[2]) < 1e-6) return;
          for (const at of ["start", "end"] as const) {
            const q = at === "start" ? e.start : e.end;
            const key = q.map((x) => Math.round(x * 1e4)).join(",");
            if (!seen.has(key)) seen.set(key, { edge: i, at, p: q });
          }
        });
        vertices = [...seen.values()];
        const edgeColor = cssColor(el, "--edge", "#1f2937");
        const eg = new THREE.BufferGeometry();
        eg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
        groups.forEach((gr, k) => eg.addGroup(gr.start, gr.count, k));
        edgeLines = new THREE.LineSegments(eg, groups.length ? groups.map(() => new THREE.LineBasicMaterial({ color: edgeColor })) : new THREE.LineBasicMaterial({ color: edgeColor }));
        model.add(edgeLines);
        center = g.boundingSphere!.center.clone();
        radius = Math.max(1, g.boundingSphere!.radius);
        hiddenLines = new THREE.LineSegments(eg, groups.length ? groups.map(() => dashedMaterial(edgeColor)) : dashedMaterial(edgeColor));
        hiddenLines.computeLineDistances();
        hiddenLines.renderOrder = 1;
        model.add(hiddenLines);
        buildOutlines();
      }
      for (const sk of v?.sketches ?? []) {
        for (const pl of sk.polylines) {
          const g = new THREE.BufferGeometry().setFromPoints(pl.points.map((p) => new THREE.Vector3(...p)));
          // A reference to the model is purple, as in the sketcher.
          const color = !sk.ok ? 0xe5484d : pl.reference ? 0x8e44c9 : pl.construction ? 0x8b93a1 : 0xf28c28;
          const mat = pl.construction
            ? new THREE.LineDashedMaterial({ color, dashSize: radius / 40, gapSize: radius / 60, depthTest: false, transparent: true, opacity: SKETCH_OPACITY })
            : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: sk.ok ? SKETCH_OPACITY : 1 });
          const line = new THREE.Line(g, mat);
          if (pl.construction) line.computeLineDistances();
          line.renderOrder = 3;
          overlays.add(line);
        }
        // The sketch's points (hole centres, pattern positions): small markers, the same size at any zoom.
        // A point that references the model is purple, as its lines are.
        for (const reference of [false, true]) {
          const pts = (sk.points ?? []).filter((p) => !!p.reference === reference);
          if (!pts.length) continue;
          const g = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(...p.at)));
          const color = !sk.ok ? 0xe5484d : reference ? 0x8e44c9 : 0xf28c28;
          const dots = new THREE.Points(g, new THREE.PointsMaterial({ color, size: 6, sizeAttenuation: false, depthTest: false, transparent: true, opacity: sk.ok ? SKETCH_OPACITY : 1 }));
          dots.renderOrder = 3;
          overlays.add(dots);
        }
      }
      // A rotation centre pinned on a part that has since changed may now be in empty space: it stays until you clear it.
      rebuildHelpers();
      applyDisplay();
      // The materials are new: clip them afresh (applySection would see unchanged planes and only move them).
      clipPlanes = [];
      applySection();
      redrawMarks();
    };

    /** A photo pixel, in the model's XY plane. */
    const photoToWorld = (u: Underlay, px: Vec2, z = 0) => new THREE.Vector3((px[0] - u.origin[0]) * u.mmPerPx, -(px[1] - u.origin[1]) * u.mmPerPx, z);

    const setUnderlay = (u: Underlay | null) => {
      disposeGroup(photoGroup);
      photoMesh = null;
      photo = u;
      if (!u) {
        photoTexture?.texture.dispose();
        photoTexture = null;
        rebuildHelpers();
        render();
        return;
      }
      if (photoTexture?.url !== u.url) {
        photoTexture?.texture.dispose();
        const texture = new THREE.TextureLoader().load(u.url, render);
        texture.colorSpace = THREE.SRGBColorSpace;
        photoTexture = { url: u.url, texture };
      }
      const w = u.width * u.mmPerPx;
      const h = u.height * u.mmPerPx;
      const z = -Math.max(0.05, radius * 0.002); // just under the part's bottom face
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ map: photoTexture.texture, transparent: true, opacity: u.opacity, depthWrite: false, side: THREE.DoubleSide }),
      );
      plane.position.copy(photoToWorld(u, [u.width / 2, u.height / 2], z));
      plane.renderOrder = -1;
      photoMesh = plane;
      photoGroup.add(plane);
      // The scale line, with a tick across each end.
      const a = photoToWorld(u, u.scale.from);
      const b = photoToWorld(u, u.scale.to);
      const along = b.clone().sub(a).normalize();
      const tick = new THREE.Vector3(-along.y, along.x, 0).multiplyScalar(14 * u.mmPerPx);
      const pts = [a, b, a.clone().add(tick), a.clone().sub(tick), b.clone().add(tick), b.clone().sub(tick)].flatMap((p) => p.toArray());
      const g = new LineSegmentsGeometry();
      g.setPositions(pts);
      const line = new LineSegments2(g, u.scale.confirmed ? scaleConfirmedMat : scaleMat);
      line.renderOrder = 6;
      photoGroup.add(line);
      if (!mesh) {
        center = photoToWorld(u, [u.width / 2, u.height / 2]);
        radius = Math.max(w, h) / 2;
      }
      rebuildHelpers();
      render();
    };

    /** The photo pixel under the cursor, if the cursor is over the photo. */
    const photoPixelAt = (clientX: number, clientY: number): Vec2 | null => {
      if (!photoMesh || !photo) return null;
      aim(clientX, clientY);
      const hit = raycaster.intersectObject(photoMesh, false)[0];
      if (!hit?.uv) return null;
      return [hit.uv.x * photo.width, (1 - hit.uv.y) * photo.height];
    };

    // Picking: the nearest edge within a few pixels wins over the face under the cursor, and a vertex
    // (an edge's end) within a few more over both. Reference geometry never hides the part: its border,
    // an axis or a point wins only in front of the part; a plane's inside only where the part isn't.
    // What a section cuts away is not there to pick; the selection filter leaves out the kinds it doesn't allow.
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    /** Points the pick ray from the eye through a client pixel. */
    const aim = (clientX: number, clientY: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      if (!perspective) syncOrtho();
      raycaster.setFromCamera(pointer, eye());
    };
    /** A world point in client pixels, or null behind the camera. */
    const project = (p: Vec3): { x: number; y: number } | null => {
      const v = new THREE.Vector3(...p).project(eye());
      if (v.z > 1) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
    };
    /** The face a ray hit's triangle belongs to (−1: none). */
    const faceAt = (h: THREE.Intersection) => {
      if (h.faceIndex === undefined || h.faceIndex === null) return -1;
      const tri = h.faceIndex * 3;
      return faceRanges.findIndex((r) => tri >= r.start && tri < r.start + r.count);
    };
    const pickPart = (clientX: number, clientY: number, everything = false): { target: PickTarget; distance: number } | null => {
      if (!mesh) return null;
      const may = (kind: PickTarget["kind"]) => everything || allows(pickFilter, kind);
      // Hidden bodies are still in the mesh: look through them, and through what a section cuts away.
      const faceHit = raycaster.intersectObject(mesh, false).find((h) => {
        const body = faceBody(faceAt(h));
        return !isHidden(body) && !cutAway(h.point, body);
      });
      const worldPerPixel = controls.worldPerPixel();
      const slack = 2 * PICK_PIXELS * worldPerPixel;
      raycaster.params.Line = { threshold: PICK_PIXELS * worldPerPixel };
      const edgeHit = edgeLines && may("edge") ? raycaster.intersectObject(edgeLines, false).find((h) => h.index !== undefined && !cutAway(h.point, edgeBody(segmentEdge[Math.floor(h.index / 2)]))) : undefined;
      const frontEdge = edgeHit && (!faceHit || edgeHit.distance <= faceHit.distance + slack);
      let hit: { target: PickTarget; distance: number } | null = null;
      if (frontEdge && edgeHit.index !== undefined) {
        hit = { target: { kind: "edge", index: segmentEdge[Math.floor(edgeHit.index / 2)], point: edgeHit.point.toArray() as Vec3 }, distance: edgeHit.distance };
      } else if (faceHit && may("face")) {
        const index = faceAt(faceHit);
        if (index >= 0) hit = { target: { kind: "face", index, point: faceHit.point.toArray() as Vec3 }, distance: faceHit.distance };
      }
      // A vertex near the pointer, not hidden behind what the pointer is on.
      const along = (p: Vec3) => new THREE.Vector3(...p).sub(raycaster.ray.origin).dot(raycaster.ray.direction);
      const front = hit?.distance ?? (faceHit ? faceHit.distance : null);
      let best: { v: VertexPick & { p: Vec3 }; d: number } | null = null;
      if (may("vertex")) {
        for (const v of vertices) {
          if (cutAway(v.p, edgeBody(v.edge))) continue;
          const s = project(v.p);
          if (!s) continue;
          const d = Math.hypot(s.x - clientX, s.y - clientY);
          if (d > VERTEX_PIXELS || (best && d >= best.d)) continue;
          if (front !== null && along(v.p) > front + slack) continue;
          best = { v, d };
        }
      }
      if (best) return { target: { kind: "vertex", edge: best.v.edge, at: best.v.at, point: best.v.p }, distance: along(best.v.p) };
      return hit;
    };
    /** What a click here picks; `everything` ignores the selection filter (the pivot of a rotation is anywhere on the part). */
    const pickAt = (clientX: number, clientY: number, everything = false): PickTarget | null => {
      aim(clientX, clientY);
      const part = pickPart(clientX, clientY, everything);
      const datum = everything || allows(pickFilter, "datum") ? datums.pick(clientX, clientY, project, raycaster.ray, PICK_PIXELS) : null;
      const slack = 2 * PICK_PIXELS * controls.worldPerPixel();
      if (datum?.firm && (!part || datum.distance <= part.distance + slack)) return { kind: "datum", id: datum.id, point: datum.point };
      if (part) return part.target;
      return datum ? { kind: "datum", id: datum.id, point: datum.point } : null;
    };
    /** Every face and edge under these client pixels (not hidden, not cut away), nearest first, each once: Select Other's list, and Alt+click's. */
    const underAt = (clientX: number, clientY: number): UnderPointer[] => {
      if (!mesh) return [];
      aim(clientX, clientY);
      const hits: UnderPointer[] = [];
      // Faces turned away count too (the bottom of a plate, seen from above): the ray meets both sides for this.
      const mats = [mesh.material].flat() as THREE.Material[];
      const sides = mats.map((m) => m.side);
      for (const m of mats) m.side = THREE.DoubleSide;
      const faceHits = raycaster.intersectObject(mesh, false);
      mats.forEach((m, i) => (m.side = sides[i]));
      for (const h of faceHits) {
        const index = faceAt(h);
        const body = faceBody(index);
        if (index < 0 || isHidden(body) || cutAway(h.point, body)) continue;
        hits.push({ target: { kind: "face", index, point: h.point.toArray() as Vec3 }, distance: h.distance });
      }
      if (edgeLines) {
        raycaster.params.Line = { threshold: PICK_PIXELS * controls.worldPerPixel() };
        for (const h of raycaster.intersectObject(edgeLines, false)) {
          if (h.index === undefined) continue;
          const index = segmentEdge[Math.floor(h.index / 2)];
          if (cutAway(h.point, edgeBody(index))) continue;
          hits.push({ target: { kind: "edge", index, point: h.point.toArray() as Vec3 }, distance: h.distance });
        }
      }
      return underPointer(hits);
    };

    /** The part on screen, for a box: each face's triangles, each edge's segments, each vertex (null: off screen or cut away). */
    const projected = (): Projected => {
      const out: Projected = { faces: [], edges: [], vertices: [] };
      if (!mesh || !shownView) return out;
      const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
      const idx = mesh.geometry.getIndex()!.array as Uint32Array;
      const cache = new Map<number, Vec2 | null>();
      const at = (p: Vec3, body: string | undefined): Vec2 | null => {
        if (cutAway(p, body)) return null;
        const s = project(p);
        return s ? [s.x, s.y] : null;
      };
      const vertexAt = (i: number, body: string | undefined) => {
        if (!cache.has(i)) cache.set(i, at([pos.getX(i), pos.getY(i), pos.getZ(i)], body));
        return cache.get(i)!;
      };
      out.faces = faceRanges.map((r, f) => {
        const body = shownView!.faces[f]?.body;
        if (isHidden(body)) return [];
        const tris: (Vec2 | null)[][] = [];
        for (let t = r.start; t < r.start + r.count; t += 3) tris.push([vertexAt(idx[t], body), vertexAt(idx[t + 1], body), vertexAt(idx[t + 2], body)]);
        return tris;
      });
      out.edges = edgeRanges.map((r, e) => {
        const info = shownView!.edges[e];
        if (!info || info.seam || isHidden(info.body)) return [];
        const segs: [Vec2 | null, Vec2 | null][] = [];
        for (let k = r.start; k < r.start + r.count; k++) {
          const a: Vec3 = [edgeSegments[k * 6], edgeSegments[k * 6 + 1], edgeSegments[k * 6 + 2]];
          const b: Vec3 = [edgeSegments[k * 6 + 3], edgeSegments[k * 6 + 4], edgeSegments[k * 6 + 5]];
          segs.push([at(a, info.body), at(b, info.body)]);
        }
        return segs;
      });
      out.vertices = vertices.map((v) => ({ edge: v.edge, at: v.at, p: at(v.p, edgeBody(v.edge)) }));
      return out;
    };

    /** The same thing (a face, an edge, a vertex or a datum), wherever on it. */
    const targetKey = (t: PickTarget | null) => (!t ? "" : t.kind === "datum" ? `d:${t.id}` : t.kind === "vertex" ? `v:${t.edge}:${t.at}` : `${t.kind}:${t.index}`);
    const sameTarget = (a: PickTarget | null, b: PickTarget | null) => targetKey(a) === targetKey(b);
    // A handle being dragged: which one, how far along its arrow the drag started, and the value now.
    let drag: { h: HandleSpec; t0: number; value: number; id: number } | null = null;
    // Zoom to area: the next left-drag draws the area to zoom to (Esc or the button again cancels).
    let areaOn = false;
    const setArea = (on: boolean) => {
      areaOn = on;
      controls.leftTaken = on;
      renderer.domElement.style.cursor = on ? "zoom-in" : "";
      live.current.onArea(on);
    };
    const onMove = (e: PointerEvent) => {
      if (drag) return;
      if (boxing) return moveBox(e);
      if (e.buttons !== 0 || photoPointRef.current || areaOn) return;
      // A handle under the pointer lights up, and the pointer says it can be dragged.
      const hot = evalLayer.hit(e.clientX, e.clientY, project, controls.worldPerPixel());
      if (evalLayer.setHot(hot?.id ?? null)) render();
      renderer.domElement.style.cursor = hot ? (hot.locked ? "not-allowed" : "grab") : "";
      const target = hot ? null : pickAt(e.clientX, e.clientY);
      if (!sameTarget(target, hovered)) {
        hovered = target;
        redrawMarks();
      }
      const rect = renderer.domElement.getBoundingClientRect();
      setHover(target ? { x: e.clientX - rect.left, y: e.clientY - rect.top, target } : null);
    };
    const onLeave = () => {
      hovered = null;
      setHover(null);
      redrawMarks();
    };
    // A click is a press and release without dragging; drags orbit the view.
    // Right-drag pans; a right press and release in place is a right-click.
    // A left drag on the view (the standard mouse) draws a selection box, or with Zoom to area on, the area.
    // Alt+click picks the face behind the one picked (again: the one behind that).
    let down: { x: number; y: number; button: number; shift: boolean } | null = null;
    let boxing = false;
    const onDown = (e: PointerEvent) => {
      if (e.button === 0 || e.button === 2) down = { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey || e.ctrlKey || e.metaKey };
      boxing = false;
      // The view is about to move: the hover tip would be left pointing at nothing.
      if (e.button !== 0 && hovered) onLeave();
    };
    /** The box on screen, in the view's own pixels. */
    const moveBox = (e: PointerEvent) => {
      if (!down) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const b = boxOf([down.x - rect.left, down.y - rect.top], [e.clientX - rect.left, e.clientY - rect.top]);
      setBox({ ...b.rect, crossing: !areaOn && b.crossing, area: areaOn });
    };
    /** Zooms to a box dragged on the view (client pixels): its middle to the middle of the view, filling it. */
    const zoomToArea = (x0: number, y0: number, x1: number, y1: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const z = areaZoom({ x0: x0 - rect.left, y0: y0 - rect.top, x1: x1 - rect.left, y1: y1 - rect.top }, rect.width, rect.height);
      if (!z) return false;
      const pose = controls.pose();
      const { up, right, forward } = controls.axes();
      const dist = pose.position.distanceTo(pose.target);
      const halfH = controls.worldPerPixel() * (rect.height / 2);
      const halfW = halfH * (rect.width / rect.height);
      // Where the box's middle is, at the look-at depth (orthographic and perspective alike, at that depth).
      const at = pose.target.clone().addScaledVector(right, z.ndc[0] * halfW).addScaledVector(up, z.ndc[1] * halfH);
      const nextDist = Math.max(dist * z.factor, 1e-3);
      glideTo({ position: at.clone().addScaledVector(forward, -nextDist), target: at, up: pose.up.clone() });
      return true;
    };
    const onUp = (e: PointerEvent) => {
      if (!down || e.button !== down.button) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const wasBox = boxing;
      const start = down;
      down = null;
      boxing = false;
      if (wasBox) {
        setBox(null);
        if (renderer.domElement.hasPointerCapture(e.pointerId)) renderer.domElement.releasePointerCapture(e.pointerId);
        if (areaOn) {
          setArea(false);
          zoomToArea(start.x, start.y, e.clientX, e.clientY);
          return;
        }
        const b = boxOf([start.x, start.y], [e.clientX, e.clientY]);
        live.current.onBox?.(boxSelect(b.rect, b.crossing, projected(), pickFilter), start.shift);
        return;
      }
      if (moved > 4) return;
      // Waiting for an area: a click is not a pick.
      if (areaOn && e.button === 0) return;
      if (e.button === 0 && photoPointRef.current) {
        const px = photoPixelAt(e.clientX, e.clientY);
        if (px) photoPointRef.current(px);
        return;
      }
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      if (e.button === 2) contextRef.current?.(pickAt(e.clientX, e.clientY), e.clientX, e.clientY);
      else if (e.altKey) {
        // Alt+click: the next face behind the one picked.
        const next = nextBehind(underAt(e.clientX, e.clientY), selection);
        pickRef.current(next ? next.target : pickAt(e.clientX, e.clientY), additive);
      } else pickRef.current(pickAt(e.clientX, e.clientY), additive);
    };
    // A left press that travels starts a box (the standard mouse: the trackpad scheme's left drag turns the view, unless an area is wanted).
    const onBoxMove = (e: PointerEvent) => {
      if (!down || down.button !== 0 || boxing || drag || photoPointRef.current) return;
      if (!areaOn && (inputPrefs().mouse !== "standard" || e.pointerType === "touch" || !live.current.onBox)) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) < BOX_SLOP) return;
      boxing = true;
      if (hovered) onLeave();
      renderer.domElement.setPointerCapture?.(e.pointerId);
      moveBox(e);
    };
    const onDblClick = (e: MouseEvent) => {
      if (photoPointRef.current || areaOn) return;
      live.current.onDoubleClick?.(pickAt(e.clientX, e.clientY));
    };
    const canvas = renderer.domElement;
    canvas.addEventListener("pointermove", onBoxMove);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("dblclick", onDblClick);

    /** A section arrow's value clicked: that plane in the panel, its offset ready to type. */
    const sectionLabel = (h: HandleSpec) => {
      const v = live.current.section;
      if (!v) return;
      live.current.onSection?.({ ...v, active: h.plane ?? 0, collapsed: false });
      live.current.onSectionPanel?.();
      setTimeout(() => {
        const input = document.querySelector<HTMLInputElement>('input[data-testid="section-offset"]');
        input?.focus();
        input?.select();
      }, 50);
    };
    /** A section arrow dragged: its plane's offset, live; cancelled, back to where it was. */
    const dragSection = (h: HandleSpec, phase: HandlePhase, value: number) => {
      const v = live.current.section;
      const i = h.plane ?? 0;
      if (!v?.planes[i]) return;
      live.current.onSection?.(setPlane(v, i, { ...v.planes[i], offset: phase === "cancel" ? h.value : value }));
    };
    const handleEvent = (h: HandleSpec, phase: HandlePhase, value: number) => (h.kind === "section" ? dragSection(h, phase, value) : live.current.onHandle?.(h, phase, value));

    // Handles are grabbed before anything else sees the press (the controls would turn the view, a click would pick).
    const handleDown = (e: PointerEvent) => {
      if (e.button !== 0 || !allHandles().length || areaOn) return;
      const h = evalLayer.hit(e.clientX, e.clientY, project, controls.worldPerPixel());
      if (!h) return;
      e.stopPropagation();
      e.preventDefault();
      if (h.locked) {
        live.current.onMessage?.(`${h.label}: ${h.locked}.`);
        return;
      }
      aim(e.clientX, e.clientY);
      const t0 = alongAxis(h.origin, h.dir, raycaster.ray.origin.toArray() as Vec3, raycaster.ray.direction.toArray() as Vec3);
      if (t0 === null) {
        live.current.onMessage?.("That arrow points straight at you: turn the view a little to drag it.");
        return;
      }
      finishGlide();
      drag = { h, t0, value: h.value, id: e.pointerId };
      el.setPointerCapture?.(e.pointerId);
      renderer.domElement.style.cursor = "grabbing";
      hovered = null;
      setHover(null);
      evalLayer.setHandles(allHandles(), { h, value: h.value });
      handleEvent(h, "start", h.value);
      render();
    };
    const handleMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      e.stopPropagation();
      aim(e.clientX, e.clientY);
      const t = alongAxis(drag.h.origin, drag.h.dir, raycaster.ray.origin.toArray() as Vec3, raycaster.ray.direction.toArray() as Vec3);
      if (t === null) return;
      const value = dragValue(drag.h, drag.h.value, t - drag.t0, e.shiftKey);
      if (value === drag.value) return;
      drag.value = value;
      evalLayer.setHandles(allHandles(), { h: drag.h, value });
      handleEvent(drag.h, "move", value);
      render();
    };
    const endDrag = (e: PointerEvent | KeyboardEvent, phase: "end" | "cancel") => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if ("pointerId" in e && el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
      renderer.domElement.style.cursor = "";
      evalLayer.setHandles(allHandles(), null);
      handleEvent(d.h, phase, phase === "end" ? d.value : d.h.value);
      render();
    };
    const handleUp = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      e.stopPropagation();
      endDrag(e, "end");
    };
    const handleKey = (e: KeyboardEvent) => {
      if (drag && e.key === "Escape") {
        e.preventDefault();
        endDrag(e, "cancel");
      }
    };
    // Esc (not while typing): stops waiting for an area, else unpins the rotation centre.
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (areaOn) return setArea(false);
      controls.pin(null);
    };
    el.addEventListener("pointerdown", handleDown, true);
    el.addEventListener("pointermove", handleMove, true);
    el.addEventListener("pointerup", handleUp, true);
    window.addEventListener("keydown", handleKey, true);
    window.addEventListener("keydown", escape);

    // Automation hook for end-to-end tests (only with ?e2e in the URL): world point -> client pixels.
    if (automated) {
      const toScreen = (p: Vec3): [number, number] => {
        if (!perspective) syncOrtho();
        eye().updateMatrixWorld();
        const v = new THREE.Vector3(...p).project(eye());
        const rect = canvas.getBoundingClientRect();
        return [rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height];
      };
      const r4 = (v: THREE.Vector3 | Vec3) => (Array.isArray(v) ? v : v.toArray()).map((x) => Math.round(x * 1e4) / 1e4 + 0) as Vec3;
      (window as unknown as { __cocaideViewport?: unknown }).__cocaideViewport = {
        project: toScreen,
        /** Where the camera is, what it looks at, and which way is up. */
        camera() {
          return { position: r4(camera.position), target: r4(controls.target), up: r4(camera.up) };
        },
        /** The reference geometry drawn now, by id ("Top", "plane_1", "Origin"). */
        datums(): string[] {
          return datums.ids();
        },
        /** A point on a drawn datum to click: a plane's far border (above the part, for a default plane), an axis, a point, the origin (client pixels). */
        datumPoint(id: string): [number, number] | null {
          if (id === "Origin") return toScreen([0, 0, 0]);
          const s = datumList.find((d) => d.id === id);
          if (!s) return null;
          const part = (a: Vec3, b: Vec3) => a.map((c, i) => c + (b[i] - c) * 0.3) as Vec3;
          return toScreen(s.kind === "plane" ? part(s.corners[2], s.corners[3]) : s.kind === "axis" ? part(s.ends[0], s.ends[1]) : s.at);
        },
        /** A pixel of the pinned photo -> client pixels. */
        photoPoint(px: Vec2): [number, number] | null {
          if (!photo) return null;
          return toScreen(photoToWorld(photo, px, -Math.max(0.05, radius * 0.002)).toArray() as Vec3);
        },
        /** How the part is drawn now. */
        display() {
          return { style, perspective, edgesShown: edgeLines?.visible ?? false, surfacesShown: !!mesh?.visible && ([mesh.material].flat() as THREE.Material[])[0]?.colorWrite !== false };
        },
        /** The section's first active plane: its normal (into the part kept) and constant, and whether the caps are drawn. */
        section() {
          const p = clipPlanes[0];
          return p ? { normal: p.normal.toArray().map((x) => Math.round(x * 1e9) / 1e9 + 0), constant: Math.round(p.constant * 1e9) / 1e9 + 0, capped: caps.group.visible } : null;
        },
        /** Every active plane (as section() gives one), the bodies cut (null: all), and whether the caps are drawn. */
        sections() {
          return {
            planes: clipPlanes.map((p) => ({ normal: p.normal.toArray().map((x) => Math.round(x * 1e9) / 1e9 + 0), constant: Math.round(p.constant * 1e9) / 1e9 + 0 })),
            bodies: sectionState?.bodies ?? null,
            capped: caps.group.visible,
            planesDrawn: sectionPlanes.group.children.length / 2,
          };
        },
        /** Where a drag handle's arrow is (client pixels), to grab it. */
        handlePoint(id: string): [number, number] | null {
          const p = evalLayer.tipOnScreen(id, project, controls.worldPerPixel());
          return p ? [p.x, p.y] : null;
        },
        /** What a click at these client pixels would pick. */
        pick(x: number, y: number) {
          return pickAt(x, y);
        },
        /** The visible bodies' box. */
        visibleBox() {
          return visibleBox ? { min: r4(visibleBox.min), max: r4(visibleBox.max) } : null;
        },
        /** The centre a rotation starting now would turn about, and why (pinned, box, under, nearest, target). */
        rotationCentre() {
          const p = centreNow();
          return { point: r4(p), why: lastCentre?.why ?? "target" };
        },
        /** The pinned rotation centre, if any. */
        pinned() {
          return controls.pinned ? r4(controls.pinned) : null;
        },
        /** Is the pinned centre's marker drawn? */
        pivotMarker() {
          return pivotGroup.children.length > 0;
        },
        /** View changes glide in the tests only when turned on here. */
        glides(on: boolean, ms = VIEW_GLIDE_MS) {
          testGlides = on;
          glideMs = ms;
        },
        /** Is a view change gliding now? */
        gliding() {
          return !!glideAnim;
        },
        /** Ends a glide now, at the view it was going to. */
        finishGlide,
        /** What is under these client pixels, nearest first (Select Other's list). */
        under(x: number, y: number) {
          return underAt(x, y).map((h) => ({ ...h.target, label: otherLabel(h.target, shownView?.faces ?? [], shownView?.edges ?? []) }));
        },
      };
    }

    let datumList: DatumShape[] = [];
    api.current = {
      setModel,
      setDatums(shapes: DatumShape[], originSize: number | null) {
        datumList = shapes;
        datums.set(shapes, originSize);
        const h = hovered;
        if (h?.kind === "datum" && !shapes.some((s) => s.id === h.id) && !(h.id === "Origin" && originSize !== null)) hovered = null;
        datums.mark(selection.datums ?? [], hovered?.kind === "datum" ? hovered.id : null);
        relabelDatums();
        render();
      },
      setSelection(sel: Selection) {
        selection = sel;
        redrawMarks();
      },
      setSketchesVisible(visible: boolean) {
        overlays.visible = visible;
        nodeGroup.visible = visible;
        render();
      },
      setNodes(list: FrameNode[]) {
        nodeList = list;
        disposeGroup(nodeGroup);
        labels.replaceChildren(
          ...list.map((n) => {
            const tag = document.createElement("span");
            tag.className = "node-label";
            tag.textContent = n.name;
            tag.dataset.node = n.name;
            return tag;
          }),
        );
        if (list.length) {
          const g = new THREE.BufferGeometry().setFromPoints(list.map((n) => new THREE.Vector3(...n.at)));
          const dots = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xe8590c, size: 7, sizeAttenuation: false, depthTest: false }));
          dots.renderOrder = 4;
          nodeGroup.add(dots);
        }
        render();
      },
      setUnderlay,
      fitPhoto() {
        if (!photo) return fit(VIEWS.top.dir, undefined, VIEWS.top.up);
        // Half the view's height that shows the whole photo across and down.
        const half = (Math.max(photo.height, photo.width / camera.aspect) * photo.mmPerPx) / 2;
        fit(VIEWS.top.dir, { center: photoToWorld(photo, [photo.width / 2, photo.height / 2]), radius: half }, VIEWS.top.up);
      },
      setGhost(ghost: boolean) {
        if (mesh) {
          for (const m of [mesh.material].flat() as THREE.MeshStandardMaterial[]) {
            m.transparent = ghost;
            m.opacity = ghost ? 0.25 : 1;
            m.depthWrite = !ghost;
            m.needsUpdate = true;
          }
        }
        render();
      },
      setHiddenBodies(next: ReadonlySet<string>) {
        hidden = next;
        setModel(shownView);
      },
      fit: (dir?: Vec3, up?: Vec3) => {
        controls.pin(null);
        fit(dir, undefined, up);
      },
      orient,
      normalTo(n: Vec3) {
        const normal = new THREE.Vector3(...n).normalize();
        const { forward, up } = controls.axes();
        // Pressed again while square to the face: look at it from behind.
        const from = forward.dot(normal) < -0.999 ? normal.clone().negate() : normal;
        // Keep the screen's up as near as it was.
        const u = up.clone().addScaledVector(from, -up.dot(from));
        if (u.lengthSq() < 1e-6) u.set(...(Math.abs(from.z) > 0.999 ? ([0, 1, 0] as Vec3) : ([0, 0, 1] as Vec3)));
        fit(from.toArray() as Vec3, undefined, u.normalize().toArray() as Vec3);
      },
      turn: turnBy,
      pan: (dx: number, dy: number) => {
        finishGlide();
        controls.pan(dx, dy);
      },
      zoom: (f: number) => {
        finishGlide();
        controls.zoom(f);
      },
      roll: rollBy,
      setDisplay(d: DisplayState) {
        style = d.style;
        perspective = d.perspective;
        controls.orthographic = !perspective;
        applyDisplay();
      },
      setSection(s: SectionView | null) {
        sectionState = s;
        applySection();
        // What is cut away can't stay under the pointer.
        if (hovered && "point" in hovered && cutAway(hovered.point, hovered.kind === "face" ? faceBody(hovered.index) : hovered.kind === "edge" ? edgeBody(hovered.index) : undefined)) onLeave();
      },
      setOverlay(o: EvalOverlay | null) {
        evalLayer.setOverlay(o);
        render();
      },
      setDims(d: Dimension3D[]) {
        evalLayer.setDims(d);
        render();
      },
      setHandles(h: HandleSpec[]) {
        handleList = h;
        refreshHandles();
        render();
      },
      setFilter(f: SelectFilter) {
        pickFilter = f;
        if (hovered && !allows(f, hovered.kind)) onLeave();
      },
      zoomToSelection(sel: Selection) {
        const pts: number[] = [];
        const pos = mesh?.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
        const idx = mesh?.geometry.getIndex()?.array as Uint32Array | undefined;
        if (pos && idx) {
          for (const f of sel.faces) {
            const r = faceRanges[f];
            if (!r) continue;
            for (let t = r.start; t < r.start + r.count; t++) pts.push(pos.getX(idx[t]), pos.getY(idx[t]), pos.getZ(idx[t]));
          }
        }
        for (const e of sel.edges) {
          const r = edgeRanges[e];
          if (!r) continue;
          for (let k = r.start * 6; k < (r.start + r.count) * 6; k++) pts.push(edgeSegments[k]);
        }
        for (const v of sel.vertices ?? []) {
          const p = vertexPoint(v, shownView?.edges ?? []);
          if (p) pts.push(...p);
        }
        for (const id of sel.datums ?? []) {
          const d = Object.hasOwn(DEFAULT_DATUMS, id) ? DEFAULT_DATUMS[id] : shownView?.datums?.[id];
          if (d) pts.push(...(d.kind === "point" ? d.at : d.origin));
        }
        if (!pts.length) return false;
        const sphere = new THREE.Sphere().setFromPoints(Array.from({ length: pts.length / 3 }, (_, i) => new THREE.Vector3(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2])));
        // A vertex or a point alone (or a tiny thing): close in on it, but not to nothing. Else tight on what is selected.
        const least = Math.max(radius * 0.05, 0.5);
        fit(undefined, sphere.radius < least ? { center: sphere.center, radius: least } : { points: pts });
        return true;
      },
      previousView() {
        if (history.length < 2) return false;
        history = history.slice(0, -1);
        restoreCamera(history[history.length - 1]);
        return true;
      },
      camera: cameraState,
      goTo: (c: CameraState) => restoreCamera(c),
      look,
      cubeTurn,
      setAreaMode: (on: boolean) => {
        if (on !== areaOn) setArea(on);
      },
      under: underAt,
      unpin: () => controls.pin(null),
      preview(t: PickTarget | null) {
        if (sameTarget(t, peek)) return;
        peek = t;
        hovered = null;
        redrawMarks();
      },
      setCubeVisible(v: boolean) {
        cube.setVisible(v);
        render();
      },
      dispose() {
        ro.disconnect();
        if (settleTimer) clearTimeout(settleTimer);
        if (glideAnim) cancelAnimationFrame(glideAnim.frame);
        canvas.removeEventListener("pointermove", onBoxMove);
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerleave", onLeave);
        canvas.removeEventListener("pointerdown", onDown);
        canvas.removeEventListener("pointerup", onUp);
        canvas.removeEventListener("dblclick", onDblClick);
        el.removeEventListener("pointerdown", handleDown, true);
        el.removeEventListener("pointermove", handleMove, true);
        el.removeEventListener("pointerup", handleUp, true);
        window.removeEventListener("keydown", handleKey, true);
        window.removeEventListener("keydown", escape);
        controls.dispose();
        disposeGroup(model);
        disposeGroup(overlays);
        disposeGroup(helpers);
        disposeGroup(marks);
        disposeGroup(photoGroup);
        disposeGroup(nodeGroup);
        disposeGroup(pivotGroup);
        pivotTexture?.dispose();
        datums.dispose();
        dropCapCache();
        caps.dispose();
        sectionPlanes.dispose();
        evalLayer.dispose();
        cube.dispose();
        triad.dispose();
        labels.remove();
        datumTags.remove();
        photoTexture?.texture.dispose();
        fatMaterials.forEach((m) => m.dispose());
        renderer.dispose();
        renderer.domElement.remove();
      },
    };
    resize();
    rebuildHelpers();
    fit(VIEWS.iso.dir, undefined, undefined, true);
    // The view this document was left at in this browser, if it was (after a sketch, or a reload).
    const remembered = live.current.memoryKey ? loadView(live.current.memoryKey).camera : undefined;
    if (remembered) {
      restoreCamera(remembered, true);
      restoredAtMount.current = true;
    }
    return () => api.current?.dispose();
  }, []);

  useEffect(() => {
    api.current?.setModel(view);
  }, [view]);

  useEffect(() => {
    api.current?.setHiddenBodies(hiddenBodies);
  }, [hiddenBodies]);

  useEffect(() => {
    api.current?.setNodes(nodes);
  }, [nodes]);

  useEffect(() => {
    api.current?.setSelection(selection);
  }, [selection, view]);

  // Re-frame when the app asks (a part opened); not when the view comes back with the camera it remembered.
  const fitSeen = useRef(fitToken);
  useEffect(() => {
    if (fitToken > 0 && !(restoredAtMount.current && fitToken === fitSeen.current)) api.current?.orient("iso", true);
    fitSeen.current = fitToken;
  }, [fitToken]);

  useEffect(() => {
    api.current?.setSketchesVisible(showSketches);
  }, [showSketches]);

  useEffect(() => {
    api.current?.setUnderlay(underlay);
  }, [underlay, view]);

  useEffect(() => {
    api.current?.setDisplay(display);
  }, [display]);

  useEffect(() => {
    api.current?.setSection(section);
  }, [section]);

  useEffect(() => {
    api.current?.setOverlay(overlay);
  }, [overlay]);

  useEffect(() => {
    api.current?.setDims(dims);
  }, [dims]);

  useEffect(() => {
    api.current?.setHandles(handles);
  }, [handles]);

  useEffect(() => {
    api.current?.setFilter(filter);
  }, [filter]);

  // The reference geometry shown: the default planes and every plane, axis and point that built, each by its
  // eye (a selected one always), sized to the part; the origin's triad by its own eye.
  const picked = selection.datums;
  const bbox = view?.measurements?.boundingBox ?? null;
  const shapes = useMemo(() => {
    const all: Record<string, Datum> = { ...Object.fromEntries(DEFAULT_PLANES.map((id) => [id, DEFAULT_DATUMS[id]])), ...(view?.datums ?? {}) };
    const shown = Object.fromEntries(Object.entries(all).filter(([id]) => datumVisible(id, datumView, picked ?? [])));
    return datumShapes(shown, bbox);
  }, [view, datumView, picked, bbox]);
  const originSize = datumVisible("Origin", datumView, picked ?? [])
    ? bbox
      ? Math.max(4, 0.12 * Math.max(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]))
      : 10
    : null;
  useEffect(() => {
    api.current?.setDatums(shapes, originSize);
  }, [shapes, originSize]);

  const prefs = useInputPrefs();
  const vp = useViewPrefs();
  useEffect(() => {
    api.current?.setCubeVisible(vp.viewCube);
  }, [vp.viewCube]);
  const [viewMenu, setViewMenu] = useState<{ x: number; y: number; above?: boolean } | null>(null);
  const [styleMenu, setStyleMenu] = useState<{ x: number; y: number } | null>(null);
  const orient = (name: ViewName) => api.current?.orient(name);
  /** The one flat face or plane selected, for Normal to. */
  const normalFace = (): Vec3 | null => {
    const only = selection.faces.length + selection.edges.length + (selection.vertices?.length ?? 0) + (selection.datums?.length ?? 0) === 1;
    if (!only) return null;
    if (selection.datums?.length) {
      const id = selection.datums[0];
      const d = Object.hasOwn(DEFAULT_DATUMS, id) ? DEFAULT_DATUMS[id] : view?.datums?.[id];
      return d?.kind === "plane" ? d.normal : null;
    }
    const f = selection.faces.length === 1 ? view?.faces[selection.faces[0]] : undefined;
    return f?.type === "plane" && f.normal ? f.normal : null;
  };
  const normalTo = () => {
    const n = normalFace();
    if (n) api.current?.normalTo(n);
    else onMessage?.("Normal to needs one flat face or plane: click one first.");
  };
  const togglePlanes = () => onDatumView?.({ ...datumView, planes: !datumView.planes });
  const setStyle = (s: DisplayStyle) => onDisplay?.({ ...display, style: s });
  const togglePerspective = () => onDisplay?.({ ...display, perspective: !display.perspective });
  const zoomSelection = () => {
    if (!api.current?.zoomToSelection(selection)) onMessage?.("Zoom to selection needs something selected: click a face, an edge, a vertex or a plane first.");
  };
  const previousView = () => {
    if (!api.current?.previousView()) onMessage?.("There is no previous view yet.");
  };
  const toggleArea = () => api.current?.setAreaMode(!areaMode);
  const toggleCube = () => setViewPrefs({ ...vp, viewCube: !vp.viewCube });

  // Named views: saved per document in this browser, in the Views menu (and the Space menu, the same one).
  const [named, setNamed] = useState<NamedView[]>(() => (memoryKey ? (loadView(memoryKey).views ?? []) : []));
  useEffect(() => setNamed(memoryKey ? (loadView(memoryKey).views ?? []) : []), [memoryKey]);
  const storeNamed = (next: NamedView[]) => {
    setNamed(next);
    saveView(memoryKey, { views: next });
  };
  /** Saving a view: the name being typed (null: not saving); renaming one: its name and the new one. */
  const [saving, setSaving] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ from: string; to: string; error?: string } | null>(null);
  const saveCurrentView = (name: string) => {
    const cam = api.current?.camera();
    if (!cam || !name.trim()) return;
    storeNamed(saveNamedView(named, name, cam));
    setSaving(null);
    onMessage?.(`View saved as ${name.trim()}: it is in the Views menu (and the Space menu).`);
  };
  const openViewMenu = (at: { x: number; y: number; above?: boolean }) => {
    setSaving(null);
    setRenaming(null);
    setViewMenu(at);
  };

  /** Select Other at these client pixels (the pointer's, from a key or the palette): every face and edge there, nearest first. */
  const selectOther = (at?: { x: number; y: number }) => {
    const p = at ?? { x: pointer.x, y: pointer.y };
    const list = api.current?.under(p.x, p.y) ?? [];
    if (!list.length) return onMessage?.("Select other lists the faces and edges under the pointer: there are none there.");
    setOthers({ x: p.x, y: p.y, list });
  };

  // The standard view keys: Ctrl+1 to Ctrl+8, F, Z and Shift+Z, the arrows, and Space for the view menu.
  const viewCommands: Record<string, () => void> = {
    "view.front": () => orient("front"),
    "view.back": () => orient("back"),
    "view.left": () => orient("left"),
    "view.right": () => orient("right"),
    "view.top": () => orient("top"),
    "view.bottom": () => orient("bottom"),
    "view.iso": () => orient("iso"),
    "view.dimetric": () => orient("dimetric"),
    "view.trimetric": () => orient("trimetric"),
    "view.normal": normalTo,
    "view.orientation": () => openViewMenu({ x: pointer.x, y: pointer.y }),
    "view.fit": () => api.current?.fit(),
    "view.zoomIn": () => api.current?.zoom(1.25),
    "view.zoomOut": () => api.current?.zoom(0.8),
    "view.rotateLeft": () => api.current?.turn(15, 0),
    "view.rotateRight": () => api.current?.turn(-15, 0),
    "view.rotateUp": () => api.current?.turn(0, 15),
    "view.rotateDown": () => api.current?.turn(0, -15),
    "view.rotateLeft90": () => api.current?.turn(90, 0),
    "view.rotateRight90": () => api.current?.turn(-90, 0),
    "view.rotateUp90": () => api.current?.turn(0, 90),
    "view.rotateDown90": () => api.current?.turn(0, -90),
    "view.panLeft": () => api.current?.pan(-60, 0),
    "view.panRight": () => api.current?.pan(60, 0),
    "view.panUp": () => api.current?.pan(0, -60),
    "view.panDown": () => api.current?.pan(0, 60),
    "view.rollLeft": () => api.current?.roll(15),
    "view.rollRight": () => api.current?.roll(-15),
    "view.planes": togglePlanes,
    "view.zoomSelection": zoomSelection,
    "view.previous": previousView,
    "view.perspective": togglePerspective,
    "view.zoomArea": toggleArea,
    "view.selectOther": () => selectOther(),
    "view.saveView": () => {
      openViewMenu({ x: pointer.x, y: pointer.y });
      setSaving(nextViewName(named));
    },
    "view.cube": toggleCube,
    "view.section": () => onSectionToggle?.(),
    ...Object.fromEntries(DISPLAY_STYLES.map((s) => [s.command, () => setStyle(s.style)])),
  };
  useCommands(viewCommands);
  if (commandsRef) commandsRef.current = (id, at) => (id === "view.selectOther" ? selectOther(at) : viewCommands[id]?.());

  const picking = !!onPhotoPoint;
  useEffect(() => {
    api.current?.setGhost(picking);
    if (picking) api.current?.fitPhoto(); // points on the photo are placed from straight above
  }, [picking, view]);

  const current = DISPLAY_STYLES.find((s) => s.style === display.style) ?? DISPLAY_STYLES[0];
  const sectionPlanesOn = activePlanes(section).length;
  const faces = view?.faces ?? [];
  const edges = view?.edges ?? [];

  return (
    <div className={`viewport${picking ? " picking-photo" : ""}${vp.viewCube ? " with-cube" : ""}`}>
      <div ref={host} className="viewport-canvas" data-testid="viewport" />
      {box && (
        <div
          className={`box-select ${box.area ? "area" : box.crossing ? "crossing" : "window"}`}
          style={{ left: box.x0, top: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 }}
          data-testid={box.area ? "zoom-area-box" : "box-select"}
        />
      )}
      {areaMode && (
        <div className="view-hint" role="status" data-testid="zoom-area-hint">
          <Icon name="zoomArea" />
          Drag a box round the area to zoom to. Esc cancels.
        </div>
      )}
      {pinned && !areaMode && (
        <div className="view-hint pinned-hint" role="status" data-testid="pinned-hint">
          <span className="pin-dot" aria-hidden="true" />
          Turning about the pinned point
          <span className="muted">· middle-click empty space or Esc to clear</span>
          <button onClick={() => api.current?.unpin()} onMouseDown={(e) => e.preventDefault()} aria-label="Clear the pinned rotation centre" title="Clear the pinned rotation centre (Esc)" data-testid="pinned-clear">
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
      {sectionPlanesOn > 0 && (
        <button
          className="section-tag"
          onClick={() => {
            if (section) onSection?.({ ...section, collapsed: false });
            onSectionPanel?.();
          }}
          onMouseDown={(e) => e.preventDefault()}
          title="The section view is on: click for its settings. The view bar's Section button turns it off (its planes are kept)."
          data-testid="section-tag"
        >
          <Icon name="section" size={13} />
          Section{sectionPlanesOn > 1 ? ` · ${sectionPlanesOn} planes` : ""}
        </button>
      )}
      {onFilter && (
        <div className="filter-buttons" role="toolbar" aria-label="Selection filter" onMouseDown={(e) => e.preventDefault()}>
          {FILTER_KINDS.map((f) => {
            const on = filter.has(f.kind);
            return (
              <button
                key={f.kind}
                aria-pressed={on}
                aria-label={`Pick ${f.label.toLowerCase()} only`}
                title={`${on ? "Picking" : "Pick"} ${f.label.toLowerCase()}${filter.size ? "" : " only"}${keyHint(f.command, prefs)}; all off: pick anything`}
                onClick={() => {
                  const next = new Set(filter);
                  if (on) next.delete(f.kind);
                  else next.add(f.kind);
                  onFilter(next);
                }}
                data-testid={`filter-${f.kind}`}
              >
                <Icon name={FILTER_ICON[f.kind]} />
              </button>
            );
          })}
        </div>
      )}
      <div className="view-buttons" role="toolbar" aria-label="Views" onMouseDown={(e) => e.preventDefault()}>
        {QUICK_VIEWS.map((name) => (
          <button
            key={name}
            className="icon-only"
            onClick={() => orient(name)}
            aria-label={name === "iso" ? "Iso" : VIEW_LABEL[name]}
            title={`${name === "iso" ? "Isometric: from the front, right and above" : `${VIEW_LABEL[name]}: look from the ${name}`}${keyHint(`view.${name}`, prefs)}`}
            data-testid={`quick-view-${name}`}
          >
            <Icon name={VIEW_ICON[name]} />
          </button>
        ))}
        <button
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openViewMenu({ x: r.left, y: r.top, above: true });
          }}
          title={`Every view, Normal to, your saved views, the view cube${keyHint("view.orientation", prefs)}`}
          aria-haspopup="menu"
          data-testid="view-menu-open"
        >
          <Icon name="model" />
          Views
          <Icon name="up" size={10} className="caret" />
        </button>
        <span className="sep" />
        <button className="icon-only" onClick={() => api.current?.fit()} aria-label="Fit" title={`Zoom to fit: frame the whole part from the current direction${keyHint("view.fit", prefs)}; a middle double-click does it too`} data-testid="view-fit">
          <Icon name="fit" />
        </button>
        <button className="icon-only" onClick={zoomSelection} title={`Zoom to selection: frame what is selected${keyHint("view.zoomSelection", prefs)}`} aria-label="Zoom to selection" data-testid="view-zoom-selection">
          <Icon name="zoomSelection" />
        </button>
        <button
          className="icon-only"
          onClick={toggleArea}
          aria-pressed={areaMode}
          title={`Zoom to area: drag a box round what you want to see${keyHint("view.zoomArea", prefs)}`}
          aria-label="Zoom to area"
          data-testid="view-zoom-area"
        >
          <Icon name="zoomArea" />
        </button>
        <button className="icon-only" onClick={previousView} title={`Previous view: back to the view before${keyHint("view.previous", prefs)}`} aria-label="Previous view" data-testid="view-previous">
          <Icon name="previousView" />
        </button>
        <span className="sep" />
        <button
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setStyleMenu({ x: r.left, y: r.top });
          }}
          title={`Display style: ${current.label} (shaded, with edges, hidden lines, wireframe)`}
          aria-label={`Display style: ${current.label}`}
          aria-haspopup="menu"
          data-testid="display-style"
        >
          <Icon name={current.icon} />
          <Icon name="up" size={10} className="caret" />
        </button>
        <button
          className="icon-only"
          aria-pressed={!display.perspective}
          onClick={togglePerspective}
          title={`${display.perspective ? "Perspective: click for orthographic (parallel lines stay parallel, as on a drawing)" : "Orthographic: click for perspective"}${keyHint("view.perspective", prefs)}`}
          aria-label={display.perspective ? "Perspective" : "Orthographic"}
          data-testid="view-perspective"
        >
          <Icon name={display.perspective ? "perspective" : "orthographic"} />
        </button>
        <span className="sep" />
        <button
          className="icon-only"
          aria-pressed={sectionPlanesOn > 0}
          onClick={() => onSectionToggle?.()}
          title={`Section view ${sectionPlanesOn > 0 ? "on: click to see the whole part (its planes are kept)" : section ? "off: click to cut the part again" : ": cut the part to see inside"}${keyHint("view.section", prefs)}`}
          aria-label="Section view"
          data-testid="view-section"
        >
          <Icon name="section" />
        </button>
        <button className="icon-only" aria-pressed={showSketches} onClick={() => setShowSketches((v) => !v)} aria-label="Sketches" title="Sketches: show or hide sketch geometry and the frame's nodes" data-testid="view-sketches">
          <Icon name="sketch" />
        </button>
        <button
          className="icon-only"
          aria-pressed={datumView.planes}
          onClick={togglePlanes}
          aria-label="Planes"
          title={`Planes: show or hide the planes, axes and points (a selected one always shows; each has its own eye in the tree)${keyHint("view.planes", prefs)}`}
          data-testid="view-planes"
        >
          <Icon name="plane" />
        </button>
      </div>
      {viewMenu && (
        <Popup
          x={viewMenu.x}
          y={viewMenu.y}
          above={viewMenu.above}
          onClose={() => {
            setViewMenu(null);
            setSaving(null);
            setRenaming(null);
          }}
          label="View orientation"
          testId="view-menu"
        >
          {(close) => (
            <>
              {VIEW_ORDER.map((name) => (
                <MenuItem
                  key={name}
                  icon={VIEW_ICON[name]}
                  label={VIEW_LABEL[name]}
                  hint={name === "iso" ? "Equal angles to X, Y and Z" : name === "dimetric" ? "X and Z full size, Y at half" : name === "trimetric" ? "Each axis shortened differently" : undefined}
                  shortcut={keyHint(`view.${name}`, prefs).slice(2, -1) || undefined}
                  onClick={() => {
                    close();
                    orient(name);
                  }}
                  testId={`view-${name}`}
                />
              ))}
              <MenuItem
                icon="select"
                label="Normal to"
                hint="Square to the selected flat face or plane; again to look from behind it"
                shortcut={keyHint("view.normal", prefs).slice(2, -1)}
                disabled={!normalFace()}
                onClick={() => {
                  close();
                  normalTo();
                }}
                testId="view-normal"
              />
              <div className="menu-sep" />
              <div className="context-heading">Saved views</div>
              {saving === null ? (
                <MenuItem icon="plus" label="Save view…" hint="Keep this view under a name, for this part in this browser" onClick={() => setSaving(nextViewName(named))} testId="view-save" />
              ) : (
                <form
                  className="menu-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveCurrentView(saving);
                    close();
                  }}
                >
                  <input autoFocus value={saving} onChange={(e) => setSaving(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setSaving(null))} aria-label="Name of the view" data-testid="view-save-name" />
                  <button type="submit" className="primary" disabled={!saving.trim()} data-testid="view-save-ok">
                    Save
                  </button>
                </form>
              )}
              {named.length === 0 && saving === null && <div className="menu-note">None yet: Save view… keeps the one you are looking at.</div>}
              {named.map((v) =>
                renaming?.from === v.name ? (
                  <form
                    key={v.name}
                    className="menu-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const next = renameNamedView(named, v.name, renaming.to);
                      if (typeof next === "string") return setRenaming({ ...renaming, error: next });
                      storeNamed(next);
                      setRenaming(null);
                    }}
                  >
                    <input
                      autoFocus
                      value={renaming.to}
                      onChange={(e) => setRenaming({ from: v.name, to: e.target.value })}
                      onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setRenaming(null))}
                      aria-label={`New name for ${v.name}`}
                      aria-invalid={!!renaming.error || undefined}
                      title={renaming.error}
                      data-testid={`named-view-name-${v.name}`}
                    />
                    <button type="submit" className="primary" data-testid={`named-view-rename-ok-${v.name}`}>
                      Rename
                    </button>
                    {renaming.error && <div className="menu-error">{renaming.error}</div>}
                  </form>
                ) : (
                  <div key={v.name} className="named-view" data-testid={`named-view-${v.name}`}>
                    <button
                      className="named-view-go"
                      onClick={() => {
                        close();
                        api.current?.goTo(v.camera);
                      }}
                      title={`Go to ${v.name}`}
                    >
                      <Icon name="view" />
                      <span>{v.name}</span>
                    </button>
                    <button className="named-view-act" aria-label={`Rename ${v.name}`} title="Rename" onClick={() => setRenaming({ from: v.name, to: v.name })} data-testid={`named-view-rename-${v.name}`}>
                      <Icon name="note" size={13} />
                    </button>
                    <button className="named-view-act" aria-label={`Delete ${v.name}`} title="Delete" onClick={() => storeNamed(removeNamedView(named, v.name))} data-testid={`named-view-delete-${v.name}`}>
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                ),
              )}
              <div className="menu-sep" />
              <MenuItem icon="viewCube" label={`${vp.viewCube ? "✓ " : ""}View cube`} hint="The cube in the top right corner: click a face, an edge or a corner" onClick={toggleCube} testId="view-cube-toggle" />
            </>
          )}
        </Popup>
      )}
      {styleMenu && (
        <Popup x={styleMenu.x} y={styleMenu.y} above onClose={() => setStyleMenu(null)} label="Display style" testId="display-menu">
          {(close) => (
            <>
              {DISPLAY_STYLES.map((s) => (
                <MenuItem
                  key={s.style}
                  icon={s.icon}
                  label={`${s.style === display.style ? "✓ " : ""}${s.label}`}
                  hint={s.hint}
                  shortcut={keyHint(s.command, prefs).slice(2, -1) || undefined}
                  onClick={() => {
                    close();
                    setStyle(s.style);
                  }}
                  testId={`display-${s.style}`}
                />
              ))}
              <MenuItem
                icon={display.perspective ? "orthographic" : "perspective"}
                label={display.perspective ? "Orthographic" : "Perspective"}
                hint="Orthographic keeps parallel lines parallel, as on a drawing"
                onClick={() => {
                  close();
                  togglePerspective();
                }}
                testId="display-perspective"
              />
            </>
          )}
        </Popup>
      )}
      {others && (
        <Popup
          x={others.x}
          y={others.y}
          onClose={() => {
            api.current?.preview(null);
            setOthers(null);
          }}
          label="Select other"
          testId="select-other"
        >
          {(close) => (
            <>
              <div className="context-heading">Under the pointer, nearest first</div>
              {others.list.map((h, i) => (
                <button
                  key={`${h.target.kind}:${h.target.index}`}
                  role="menuitem"
                  title={`${i === 0 ? "The one a plain click picks. " : ""}Click to select it; Ctrl-click to add it to the selection`}
                  onPointerEnter={() => api.current?.preview(h.target)}
                  onPointerLeave={() => api.current?.preview(null)}
                  onFocus={() => api.current?.preview(h.target)}
                  onClick={(e) => {
                    api.current?.preview(null);
                    close();
                    onPick(h.target, e.ctrlKey || e.shiftKey || e.metaKey);
                  }}
                  data-testid={`select-other-${i}`}
                >
                  <Icon name={h.target.kind === "face" ? "filterFaces" : "filterEdges"} />
                  <span>{otherLabel(h.target, faces, edges)}</span>
                  {i === 0 && <span className="menu-note-inline">front</span>}
                </button>
              ))}
            </>
          )}
        </Popup>
      )}
      <SelectionChip selection={selection} faces={faces} edges={edges} datums={view?.datums ?? {}} />
      {hover && !box && !areaMode && <PickTip hover={hover} info={infoRef.current} />}
    </div>
  );
}

function PickTip({ hover, info }: { hover: Hover; info: { faces: FaceInfo[]; edges: EdgeInfo[]; datums: Record<string, Datum> } }) {
  const t = hover.target;
  const face = t.kind === "face" ? info.faces[t.index] : undefined;
  const text =
    t.kind === "datum"
      ? describeDatum(t.id, info.datums)
      : t.kind === "vertex"
        ? describeVertex({ edge: t.edge, at: t.at }, info.edges)
        : t.kind === "face"
          ? describeFace(face)
          : describeEdge(info.edges[t.index]);
  return (
    <div className="face-tip" style={{ left: hover.x + 14, top: hover.y + 14 }} data-testid="pick-tip">
      <div>{text}</div>
      {face && <div className="muted">area {fmt(face.area)} mm²</div>}
    </div>
  );
}

function SelectionChip({ selection, faces, edges, datums }: { selection: Selection; faces: FaceInfo[]; edges: EdgeInfo[]; datums: Record<string, Datum> }) {
  const text = selectionText(selection, faces, edges, datums);
  if (!text) return null;
  return (
    <div className="selection-chip" data-testid="selection" title="Ctrl- or Shift-click adds a face, an edge, a vertex or a plane, or takes it out again; drag a box to select several">
      Selected: {text}
    </div>
  );
}

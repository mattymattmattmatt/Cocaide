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
import { DEFAULT_DISPLAY, DISPLAY_STYLES, loadView, pushView, saveView, type CameraState, type DisplayState, type DisplayStyle } from "./evaluate/display";
import type { Dimension3D } from "./evaluate/dimensions3d";
import { allows, boxOf, boxSelect, FILTER_KINDS, NO_FILTER, type Projected, type SelectFilter } from "./evaluate/filter";
import { alongAxis, dragValue, type HandleSpec } from "./evaluate/handles";
import { sectionPlane, type SectionState } from "./evaluate/section";
import { Icon, type IconName } from "./icons";
import { inputPrefs, keyHint, pointer, useCommands, useInputPrefs } from "./input";
import { datumShapes, datumVisible, DEFAULT_DATUM_VIEW, DEFAULT_PLANES, type DatumShape, type DatumView } from "./model/datumDisplay";
import { describeDatum, describeEdge, describeFace, describeVertex, EMPTY_SELECTION, fmt, selectionText, vertexPoint, type PickTarget, type Selection, type VertexPick } from "./model/selection";
import { MenuItem, Popup } from "./tools";
import { DatumLayer, type DatumLabel } from "./viewport/datums";
import { EvalLayer, type EvalOverlay } from "./viewport/evalLayer";
import { SectionCaps } from "./viewport/sectionCaps";
import { adjacency, silhouette, type Adjacency } from "./viewport/silhouette";

/** The seven standard views, in this part's axes (Z up; Front looks along +Y). */
export type ViewName = "front" | "back" | "left" | "right" | "top" | "bottom" | "iso";

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
  /** Set by the view: runs one of its commands ("view.fit", "view.normal", "view.top"…), for the right-click menu. */
  commandsRef?: { current: ((id: string) => void) | null };
  /** What is shown of the reference geometry (planes, axes, points, the origin): view state, kept by the app. */
  datumView?: DatumView;
  /** The "Planes" toggle (and its key): every plane, axis and point shown or hidden. */
  onDatumView?(next: DatumView): void;
  /** How the part is drawn: display style and perspective (view state, kept by the app per document). */
  display?: DisplayState;
  onDisplay?(next: DisplayState): void;
  /** The document's name: the camera is remembered under it in this browser, and comes back when the view does. */
  memoryKey?: string;
  /** A section through the part (null: none). */
  section?: SectionState | null;
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

/** Where each view looks from (toward the camera), and which way is up on the screen. */
const VIEWS: Record<ViewName, { dir: Vec3; up: Vec3 }> = {
  front: { dir: [0, -1, 0], up: [0, 0, 1] },
  back: { dir: [0, 1, 0], up: [0, 0, 1] },
  left: { dir: [-1, 0, 0], up: [0, 0, 1] },
  right: { dir: [1, 0, 0], up: [0, 0, 1] },
  // Third-angle: the top view's bottom edge is the front, and the bottom view's top edge is.
  top: { dir: [0, 0, 1], up: [0, 1, 0] },
  bottom: { dir: [0, 0, -1], up: [0, -1, 0] },
  iso: { dir: [1, -1, 0.8], up: [0, 0, 1] },
};
const VIEW_ORDER: ViewName[] = ["front", "back", "left", "right", "top", "bottom", "iso"];
const VIEW_ICON: Record<ViewName, IconName> = { front: "front", back: "front", left: "right", right: "right", top: "top", bottom: "top", iso: "iso" };
const VIEW_LABEL: Record<ViewName, string> = { front: "Front", back: "Back", left: "Left", right: "Right", top: "Top", bottom: "Bottom", iso: "Isometric" };
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
  /** Keyboard view moves: degrees, pixels, a zoom factor. */
  turn(yawDeg: number, pitchDeg: number): void;
  pan(dx: number, dy: number): void;
  zoom(factor: number): void;
  roll(deg: number): void;
  /** How the part is drawn. */
  setDisplay(d: DisplayState): void;
  setSection(s: SectionState | null): void;
  setOverlay(o: EvalOverlay | null): void;
  setDims(d: Dimension3D[]): void;
  setHandles(h: HandleSpec[]): void;
  setFilter(f: SelectFilter): void;
  /** Frames what is selected, from where the camera is. False when nothing is selected. */
  zoomToSelection(sel: Selection): boolean;
  /** Back to the view before this one. False when there is none. */
  previousView(): boolean;
  dispose(): void;
}

const NO_BODIES: ReadonlySet<string> = new Set();

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
  const live = useRef({ onHandle, onHandleLabel, onDimension, onBox, onDoubleClick, memoryKey, onMessage });
  live.current = { onHandle, onHandleLabel, onDimension, onBox, onDoubleClick, memoryKey, onMessage };
  const [hover, setHover] = useState<Hover | null>(null);
  const [showSketches, setShowSketches] = useState(true);
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number; crossing: boolean } | null>(null);
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
    let perspective = true;
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
    camera.add(key, fill);
    scene.add(camera);

    const model = new THREE.Group();
    const overlays = new THREE.Group();
    const helpers = new THREE.Group();
    const marks = new THREE.Group(); // hover and selection highlights
    const photoGroup = new THREE.Group(); // the pinned photo and its scale line
    const nodeGroup = new THREE.Group(); // a frame's nodes
    // Planes, axes, points and the origin triad.
    const datums = new DatumLayer({ plane: 0x4f7fbf, border: 0x3a6aa6, axis: 0x3a4a63, point: 0x2f4f7f, select: SELECT_COLOR, hover: HOVER_COLOR });
    // The section's cap, and the Evaluate tools' marks, handles and labels.
    const caps = new SectionCaps(cssColor(el, "--section-cap", "#e9a23b"), cssColor(el, "--section-hatch", "#9a5b10"));
    const evalLayer = new EvalLayer(el, {
      onDimension: (d, x, y) => live.current.onDimension?.(d, x, y),
      onHandleLabel: (h, x, y) => live.current.onHandleLabel?.(h, x, y),
    });
    scene.add(helpers, photoGroup, model, datums.group, caps.group, overlays, marks, nodeGroup, evalLayer.group);
    let photoMesh: THREE.Mesh | null = null;
    let photo: Underlay | null = null;
    let photoTexture: { url: string; texture: THREE.Texture } | null = null;

    let mesh: THREE.Mesh | null = null;
    let edgeLines: THREE.LineSegments | null = null;
    /** The edges again, dashed, drawn only where they are hidden (Hidden lines visible). */
    let hiddenLines: THREE.LineSegments | null = null;
    /** The outlines of curved faces, for the line styles; recomputed as the view turns. */
    let outline: { adj: Adjacency; seen: THREE.LineSegments; hidden: THREE.LineSegments } | null = null;
    /** Segment index -> B-rep edge index, for the drawn (non-seam) edges. */
    let segmentEdge: Int32Array = new Int32Array(0);
    let faceRanges: { start: number; count: number }[] = [];
    let edgeRanges: { start: number; count: number }[] = [];
    let edgeSegments: Float32Array = new Float32Array(0);
    let selection: Selection = EMPTY_SELECTION;
    let hovered: PickTarget | null = null;
    /** One end of an edge per vertex of the part (the lowest edge that ends there stands for it), for picking vertices. */
    let vertices: (VertexPick & { p: Vec3 })[] = [];
    let shownView: RebuildView | null = null;
    let hidden: ReadonlySet<string> = NO_BODIES;
    let style: DisplayStyle = DEFAULT_DISPLAY.style;
    let pickFilter: SelectFilter = NO_FILTER;
    let handleList: HandleSpec[] = [];
    /** The section's clipping plane (keeps where its signed distance is ≥ 0), while a section is on. */
    const clip = new THREE.Plane();
    let sectionState: SectionState | null = null;
    const clipping = () => (sectionState ? [clip] : []);
    /** Is this face or edge in a hidden body? */
    const isHidden = (body: string | undefined) => body !== undefined && hidden.has(body);
    /** Is this point on the side the section cuts away? */
    const cutAway = (p: THREE.Vector3 | Vec3) => !!sectionState && clip.distanceToPoint(Array.isArray(p) ? new THREE.Vector3(...p) : p) < -1e-6;

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
      if (!outline) return;
      const want = style === "hiddenRemoved" || style === "hiddenVisible" || style === "wireframe";
      outline.seen.visible = want;
      outline.hidden.visible = want && style === "hiddenVisible";
      if (!want) return;
      const look = controls.target.clone().sub(camera.position).normalize();
      const segs = silhouette(outline.adj, perspective ? (camera.position.toArray() as Vec3) : null, look.toArray() as Vec3);
      for (const obj of [outline.seen, outline.hidden]) {
        obj.geometry.setAttribute("position", new THREE.BufferAttribute(segs, 3));
        obj.geometry.computeBoundingSphere();
      }
      outline.hidden.computeLineDistances();
    };

    const render = () => {
      if (!perspective) syncOrtho();
      updateOutline();
      renderer.render(scene, eye());
      evalLayer.update(eye(), controls.worldPerPixel(), el.clientWidth, el.clientHeight);
      placeLabels();
      placeDatumLabels();
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
    const restoreCamera = (c: CameraState) => {
      const target = new THREE.Vector3(...c.target);
      const from = new THREE.Vector3(...c.position).sub(target);
      const dist = from.length();
      if (dist < 1e-9) return;
      controls.place(target, from.normalize(), dist, new THREE.Vector3(...c.up));
    };

    /** The point the next rotation turns about, after a middle click on the part. */
    const pivotGroup = new THREE.Group();
    scene.add(pivotGroup);
    const controls = new CadControls(camera, renderer.domElement, {
      pick: (x, y) => {
        const t = pickAt(x, y, true);
        return t ? new THREE.Vector3(...t.point) : null;
      },
      fit: () => fit(),
      showPivot: (p) => {
        disposeGroup(pivotGroup);
        if (p) {
          const g = new THREE.BufferGeometry().setFromPoints([p]);
          const dot = new THREE.Points(g, new THREE.PointsMaterial({ color: SELECT_COLOR, size: 10, sizeAttenuation: false, depthTest: false }));
          dot.renderOrder = 5;
          pivotGroup.add(dot);
        }
        render();
      },
      changed: render,
    });

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = el;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      for (const m of fatMaterials) m.resolution.set(w, h);
      datums.resize(w, h);
      evalLayer.resize(w, h);
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

    const fatMaterials = [SELECT_COLOR, HOVER_COLOR, SCALE_COLOR, SCALE_CONFIRMED_COLOR].map(
      (color) => new LineMaterial({ color, linewidth: 3.5, depthTest: false, transparent: true }),
    );
    const [selectEdgeMat, hoverEdgeMat, scaleMat, scaleConfirmedMat] = fatMaterials;

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

    /** Frames the part (or `on`) from `dir`, or from where the camera is now. */
    const fit = (dir?: Vec3, on = { center, radius }, up?: Vec3) => {
      const d = new THREE.Vector3(...(dir ?? (camera.position.clone().sub(controls.target).toArray() as Vec3)));
      if (d.lengthSq() === 0) d.set(...VIEWS.iso.dir);
      d.normalize();
      // Looking straight down or up, +Y is up the screen (-Y from below); otherwise +Z.
      const u = new THREE.Vector3(...(up ?? (dir ? (Math.abs(d.z) > 0.999 ? [0, Math.sign(d.z), 0] : [0, 0, 1]) : (camera.up.toArray() as Vec3))));
      const dist = (on.radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.15;
      controls.place(on.center, d, dist, u);
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
    const faceMesh = (indices: number[], color: number, opacity: number) => {
      const g = faceGeometry(indices);
      if (!g) return null;
      const m = new THREE.Mesh(
        g,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, clippingPlanes: clipping() }),
      );
      m.renderOrder = 4;
      return m;
    };

    /** Fat lines along some B-rep edges. */
    const edgeMarks = (indices: number[], material: LineMaterial) => {
      const pts: number[] = [];
      for (const i of indices) {
        const r = edgeRanges[i];
        if (!r) continue;
        for (let k = r.start * 6; k < (r.start + r.count) * 6; k++) pts.push(edgeSegments[k]);
      }
      if (pts.length === 0) return null;
      const g = new LineSegmentsGeometry();
      g.setPositions(pts);
      const line = new LineSegments2(g, material);
      line.renderOrder = 5;
      return line;
    };

    /** Dots on vertices (selected, or the one under the pointer). */
    const vertexDots = (points: Vec3[], color: number, size: number) => {
      if (!points.length) return null;
      const g = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(...p)));
      const dots = new THREE.Points(g, new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false, clippingPlanes: clipping() }));
      dots.renderOrder = 6;
      return dots;
    };

    const redrawMarks = () => {
      disposeGroup(marks);
      const edges = shownView?.edges ?? [];
      const pickedVertices = (selection.vertices ?? []).map((v) => vertexPoint(v, edges)).filter((p): p is Vec3 => !!p);
      const sel = [faceMesh(selection.faces, SELECT_COLOR, 0.45), edgeMarks(selection.edges, selectEdgeMat), vertexDots(pickedVertices, SELECT_COLOR, 10)];
      const hov =
        hovered?.kind === "face" && !selection.faces.includes(hovered.index)
          ? faceMesh([hovered.index], HOVER_COLOR, 0.3)
          : hovered?.kind === "edge" && !selection.edges.includes(hovered.index)
            ? edgeMarks([hovered.index], hoverEdgeMat)
            : hovered?.kind === "vertex"
              ? vertexDots([hovered.point], HOVER_COLOR, 10)
              : null;
      for (const o of [...sel, hov]) if (o) marks.add(o);
      datums.mark(selection.datums ?? [], hovered?.kind === "datum" ? hovered.id : null);
      relabelDatums();
      render();
    };

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
        const mat = edgeLines.material as THREE.LineBasicMaterial;
        mat.depthTest = style !== "wireframe";
        mat.needsUpdate = true;
      }
      if (hiddenLines) hiddenLines.visible = style === "hiddenVisible";
      if (outline) {
        (outline.seen.material as THREE.LineBasicMaterial).depthTest = style !== "wireframe";
        (outline.seen.material as THREE.Material).needsUpdate = true;
      }
      render();
    };

    /** The visible bodies' triangles (what the section caps). */
    const visibleGeometry = () => {
      if (!mesh) return null;
      const faces = shownView?.faces ?? [];
      if (!faces.some((f) => isHidden(f.body))) return mesh.geometry;
      return faceGeometry(faces.map((f, i) => (isHidden(f.body) ? -1 : i)).filter((i) => i >= 0));
    };
    let capGeometry: THREE.BufferGeometry | null = null;
    /** The section on the part: every material clipped, the cut capped. */
    const applySection = () => {
      if (sectionState) {
        const p = sectionPlane(sectionState);
        // three keeps where the signed distance is positive: the side away from the normal.
        clip.set(new THREE.Vector3(...p.normal).negate(), p.constant);
      }
      const planes = clipping();
      const clipAll = (g: THREE.Object3D) =>
        g.traverse((o) => {
          const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
          for (const m of [mat ?? []].flat()) {
            m.clippingPlanes = planes;
            m.needsUpdate = true;
          }
        });
      clipAll(model);
      clipAll(marks);
      for (const m of fatMaterials) {
        m.clippingPlanes = planes;
        m.needsUpdate = true;
      }
      if (capGeometry && capGeometry !== mesh?.geometry) capGeometry.dispose();
      capGeometry = sectionState ? visibleGeometry() : null;
      caps.set(capGeometry, sectionState ? clip : null, radius + center.length());
      render();
    };

    const setModel = (v: RebuildView | null) => {
      shownView = v;
      disposeGroup(model);
      disposeGroup(overlays);
      mesh = null;
      edgeLines = null;
      hiddenLines = null;
      outline = null;
      hovered = null;
      vertices = [];
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
          new THREE.MeshStandardMaterial({ color, metalness: 0.15, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, visible, clippingPlanes: clipping() });
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
        // Draw every edge except seams; remember which edge each segment belongs to.
        const pts: number[] = [];
        const owners: number[] = [];
        edgeRanges.forEach((r, i) => {
          if (v.edges[i]?.seam || isHidden(v.edges[i]?.body)) return;
          for (let k = r.start; k < r.start + r.count; k++) {
            for (let c = 0; c < 6; c++) pts.push(edgeSegments[k * 6 + c]);
            owners.push(i);
          }
        });
        segmentEdge = Int32Array.from(owners);
        // The part's vertices: the ends of its drawn edges (not a whole circle's seam point), one edge standing for each.
        const seen = new Map<string, VertexPick & { p: Vec3 }>();
        v.edges.forEach((e, i) => {
          if (e.seam || isHidden(e.body) || Math.hypot(e.end[0] - e.start[0], e.end[1] - e.start[1], e.end[2] - e.start[2]) < 1e-6) return;
          for (const at of ["start", "end"] as const) {
            const p = at === "start" ? e.start : e.end;
            const key = p.map((x) => Math.round(x * 1e4)).join(",");
            if (!seen.has(key)) seen.set(key, { edge: i, at, p });
          }
        });
        vertices = [...seen.values()];
        const edgeColor = cssColor(el, "--edge", "#1f2937");
        const eg = new THREE.BufferGeometry();
        eg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
        edgeLines = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: edgeColor, clippingPlanes: clipping() }));
        model.add(edgeLines);
        center = g.boundingSphere!.center.clone();
        radius = Math.max(1, g.boundingSphere!.radius);
        // Hidden lines, dashed and fainter, drawn only where something is in front of them.
        const dashed = (geometry: THREE.BufferGeometry) =>
          new THREE.LineSegments(
            geometry,
            new THREE.LineDashedMaterial({ color: edgeColor, dashSize: radius / 45, gapSize: radius / 70, transparent: true, opacity: 0.45, depthFunc: THREE.GreaterDepth, depthWrite: false, clippingPlanes: clipping() }),
          );
        hiddenLines = dashed(eg);
        hiddenLines.computeLineDistances();
        hiddenLines.renderOrder = 1;
        model.add(hiddenLines);
        // The curved faces' outlines (seen, and hidden dashed), for the line styles.
        const curved = v.faces.map((f) => f.type !== "plane" && !isHidden(f.body));
        const adj = adjacency(v.mesh.positions, v.mesh.indices, faceRanges, curved);
        const seenOutline = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: edgeColor, clippingPlanes: clipping() }));
        const hiddenOutline = dashed(new THREE.BufferGeometry());
        hiddenOutline.renderOrder = 1;
        model.add(seenOutline, hiddenOutline);
        outline = { adj, seen: seenOutline, hidden: hiddenOutline };
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
      rebuildHelpers();
      applyDisplay();
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
    const pickPart = (clientX: number, clientY: number, everything = false): { target: PickTarget; distance: number } | null => {
      if (!mesh) return null;
      const may = (kind: PickTarget["kind"]) => everything || allows(pickFilter, kind);
      const faceAt = (h: THREE.Intersection) => {
        if (h.faceIndex === undefined || h.faceIndex === null) return -1;
        const tri = h.faceIndex * 3;
        return faceRanges.findIndex((r) => tri >= r.start && tri < r.start + r.count);
      };
      // Hidden bodies are still in the mesh: look through them, and through what a section cuts away.
      const faceHit = raycaster.intersectObject(mesh, false).find((h) => !isHidden(shownView?.faces[faceAt(h)]?.body) && !cutAway(h.point));
      const worldPerPixel = controls.worldPerPixel();
      const slack = 2 * PICK_PIXELS * worldPerPixel;
      raycaster.params.Line = { threshold: PICK_PIXELS * worldPerPixel };
      const edgeHit = edgeLines && may("edge") ? raycaster.intersectObject(edgeLines, false).find((h) => !cutAway(h.point)) : undefined;
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
          if (cutAway(v.p)) continue;
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

    /** The part on screen, for a box: each face's triangles, each edge's segments, each vertex (null: off screen or cut away). */
    const projected = (): Projected => {
      const out: Projected = { faces: [], edges: [], vertices: [] };
      if (!mesh || !shownView) return out;
      const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
      const idx = mesh.geometry.getIndex()!.array as Uint32Array;
      const cache = new Map<number, Vec2 | null>();
      const at = (p: Vec3): Vec2 | null => {
        if (cutAway(p)) return null;
        const s = project(p);
        return s ? [s.x, s.y] : null;
      };
      const vertexAt = (i: number) => {
        if (!cache.has(i)) cache.set(i, at([pos.getX(i), pos.getY(i), pos.getZ(i)]));
        return cache.get(i)!;
      };
      out.faces = faceRanges.map((r, f) => {
        if (isHidden(shownView!.faces[f]?.body)) return [];
        const tris: (Vec2 | null)[][] = [];
        for (let t = r.start; t < r.start + r.count; t += 3) tris.push([vertexAt(idx[t]), vertexAt(idx[t + 1]), vertexAt(idx[t + 2])]);
        return tris;
      });
      out.edges = edgeRanges.map((r, e) => {
        const info = shownView!.edges[e];
        if (!info || info.seam || isHidden(info.body)) return [];
        const segs: [Vec2 | null, Vec2 | null][] = [];
        for (let k = r.start; k < r.start + r.count; k++) {
          const a: Vec3 = [edgeSegments[k * 6], edgeSegments[k * 6 + 1], edgeSegments[k * 6 + 2]];
          const b: Vec3 = [edgeSegments[k * 6 + 3], edgeSegments[k * 6 + 4], edgeSegments[k * 6 + 5]];
          segs.push([at(a), at(b)]);
        }
        return segs;
      });
      out.vertices = vertices.map((v) => ({ edge: v.edge, at: v.at, p: at(v.p) }));
      return out;
    };

    /** The same thing (a face, an edge, a vertex or a datum), wherever on it. */
    const targetKey = (t: PickTarget | null) => (!t ? "" : t.kind === "datum" ? `d:${t.id}` : t.kind === "vertex" ? `v:${t.edge}:${t.at}` : `${t.kind}:${t.index}`);
    const sameTarget = (a: PickTarget | null, b: PickTarget | null) => targetKey(a) === targetKey(b);
    // A handle being dragged: which one, how far along its arrow the drag started, and the value now.
    let drag: { h: HandleSpec; t0: number; value: number; id: number } | null = null;
    const onMove = (e: PointerEvent) => {
      if (drag) return;
      if (boxing) return moveBox(e);
      if (e.buttons !== 0 || photoPointRef.current) return;
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
    // A left drag on the view (the standard mouse) draws a selection box.
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
      setBox({ ...b.rect, crossing: b.crossing });
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
        const b = boxOf([start.x, start.y], [e.clientX, e.clientY]);
        live.current.onBox?.(boxSelect(b.rect, b.crossing, projected(), pickFilter), start.shift);
        return;
      }
      if (moved > 4) return;
      if (e.button === 0 && photoPointRef.current) {
        const px = photoPixelAt(e.clientX, e.clientY);
        if (px) photoPointRef.current(px);
        return;
      }
      if (e.button === 2) contextRef.current?.(pickAt(e.clientX, e.clientY), e.clientX, e.clientY);
      else pickRef.current(pickAt(e.clientX, e.clientY), e.shiftKey || e.ctrlKey || e.metaKey);
    };
    // A left press that travels starts a box (the standard mouse: the trackpad scheme's left drag turns the view).
    const onBoxMove = (e: PointerEvent) => {
      if (!down || down.button !== 0 || boxing || drag || photoPointRef.current) return;
      if (inputPrefs().mouse !== "standard" || e.pointerType === "touch" || !live.current.onBox) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) < BOX_SLOP) return;
      boxing = true;
      if (hovered) onLeave();
      renderer.domElement.setPointerCapture?.(e.pointerId);
      moveBox(e);
    };
    const onDblClick = (e: MouseEvent) => {
      if (photoPointRef.current) return;
      live.current.onDoubleClick?.(pickAt(e.clientX, e.clientY));
    };
    const canvas = renderer.domElement;
    canvas.addEventListener("pointermove", onBoxMove);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("dblclick", onDblClick);

    // Handles are grabbed before anything else sees the press (the controls would turn the view, a click would pick).
    const handleDown = (e: PointerEvent) => {
      if (e.button !== 0 || !handleList.length) return;
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
      drag = { h, t0, value: h.value, id: e.pointerId };
      el.setPointerCapture?.(e.pointerId);
      renderer.domElement.style.cursor = "grabbing";
      hovered = null;
      setHover(null);
      evalLayer.setHandles(handleList, { h, value: h.value });
      live.current.onHandle?.(h, "start", h.value);
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
      evalLayer.setHandles(handleList, { h: drag.h, value });
      live.current.onHandle?.(drag.h, "move", value);
      render();
    };
    const endDrag = (e: PointerEvent | KeyboardEvent, phase: "end" | "cancel") => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if ("pointerId" in e && el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
      renderer.domElement.style.cursor = "";
      evalLayer.setHandles(handleList, null);
      live.current.onHandle?.(d.h, phase, phase === "end" ? d.value : d.h.value);
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
    el.addEventListener("pointerdown", handleDown, true);
    el.addEventListener("pointermove", handleMove, true);
    el.addEventListener("pointerup", handleUp, true);
    window.addEventListener("keydown", handleKey, true);

    // Automation hook for end-to-end tests (only with ?e2e in the URL): world point -> client pixels.
    if (new URLSearchParams(location.search).has("e2e")) {
      const toScreen = (p: Vec3): [number, number] => {
        const v = new THREE.Vector3(...p).project(eye());
        const rect = canvas.getBoundingClientRect();
        return [rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height];
      };
      (window as unknown as { __cocaideViewport?: unknown }).__cocaideViewport = {
        project: toScreen,
        /** Where the camera is, what it looks at, and which way is up. */
        camera() {
          const r = (v: THREE.Vector3) => v.toArray().map((x) => Math.round(x * 1e4) / 1e4 + 0) as Vec3;
          return { position: r(camera.position), target: r(controls.target), up: r(camera.up) };
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
          const v = photoToWorld(photo, px, -Math.max(0.05, radius * 0.002)).project(eye());
          const rect = canvas.getBoundingClientRect();
          return [rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height];
        },
        /** How the part is drawn now. */
        display() {
          return { style, perspective, edgesShown: edgeLines?.visible ?? false, surfacesShown: !!mesh?.visible && ([mesh.material].flat() as THREE.Material[])[0]?.colorWrite !== false };
        },
        /** The section on now: the plane's normal (into the part kept) and constant, and whether the cap is drawn. */
        section() {
          return sectionState ? { normal: clip.normal.toArray().map((x) => x + 0), constant: clip.constant + 0, capped: caps.group.visible } : null;
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
      fit: (dir?: Vec3, up?: Vec3) => fit(dir, undefined, up),
      normalTo(n: Vec3) {
        const normal = new THREE.Vector3(...n).normalize();
        const { forward, up } = controls.axes();
        // Pressed again while square to the face: look at it from behind.
        const from = forward.dot(normal) < -0.999 ? normal.clone().negate() : normal;
        // Keep the screen's up as near as it was.
        const u = up.clone().addScaledVector(from, -up.dot(from));
        if (u.lengthSq() < 1e-6) u.set(...(Math.abs(from.z) > 0.999 ? ([0, 1, 0] as Vec3) : ([0, 0, 1] as Vec3)));
        fit(from.toArray() as Vec3, { center: controls.target.clone(), radius }, u.normalize().toArray() as Vec3);
      },
      turn: (yaw: number, pitch: number) => controls.turn(THREE.MathUtils.degToRad(yaw), THREE.MathUtils.degToRad(pitch)),
      pan: (dx: number, dy: number) => controls.pan(dx, dy),
      zoom: (f: number) => controls.zoom(f),
      roll: (deg: number) => controls.roll(THREE.MathUtils.degToRad(deg)),
      setDisplay(d: DisplayState) {
        style = d.style;
        perspective = d.perspective;
        applyDisplay();
      },
      setSection(s: SectionState | null) {
        sectionState = s;
        applySection();
        // What is cut away can't stay under the pointer.
        if (hovered && "point" in hovered && cutAway(hovered.point)) onLeave();
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
        // While one is dragged, it keeps its drag (the app's new numbers are the drag's own).
        const still = drag ? h.find((x) => x.id === drag!.h.id) : undefined;
        if (drag && !still) drag = null;
        evalLayer.setHandles(h, drag ? { h: drag.h, value: drag.value } : null);
        render();
      },
      setFilter(f: SelectFilter) {
        pickFilter = f;
        if (hovered && !allows(f, hovered.kind)) onLeave();
      },
      zoomToSelection(sel: Selection) {
        const pts: THREE.Vector3[] = [];
        const pos = mesh?.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
        const idx = mesh?.geometry.getIndex()?.array as Uint32Array | undefined;
        if (pos && idx) {
          for (const f of sel.faces) {
            const r = faceRanges[f];
            if (!r) continue;
            for (let t = r.start; t < r.start + r.count; t++) pts.push(new THREE.Vector3(pos.getX(idx[t]), pos.getY(idx[t]), pos.getZ(idx[t])));
          }
        }
        for (const e of sel.edges) {
          const r = edgeRanges[e];
          if (!r) continue;
          for (let k = r.start * 6; k < (r.start + r.count) * 6; k += 3) pts.push(new THREE.Vector3(edgeSegments[k], edgeSegments[k + 1], edgeSegments[k + 2]));
        }
        for (const v of sel.vertices ?? []) {
          const p = vertexPoint(v, shownView?.edges ?? []);
          if (p) pts.push(new THREE.Vector3(...p));
        }
        for (const id of sel.datums ?? []) {
          const d = Object.hasOwn(DEFAULT_DATUMS, id) ? DEFAULT_DATUMS[id] : shownView?.datums?.[id];
          if (d) pts.push(new THREE.Vector3(...(d.kind === "point" ? d.at : d.origin)));
        }
        if (!pts.length) return false;
        const sphere = new THREE.Sphere().setFromPoints(pts);
        // A vertex or a point alone: close in on it, but not to nothing.
        fit(undefined, { center: sphere.center, radius: Math.max(sphere.radius, radius * 0.05, 0.5) });
        return true;
      },
      previousView() {
        if (history.length < 2) return false;
        history = history.slice(0, -1);
        restoreCamera(history[history.length - 1]);
        return true;
      },
      dispose() {
        ro.disconnect();
        if (settleTimer) clearTimeout(settleTimer);
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
        controls.dispose();
        disposeGroup(model);
        disposeGroup(overlays);
        disposeGroup(helpers);
        disposeGroup(marks);
        disposeGroup(photoGroup);
        disposeGroup(nodeGroup);
        disposeGroup(pivotGroup);
        datums.dispose();
        caps.dispose();
        if (capGeometry && capGeometry !== mesh?.geometry) capGeometry.dispose();
        evalLayer.dispose();
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
    fit(VIEWS.iso.dir);
    // The view this document was left at in this browser, if it was (after a sketch, or a reload).
    const remembered = live.current.memoryKey ? loadView(live.current.memoryKey).camera : undefined;
    if (remembered) {
      restoreCamera(remembered);
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
    if (fitToken > 0 && !(restoredAtMount.current && fitToken === fitSeen.current)) api.current?.fit(VIEWS.iso.dir);
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
  const [viewMenu, setViewMenu] = useState<{ x: number; y: number; above?: boolean } | null>(null);
  const [styleMenu, setStyleMenu] = useState<{ x: number; y: number } | null>(null);
  const orient = (name: ViewName) => api.current?.fit(VIEWS[name].dir, VIEWS[name].up);
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
  // The standard view keys: Ctrl+1 to Ctrl+8, F, Z and Shift+Z, the arrows, and Space for the view menu.
  const viewCommands: Record<string, () => void> = {
    "view.front": () => orient("front"),
    "view.back": () => orient("back"),
    "view.left": () => orient("left"),
    "view.right": () => orient("right"),
    "view.top": () => orient("top"),
    "view.bottom": () => orient("bottom"),
    "view.iso": () => orient("iso"),
    "view.normal": normalTo,
    "view.orientation": () => setViewMenu({ x: pointer.x, y: pointer.y }),
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
    ...Object.fromEntries(DISPLAY_STYLES.map((s) => [s.command, () => setStyle(s.style)])),
  };
  useCommands(viewCommands);
  if (commandsRef) commandsRef.current = (id) => viewCommands[id]?.();

  const picking = !!onPhotoPoint;
  useEffect(() => {
    api.current?.setGhost(picking);
    if (picking) api.current?.fitPhoto(); // points on the photo are placed from straight above
  }, [picking, view]);

  const current = DISPLAY_STYLES.find((s) => s.style === display.style) ?? DISPLAY_STYLES[0];

  return (
    <div className={`viewport${picking ? " picking-photo" : ""}`}>
      <div ref={host} className="viewport-canvas" data-testid="viewport" />
      {box && (
        <div
          className={`box-select ${box.crossing ? "crossing" : "window"}`}
          style={{ left: box.x0, top: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 }}
          data-testid="box-select"
        />
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
          <button key={name} onClick={() => orient(name)} title={`${name === "iso" ? "Look from the front, right and above" : `Look from the ${name}`}${keyHint(`view.${name}`, prefs)}`}>
            <Icon name={VIEW_ICON[name]} />
            {name[0].toUpperCase() + name.slice(1)}
          </button>
        ))}
        <button
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setViewMenu({ x: r.left, y: r.top, above: true });
          }}
          title={`Every view, and Normal to the selected face${keyHint("view.orientation", prefs)}`}
          aria-haspopup="menu"
          data-testid="view-menu-open"
        >
          <Icon name="model" />
          Views
          <Icon name="up" size={10} className="caret" />
        </button>
        <span className="sep" />
        <button onClick={() => api.current?.fit()} title={`Frame the whole part from the current direction${keyHint("view.fit", prefs)}`}>
          <Icon name="fit" />
          Fit
        </button>
        <button onClick={zoomSelection} title={`Frame what is selected${keyHint("view.zoomSelection", prefs)}`} aria-label="Zoom to selection" data-testid="view-zoom-selection">
          <Icon name="zoomSelection" />
        </button>
        <button onClick={previousView} title={`Back to the view before${keyHint("view.previous", prefs)}`} aria-label="Previous view" data-testid="view-previous">
          <Icon name="previousView" />
        </button>
        <span className="sep" />
        <button
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setStyleMenu({ x: r.left, y: r.top });
          }}
          title="Display style: shaded, with edges, hidden lines, wireframe"
          aria-haspopup="menu"
          data-testid="display-style"
        >
          <Icon name={current.icon} />
          <span className="label">{current.label}</span>
          <Icon name="up" size={10} className="caret" />
        </button>
        <button
          aria-pressed={!display.perspective}
          onClick={togglePerspective}
          title={`${display.perspective ? "Perspective: click for orthographic (parallel lines stay parallel)" : "Orthographic: click for perspective"}${keyHint("view.perspective", prefs)}`}
          aria-label={display.perspective ? "Perspective" : "Orthographic"}
          data-testid="view-perspective"
        >
          <Icon name={display.perspective ? "perspective" : "orthographic"} />
        </button>
        <span className="sep" />
        <button aria-pressed={showSketches} onClick={() => setShowSketches((v) => !v)} title="Show or hide sketch geometry and the frame's nodes">
          <Icon name={showSketches ? "eye" : "eyeOff"} />
          Sketches
        </button>
        <button
          aria-pressed={datumView.planes}
          onClick={togglePlanes}
          title={`Show or hide the planes, axes and points (a selected one always shows; each has its own eye in the tree)${keyHint("view.planes", prefs)}`}
          data-testid="view-planes"
        >
          <Icon name={datumView.planes ? "eye" : "eyeOff"} />
          Planes
        </button>
      </div>
      {viewMenu && (
        <Popup x={viewMenu.x} y={viewMenu.y} above={viewMenu.above} onClose={() => setViewMenu(null)} label="View orientation" testId="view-menu">
          {(close) => (
            <>
              {VIEW_ORDER.map((name) => (
                <MenuItem
                  key={name}
                  icon={VIEW_ICON[name]}
                  label={VIEW_LABEL[name]}
                  shortcut={keyHint(`view.${name}`, prefs).slice(2, -1)}
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
      <SelectionChip selection={selection} faces={view?.faces ?? []} edges={view?.edges ?? []} datums={view?.datums ?? {}} />
      {hover && !box && <PickTip hover={hover} info={infoRef.current} />}
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

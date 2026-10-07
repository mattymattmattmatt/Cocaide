import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import type { Vec2, Vec3 } from "../doc/types";
import { formatDirection } from "../geom/vec";
import type { EdgeInfo, FaceInfo } from "../kernel";
import type { RebuildView } from "../worker/protocol";

export type ViewName = "iso" | "top" | "front" | "right";

/** A click on the part: which B-rep face or edge, and where. */
export type PickTarget = { kind: "face" | "edge"; index: number; point: Vec3 };

export interface Selection {
  faces: number[];
  edges: number[];
  /** Where the last face was clicked; a new hole goes here. */
  point?: Vec3;
}

export const EMPTY_SELECTION: Selection = { faces: [], edges: [] };

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

interface Props {
  view: RebuildView | null;
  /** Bump to re-frame the camera on the current model. */
  fitToken: number;
  selection: Selection;
  /** A click on the part (target) or on empty space (null). `additive` when shift is held. */
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
}

export interface FrameNode {
  name: string;
  at: Vec3;
}

const NO_NODES: FrameNode[] = [];

/** Body colours, in the order bodies are made, for a part of more than one. */
export const BODY_COLORS = ["#c4cad3", "#8fb8e3", "#e3b98f", "#a9d39f", "#d3a9d6", "#e09c9c", "#94d1cf", "#d6cf96"];

const SKETCH_OPACITY = 0.55;
const PICK_PIXELS = 6;
const SELECT_COLOR = 0xf28c28;
const HOVER_COLOR = 0x2f7bff;
const SCALE_COLOR = 0xe8590c;
const SCALE_CONFIRMED_COLOR = 0x2b8a3e;

interface Hover {
  x: number;
  y: number;
  target: PickTarget;
}

const VIEW_DIRS: Record<ViewName, Vec3> = {
  iso: [1, -1, 0.8],
  top: [0, -1e-4, 1],
  front: [0, -1, 0],
  right: [1, 0, 0],
};

/** Reads a CSS custom property so the scene follows the page theme. */
function cssColor(el: Element, name: string, fallback: string): THREE.Color {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return new THREE.Color(v || fallback);
}

interface ViewportApi {
  setModel(view: RebuildView | null): void;
  setHiddenBodies(hidden: ReadonlySet<string>): void;
  setSelection(sel: Selection): void;
  setSketchesVisible(visible: boolean): void;
  setNodes(nodes: FrameNode[]): void;
  setUnderlay(u: Underlay | null): void;
  /** See the photo through the part (while picking points on it). */
  setGhost(ghost: boolean): void;
  /** Frame the whole photo from above. */
  fitPhoto(): void;
  fit(dir?: Vec3): void;
  dispose(): void;
}

const NO_BODIES: ReadonlySet<string> = new Set();

export function Viewport({ view, fitToken, selection, onPick, onContext, underlay = null, onPhotoPoint = null, hiddenBodies = NO_BODIES, nodes = NO_NODES }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<ViewportApi | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const contextRef = useRef(onContext);
  contextRef.current = onContext;
  const photoPointRef = useRef(onPhotoPoint);
  photoPointRef.current = onPhotoPoint;
  const [hover, setHover] = useState<Hover | null>(null);
  const [showSketches, setShowSketches] = useState(true);
  const infoRef = useRef<{ faces: FaceInfo[]; edges: EdgeInfo[] }>({ faces: [], edges: [] });
  infoRef.current = { faces: view?.faces ?? [], edges: view?.edges ?? [] };

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.zoomToCursor = true;

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
    scene.add(helpers, photoGroup, model, overlays, marks, nodeGroup);
    let photoMesh: THREE.Mesh | null = null;
    let photo: Underlay | null = null;
    let photoTexture: { url: string; texture: THREE.Texture } | null = null;

    let mesh: THREE.Mesh | null = null;
    let edgeLines: THREE.LineSegments | null = null;
    /** Segment index -> B-rep edge index, for the drawn (non-seam) edges. */
    let segmentEdge: Int32Array = new Int32Array(0);
    let faceRanges: { start: number; count: number }[] = [];
    let edgeRanges: { start: number; count: number }[] = [];
    let edgeSegments: Float32Array = new Float32Array(0);
    let selection: Selection = EMPTY_SELECTION;
    let hovered: PickTarget | null = null;
    let shownView: RebuildView | null = null;
    let hidden: ReadonlySet<string> = NO_BODIES;
    /** Is this face or edge in a hidden body? */
    const isHidden = (body: string | undefined) => body !== undefined && hidden.has(body);

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
        const v = new THREE.Vector3(...n.at).project(camera);
        const shown = overlays.visible && v.z < 1;
        tag.style.display = shown ? "" : "none";
        tag.style.transform = `translate(${((v.x + 1) / 2) * w + 6}px, ${((1 - v.y) / 2) * h - 18}px)`;
      });
    };
    const render = () => {
      renderer.render(scene, camera);
      placeLabels();
    };
    controls.addEventListener("change", render);

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = el;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      for (const m of fatMaterials) m.resolution.set(w, h);
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
      const axes = new THREE.AxesHelper(Math.max(5, radius * 0.25));
      (axes.material as THREE.Material).depthTest = false;
      axes.renderOrder = 2;
      helpers.add(axes);
    };

    const fit = (dir?: Vec3, on = { center, radius }) => {
      const d = new THREE.Vector3(...(dir ?? (camera.position.clone().sub(controls.target).toArray() as Vec3)));
      if (d.lengthSq() === 0) d.set(...VIEW_DIRS.iso);
      d.normalize();
      const dist = (on.radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.15;
      camera.position.copy(on.center).addScaledVector(d, dist);
      camera.near = dist / 100;
      camera.far = dist * 100;
      camera.updateProjectionMatrix();
      controls.target.copy(on.center);
      controls.update();
      render();
    };

    /** Triangles of some faces, sharing the part's vertex buffer. */
    const faceMesh = (indices: number[], color: number, opacity: number) => {
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
      g.setIndex(new THREE.BufferAttribute(merged, 1));
      const m = new THREE.Mesh(
        g,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
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

    const redrawMarks = () => {
      disposeGroup(marks);
      const sel = [faceMesh(selection.faces, SELECT_COLOR, 0.45), edgeMarks(selection.edges, selectEdgeMat)];
      const hov =
        hovered?.kind === "face" && !selection.faces.includes(hovered.index)
          ? faceMesh([hovered.index], HOVER_COLOR, 0.3)
          : hovered?.kind === "edge" && !selection.edges.includes(hovered.index)
            ? edgeMarks([hovered.index], hoverEdgeMat)
            : null;
      for (const o of [...sel, hov]) if (o) marks.add(o);
      render();
    };

    const setModel = (v: RebuildView | null) => {
      shownView = v;
      disposeGroup(model);
      disposeGroup(overlays);
      mesh = null;
      edgeLines = null;
      hovered = null;
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
        const eg = new THREE.BufferGeometry();
        eg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
        edgeLines = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: cssColor(el, "--edge", "#1f2937") }));
        model.add(edgeLines);
        center = g.boundingSphere!.center.clone();
        radius = Math.max(1, g.boundingSphere!.radius);
      }
      for (const sk of v?.sketches ?? []) {
        for (const pl of sk.polylines) {
          const g = new THREE.BufferGeometry().setFromPoints(pl.points.map((p) => new THREE.Vector3(...p)));
          const color = !sk.ok ? 0xe5484d : pl.construction ? 0x8b93a1 : 0xf28c28;
          const mat = pl.construction
            ? new THREE.LineDashedMaterial({ color, dashSize: radius / 40, gapSize: radius / 60, depthTest: false, transparent: true, opacity: SKETCH_OPACITY })
            : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: sk.ok ? SKETCH_OPACITY : 1 });
          const line = new THREE.Line(g, mat);
          if (pl.construction) line.computeLineDistances();
          line.renderOrder = 3;
          overlays.add(line);
        }
      }
      rebuildHelpers();
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
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(photoMesh, false)[0];
      if (!hit?.uv) return null;
      return [hit.uv.x * photo.width, (1 - hit.uv.y) * photo.height];
    };

    // Picking: the nearest edge within a few pixels wins over the face under the cursor.
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const pickAt = (clientX: number, clientY: number): PickTarget | null => {
      if (!mesh) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const faceAt = (h: THREE.Intersection) => {
        if (h.faceIndex === undefined || h.faceIndex === null) return -1;
        const tri = h.faceIndex * 3;
        return faceRanges.findIndex((r) => tri >= r.start && tri < r.start + r.count);
      };
      // Hidden bodies are still in the mesh: look through them.
      const faceHit = raycaster.intersectObject(mesh, false).find((h) => !isHidden(shownView?.faces[faceAt(h)]?.body));
      const worldPerPixel = (2 * camera.position.distanceTo(controls.target) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / rect.height;
      raycaster.params.Line = { threshold: PICK_PIXELS * worldPerPixel };
      const edgeHit = edgeLines ? raycaster.intersectObject(edgeLines, false)[0] : undefined;
      const frontEdge = edgeHit && (!faceHit || edgeHit.distance <= faceHit.distance + 2 * PICK_PIXELS * worldPerPixel);
      if (frontEdge && edgeHit.index !== undefined) {
        return { kind: "edge", index: segmentEdge[Math.floor(edgeHit.index / 2)], point: edgeHit.point.toArray() as Vec3 };
      }
      if (faceHit) {
        const index = faceAt(faceHit);
        if (index >= 0) return { kind: "face", index, point: faceHit.point.toArray() as Vec3 };
      }
      return null;
    };

    const sameTarget = (a: PickTarget | null, b: PickTarget | null) => a?.kind === b?.kind && a?.index === b?.index;
    const onMove = (e: PointerEvent) => {
      if (e.buttons !== 0 || photoPointRef.current) return;
      const target = pickAt(e.clientX, e.clientY);
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
    let down: { x: number; y: number; button: number } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.button === 0 || e.button === 2) down = { x: e.clientX, y: e.clientY, button: e.button };
    };
    const onUp = (e: PointerEvent) => {
      if (!down || e.button !== down.button) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 4) return;
      if (e.button === 0 && photoPointRef.current) {
        const px = photoPixelAt(e.clientX, e.clientY);
        if (px) photoPointRef.current(px);
        return;
      }
      if (e.button === 2) contextRef.current?.(pickAt(e.clientX, e.clientY), e.clientX, e.clientY);
      else pickRef.current(pickAt(e.clientX, e.clientY), e.shiftKey || e.ctrlKey || e.metaKey);
    };
    const canvas = renderer.domElement;
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);

    // Automation hook for end-to-end tests (only with ?e2e in the URL): world point -> client pixels.
    if (new URLSearchParams(location.search).has("e2e")) {
      (window as unknown as { __cocaideViewport?: unknown }).__cocaideViewport = {
        project(p: Vec3): [number, number] {
          const v = new THREE.Vector3(...p).project(camera);
          const rect = canvas.getBoundingClientRect();
          return [rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height];
        },
        /** A pixel of the pinned photo -> client pixels. */
        photoPoint(px: Vec2): [number, number] | null {
          if (!photo) return null;
          const v = photoToWorld(photo, px, -Math.max(0.05, radius * 0.002)).project(camera);
          const rect = canvas.getBoundingClientRect();
          return [rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height];
        },
      };
    }

    api.current = {
      setModel,
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
        if (!photo) return fit(VIEW_DIRS.top);
        // Half the view's height that shows the whole photo across and down.
        const half = (Math.max(photo.height, photo.width / camera.aspect) * photo.mmPerPx) / 2;
        fit(VIEW_DIRS.top, { center: photoToWorld(photo, [photo.width / 2, photo.height / 2]), radius: half });
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
      fit,
      dispose() {
        ro.disconnect();
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerleave", onLeave);
        canvas.removeEventListener("pointerdown", onDown);
        canvas.removeEventListener("pointerup", onUp);
        controls.dispose();
        disposeGroup(model);
        disposeGroup(overlays);
        disposeGroup(helpers);
        disposeGroup(marks);
        disposeGroup(photoGroup);
        disposeGroup(nodeGroup);
        labels.remove();
        photoTexture?.texture.dispose();
        fatMaterials.forEach((m) => m.dispose());
        renderer.dispose();
        renderer.domElement.remove();
      },
    };
    resize();
    rebuildHelpers();
    fit(VIEW_DIRS.iso);
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

  useEffect(() => {
    if (fitToken > 0) api.current?.fit(VIEW_DIRS.iso);
  }, [fitToken]);

  useEffect(() => {
    api.current?.setSketchesVisible(showSketches);
  }, [showSketches]);

  useEffect(() => {
    api.current?.setUnderlay(underlay);
  }, [underlay, view]);

  const picking = !!onPhotoPoint;
  useEffect(() => {
    api.current?.setGhost(picking);
    if (picking) api.current?.fitPhoto(); // points on the photo are placed from straight above
  }, [picking, view]);

  return (
    <div className={`viewport${picking ? " picking-photo" : ""}`}>
      <div ref={host} className="viewport-canvas" data-testid="viewport" />
      <div className="view-buttons" role="toolbar" aria-label="Views">
        {(Object.keys(VIEW_DIRS) as ViewName[]).map((name) => (
          <button key={name} onClick={() => api.current?.fit(VIEW_DIRS[name])}>
            {name[0].toUpperCase() + name.slice(1)}
          </button>
        ))}
        <button onClick={() => api.current?.fit()} title="Frame the part from the current direction">
          Fit
        </button>
        <button aria-pressed={showSketches} onClick={() => setShowSketches((v) => !v)} title="Show or hide sketch geometry and the frame's nodes">
          Sketches
        </button>
      </div>
      <SelectionChip selection={selection} faces={view?.faces ?? []} edges={view?.edges ?? []} />
      {hover && <PickTip hover={hover} faces={infoRef.current.faces} edges={infoRef.current.edges} />}
    </div>
  );
}

function describeFace(f: FaceInfo | undefined): string {
  if (!f) return "face";
  const of = f.body ? ` of ${f.body}` : "";
  if (f.type === "plane" && f.normal) return `planar face${of} · normal ${formatDirection(f.normal)} · offset ${fmt(f.offset ?? 0)}`;
  if (f.type === "cylinder" && f.cylinder) return `cylindrical face${of} · Ø${fmt(2 * f.cylinder.radius)} · ${f.cylinder.concave ? "hole wall" : "boss"}`;
  return (f.type === "cone" ? "conical face" : "freeform face") + of;
}

function describeEdge(e: EdgeInfo | undefined): string {
  if (!e) return "edge";
  const of = e.body ? ` of ${e.body}` : "";
  if (e.kind === "line") return `straight edge${of} · ${formatDirection(e.direction!)} · length ${fmt(e.length)}`;
  if (e.kind === "circle") return `circular edge${of} · Ø${fmt(2 * e.radius!)}`;
  return `curved edge${of} · length ${fmt(e.length)}`;
}

function PickTip({ hover, faces, edges }: { hover: Hover; faces: FaceInfo[]; edges: EdgeInfo[] }) {
  const t = hover.target;
  const face = t.kind === "face" ? faces[t.index] : undefined;
  return (
    <div className="face-tip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
      <div>{t.kind === "face" ? describeFace(face) : describeEdge(edges[t.index])}</div>
      {face && <div className="muted">area {fmt(face.area)} mm²</div>}
    </div>
  );
}

function SelectionChip({ selection, faces, edges }: { selection: Selection; faces: FaceInfo[]; edges: EdgeInfo[] }) {
  const n = selection.faces.length + selection.edges.length;
  if (n === 0) return null;
  const text =
    selection.faces.length === 1 && selection.edges.length === 0
      ? describeFace(faces[selection.faces[0]])
      : selection.edges.length === 1 && selection.faces.length === 0
        ? describeEdge(edges[selection.edges[0]])
        : [
            selection.faces.length ? `${selection.faces.length} face${selection.faces.length === 1 ? "" : "s"}` : "",
            selection.edges.length ? `${selection.edges.length} edge${selection.edges.length === 1 ? "" : "s"}` : "",
          ]
            .filter(Boolean)
            .join(" + ");
  return (
    <div className="selection-chip" data-testid="selection">
      Selected: {text}
    </div>
  );
}

function fmt(x: number): string {
  return String(Math.round(x * 1000) / 1000);
}

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import type { Vec3 } from "../doc/types";
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

interface Props {
  view: RebuildView | null;
  /** Bump to re-frame the camera on the current model. */
  fitToken: number;
  selection: Selection;
  /** A click on the part (target) or on empty space (null). `additive` when shift is held. */
  onPick(target: PickTarget | null, additive: boolean): void;
}

const SKETCH_OPACITY = 0.55;
const PICK_PIXELS = 6;
const SELECT_COLOR = 0xf28c28;
const HOVER_COLOR = 0x2f7bff;

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
  setSelection(sel: Selection): void;
  setSketchesVisible(visible: boolean): void;
  fit(dir?: Vec3): void;
  dispose(): void;
}

export function Viewport({ view, fitToken, selection, onPick }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<ViewportApi | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
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
    scene.add(helpers, model, overlays, marks);

    let mesh: THREE.Mesh | null = null;
    let edgeLines: THREE.LineSegments | null = null;
    /** Segment index -> B-rep edge index, for the drawn (non-seam) edges. */
    let segmentEdge: Int32Array = new Int32Array(0);
    let faceRanges: { start: number; count: number }[] = [];
    let edgeRanges: { start: number; count: number }[] = [];
    let edgeSegments: Float32Array = new Float32Array(0);
    let selection: Selection = EMPTY_SELECTION;
    let hovered: PickTarget | null = null;

    let radius = 50;
    let center = new THREE.Vector3();

    const render = () => renderer.render(scene, camera);
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

    const fatMaterials = [SELECT_COLOR, HOVER_COLOR].map(
      (color) => new LineMaterial({ color, linewidth: 3.5, depthTest: false, transparent: true }),
    );
    const [selectEdgeMat, hoverEdgeMat] = fatMaterials;

    const rebuildHelpers = () => {
      disposeGroup(helpers);
      const size = Math.max(10, 10 ** Math.ceil(Math.log10(radius * 2.5)));
      const grid = new THREE.GridHelper(size, 20, cssColor(el, "--grid-major", "#b7bcc6"), cssColor(el, "--grid-minor", "#d9dce2"));
      grid.rotation.x = Math.PI / 2; // into the XY plane
      (grid.material as THREE.Material).transparent = true;
      (grid.material as THREE.Material).opacity = 0.7;
      helpers.add(grid);
      const axes = new THREE.AxesHelper(Math.max(5, radius * 0.25));
      (axes.material as THREE.Material).depthTest = false;
      axes.renderOrder = 2;
      helpers.add(axes);
    };

    const fit = (dir?: Vec3) => {
      const d = new THREE.Vector3(...(dir ?? (camera.position.clone().sub(controls.target).toArray() as Vec3)));
      if (d.lengthSq() === 0) d.set(...VIEW_DIRS.iso);
      d.normalize();
      const dist = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.15;
      camera.position.copy(center).addScaledVector(d, dist);
      camera.near = dist / 100;
      camera.far = dist * 100;
      camera.updateProjectionMatrix();
      controls.target.copy(center);
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
        mesh = new THREE.Mesh(
          g,
          new THREE.MeshStandardMaterial({
            color: cssColor(el, "--part", "#c4cad3"),
            metalness: 0.15,
            roughness: 0.55,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
          }),
        );
        model.add(mesh);
        // Draw every edge except seams; remember which edge each segment belongs to.
        const pts: number[] = [];
        const owners: number[] = [];
        edgeRanges.forEach((r, i) => {
          if (v.edges[i]?.seam) return;
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

    // Picking: the nearest edge within a few pixels wins over the face under the cursor.
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const pickAt = (clientX: number, clientY: number): PickTarget | null => {
      if (!mesh) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const faceHit = raycaster.intersectObject(mesh, false)[0];
      const worldPerPixel = (2 * camera.position.distanceTo(controls.target) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / rect.height;
      raycaster.params.Line = { threshold: PICK_PIXELS * worldPerPixel };
      const edgeHit = edgeLines ? raycaster.intersectObject(edgeLines, false)[0] : undefined;
      const frontEdge = edgeHit && (!faceHit || edgeHit.distance <= faceHit.distance + 2 * PICK_PIXELS * worldPerPixel);
      if (frontEdge && edgeHit.index !== undefined) {
        return { kind: "edge", index: segmentEdge[Math.floor(edgeHit.index / 2)], point: edgeHit.point.toArray() as Vec3 };
      }
      if (faceHit && faceHit.faceIndex !== undefined && faceHit.faceIndex !== null) {
        const tri = faceHit.faceIndex * 3;
        const index = faceRanges.findIndex((r) => tri >= r.start && tri < r.start + r.count);
        if (index >= 0) return { kind: "face", index, point: faceHit.point.toArray() as Vec3 };
      }
      return null;
    };

    const sameTarget = (a: PickTarget | null, b: PickTarget | null) => a?.kind === b?.kind && a?.index === b?.index;
    const onMove = (e: PointerEvent) => {
      if (e.buttons !== 0) return;
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
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0 || !down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 4) return;
      pickRef.current(pickAt(e.clientX, e.clientY), e.shiftKey || e.ctrlKey || e.metaKey);
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
        render();
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
    api.current?.setSelection(selection);
  }, [selection, view]);

  useEffect(() => {
    if (fitToken > 0) api.current?.fit(VIEW_DIRS.iso);
  }, [fitToken]);

  useEffect(() => {
    api.current?.setSketchesVisible(showSketches);
  }, [showSketches]);

  return (
    <div className="viewport">
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
        <button aria-pressed={showSketches} onClick={() => setShowSketches((v) => !v)} title="Show or hide sketch geometry">
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
  if (f.type === "plane" && f.normal) return `planar face · normal ${formatDirection(f.normal)} · offset ${fmt(f.offset ?? 0)}`;
  if (f.type === "cylinder" && f.cylinder) return `cylindrical face · Ø${fmt(2 * f.cylinder.radius)} · ${f.cylinder.concave ? "hole wall" : "boss"}`;
  return f.type === "cone" ? "conical face" : "freeform face";
}

function describeEdge(e: EdgeInfo | undefined): string {
  if (!e) return "edge";
  if (e.kind === "line") return `straight edge · ${formatDirection(e.direction!)} · length ${fmt(e.length)}`;
  if (e.kind === "circle") return `circular edge · Ø${fmt(2 * e.radius!)}`;
  return `curved edge · length ${fmt(e.length)}`;
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

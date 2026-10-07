import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Vec3 } from "../doc/types";
import { formatDirection } from "../geom/vec";
import type { FaceSummary, RebuildView } from "../worker/protocol";

export type ViewName = "iso" | "top" | "front" | "right";

interface Props {
  view: RebuildView | null;
  /** Bump to re-frame the camera on the current model. */
  fitToken: number;
}

const SKETCH_OPACITY = 0.55;

interface Hover {
  x: number;
  y: number;
  face: FaceSummary;
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

export function Viewport({ view, fitToken }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<{
    setModel(view: RebuildView | null): void;
    setSketchesVisible(visible: boolean): void;
    fit(dir?: Vec3): void;
    dispose(): void;
  } | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [showSketches, setShowSketches] = useState(true);

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
    scene.add(helpers, model, overlays);

    let mesh: THREE.Mesh | null = null;
    let faceRanges: { start: number; count: number }[] = [];
    let faces: FaceSummary[] = [];
    const highlight = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: 0x2f7bff, transparent: true, opacity: 0.35, depthTest: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    highlight.visible = false;
    scene.add(highlight);

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
          else mat?.dispose();
        });
      }
    };

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
      const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.15;
      camera.position.copy(center).addScaledVector(d, dist);
      camera.near = dist / 100;
      camera.far = dist * 100;
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
      render();
    };

    const setModel = (v: RebuildView | null) => {
      disposeGroup(model);
      disposeGroup(overlays);
      highlight.visible = false;
      mesh = null;
      faceRanges = v?.mesh?.faceRanges ?? [];
      faces = v?.faces ?? [];
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
        const eg = new THREE.BufferGeometry();
        eg.setAttribute("position", new THREE.BufferAttribute(v.mesh.edges, 3));
        model.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: cssColor(el, "--edge", "#1f2937") })));
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
      render();
    };

    // Face hover: map the picked triangle back to its B-rep face.
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hoveredFace = -1;
    const onMove = (e: PointerEvent) => {
      if (e.buttons !== 0 || !mesh) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(mesh, false)[0];
      const tri = hit?.faceIndex ?? -1;
      const faceIdx = tri < 0 ? -1 : faceRanges.findIndex((r) => tri * 3 >= r.start && tri * 3 < r.start + r.count);
      if (faceIdx !== hoveredFace) {
        hoveredFace = faceIdx;
        if (faceIdx >= 0) {
          const { start, count } = faceRanges[faceIdx];
          const src = mesh.geometry;
          const g = new THREE.BufferGeometry();
          g.setAttribute("position", src.getAttribute("position"));
          g.setIndex(new THREE.BufferAttribute((src.getIndex()!.array as Uint32Array).slice(start, start + count), 1));
          highlight.geometry.dispose();
          highlight.geometry = g;
          highlight.visible = true;
        } else {
          highlight.visible = false;
        }
        render();
      }
      setHover(faceIdx >= 0 && faces[faceIdx] ? { x: e.clientX - rect.left, y: e.clientY - rect.top, face: faces[faceIdx] } : null);
    };
    const onLeave = () => {
      hoveredFace = -1;
      highlight.visible = false;
      setHover(null);
      render();
    };
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerleave", onLeave);

    api.current = {
      setModel,
      setSketchesVisible(visible: boolean) {
        overlays.visible = visible;
        render();
      },
      fit,
      dispose() {
        ro.disconnect();
        renderer.domElement.removeEventListener("pointermove", onMove);
        renderer.domElement.removeEventListener("pointerleave", onLeave);
        controls.dispose();
        disposeGroup(model);
        disposeGroup(overlays);
        disposeGroup(helpers);
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
      {hover && <FaceTip hover={hover} />}
    </div>
  );
}

function FaceTip({ hover }: { hover: Hover }) {
  const f = hover.face;
  let detail: string;
  if (f.type === "plane" && f.normal) {
    detail = `planar · normal ${formatDirection(f.normal)} · offset ${fmt(f.offset ?? 0)}`;
  } else if (f.type === "cylinder") {
    detail = `cylindrical · Ø${fmt(2 * (f.radius ?? 0))} · ${f.concave ? "hole wall" : "boss"}`;
  } else {
    detail = f.type === "cone" ? "conical" : "freeform";
  }
  return (
    <div className="face-tip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
      <div>{detail}</div>
      <div className="muted">area {fmt(f.area)} mm²</div>
    </div>
  );
}

function fmt(x: number): string {
  return String(Math.round(x * 1000) / 1000);
}

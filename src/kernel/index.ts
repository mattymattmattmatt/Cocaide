export { loadOC, getOC, recycleOC, heapBytes, RECYCLE_HEAP_BYTES, scoped, Scope, type OC } from "./oc";
export { rebuild, type RebuildResult, type FeatureStatus, type SketchOverlay } from "./rebuild";
export { measure, volumeOf, findHoles, DEFAULT_MATERIAL, type Measurements, type HoleMeasurement } from "./measure";
export { tessellate, type MeshData } from "./mesh";
export { exportSTEP, importSTEP } from "./step";
export { describeFaces, type FaceInfo } from "./topology";
export { selectFaces, selectionError } from "./selectors";

export { loadOC, getOC, recycleOC, heapBytes, RECYCLE_HEAP_BYTES, scoped, Scope, type OC } from "./oc";
export { rebuild, type RebuildResult, type FeatureStatus, type SketchOverlay } from "./rebuild";
export { measure, volumeOf, findHoles, DEFAULT_MATERIAL, type Measurements, type HoleMeasurement } from "./measure";
export { tessellate, type MeshData } from "./mesh";
export { exportSTEP, importSTEP } from "./step";
export { describeFaces, describeEdges, type FaceInfo, type EdgeInfo } from "./topology";
export { selectFaces, selectionError, selectEdges, edgeSelectionError } from "./selectors";

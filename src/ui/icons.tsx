// The app's icons: one simple line drawing per action, on a 24-unit grid,
// drawn in the text colour so they follow the theme. Each is a picture of what
// the tool does to the part (an arrow out of a block extrudes it), not a logo.
// Icons sit beside a label or carry an aria-label: never on their own.

import type { ReactNode } from "react";

const dash = { strokeDasharray: "2.2 2.6" };
/** A face shaded on the view cube. */
const face = { fill: "currentColor", fillOpacity: 0.28, stroke: "none" } as const;

const CUBE = "M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12 4 7.5";

const ICONS = {
  // history
  undo: <path d="M9 14 4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />,
  redo: <path d="m15 14 5-5-5-5 M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />,
  // file
  new: <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5 M12 11v6 M9 14h6" />,
  open: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  save: <path d="M12 4v11 M7 10l5 5 5-5 M5 20h14" />,
  export: <path d="M12 15V3 M7 8l5-5 5 5 M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" />,
  examples: <path d="M4 5h6v6H4z M14 5h6v6h-6z M4 15h6v4H4z M14 15h6v4h-6z" />,
  settings: (
    <>
      <path d="M4 7h10 M18 7h2 M4 17h4 M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>
  ),
  ask: <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z M9 11h.01 M12 11h.01 M15 11h.01" />,
  // modes
  model: <path d={CUBE} />,
  drawing: <path d="M3 5h18v14H3z M13 14h8 M13 14v5 M6 8h5v4H6z" />,
  // sketch and features
  sketch: <path d="M15.5 4.5l4 4L9 19H5v-4z M13.5 6.5l4 4" />,
  extrude: <path d="M6 13h12v7H6z M12 10V3 M9 6l3-3 3 3" />,
  cut: <path d="M4 12h5v3h6v-3h5v8H4z M12 3v7 M9 7l3 3 3-3" />,
  hole: (
    <>
      <circle cx="12" cy="12" r="5.5" />
      <path d="M12 2.5v4 M12 17.5v4 M2.5 12h4 M17.5 12h4" />
    </>
  ),
  fillet: <path d="M4 20V4h5a11 11 0 0 1 11 11v5z" fill="currentColor" fillOpacity={0.14} />,
  chamfer: <path d="M4 20V4h6l10 10v6z" fill="currentColor" fillOpacity={0.14} />,
  pattern: <path d="M3 6h5v5H3z M9.5 6h5v5h-5z M16 6h5v5h-5z M3 17h17 M17 14.5l3 2.5-3 2.5" />,
  linearPattern: <path d="M3 6h5v5H3z M9.5 6h5v5h-5z M16 6h5v5h-5z M3 17h17 M17 14.5l3 2.5-3 2.5" />,
  circularPattern: (
    <>
      <circle cx="12" cy="12" r="7" style={dash} />
      <circle cx="12" cy="5" r="2" fill="currentColor" />
      <circle cx="18.1" cy="15.5" r="2" fill="currentColor" />
      <circle cx="5.9" cy="15.5" r="2" fill="currentColor" />
    </>
  ),
  mirror: (
    <>
      <path d="M12 3v18" style={dash} />
      <path d="M9 7 4 17h5z" fill="currentColor" fillOpacity={0.28} />
      <path d="M15 7l5 10h-5z" />
    </>
  ),
  // bodies
  combine: (
    <>
      <circle cx="9" cy="12" r="5.5" />
      <circle cx="15" cy="12" r="5.5" />
    </>
  ),
  split: <path d="M3 7h18v10H3z M13.5 3l-3 18" />,
  move: <path d="M12 3v18 M3 12h18 M9 6l3-3 3 3 M9 18l3 3 3-3 M6 9l-3 3 3 3 M18 9l3 3-3 3" />,
  deleteBody: <path d="M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3" />,
  trash: <path d="M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3" />,
  joint: <path d="M4 20V9l5-5h11 M9 20v-8.5L11.5 9H20 M4 9l5 2.5" />,
  endCap: <path d="M3 8h13v8H3z M19 5v14" />,
  gusset: <path d="M4 4v16h16 M4 9l11 11" />,
  member: <path d="M6 4h12 M6 20h12 M12 4v16 M6 4v2.5 M18 4v2.5 M6 20v-2.5 M18 20v-2.5" />,
  // views
  iso: <path d={CUBE} />,
  top: (
    <>
      <path d="M12 3l8 4.5-8 4.5-8-4.5z" {...face} />
      <path d={CUBE} />
    </>
  ),
  front: (
    <>
      <path d="M4 7.5 12 12v9l-8-4.5z" {...face} />
      <path d={CUBE} />
    </>
  ),
  right: (
    <>
      <path d="M20 7.5 12 12v9l8-4.5z" {...face} />
      <path d={CUBE} />
    </>
  ),
  fit: <path d="M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5" />,
  // sketcher
  select: <path d="M6 3l13 7-5.5 1.8L11.5 18z" />,
  line: (
    <>
      <path d="M6 18 18 6" />
      <circle cx="5" cy="19" r="1.6" />
      <circle cx="19" cy="5" r="1.6" />
    </>
  ),
  rect: <path d="M4 6h16v12H4z" />,
  circle: <circle cx="12" cy="12" r="8" />,
  arc: (
    <>
      <path d="M5 17a8 8 0 0 1 14 0" />
      <circle cx="12" cy="17" r="1" fill="currentColor" />
    </>
  ),
  slot: <rect x="3" y="8" width="18" height="8" rx="4" />,
  construction: <path d="M5 19 19 5" style={dash} />,
  grid: <path d="M4 4h16v16H4z M4 10h16 M4 15h16 M10 4v16 M15 4v16" />,
  // drawing
  dimension: <path d="M4 7v10 M20 7v10 M4 12h16 M7 9.5 4 12l3 2.5 M17 9.5l3 2.5-3 2.5" />,
  balloon: (
    <>
      <circle cx="15" cy="9" r="6" />
      <path d="M10.8 13.2 4 20 M15 6.5v5 M13.6 7.6 15 6.5" />
    </>
  ),
  note: <path d="M5 5h14v10H10l-5 4z" />,
  view: <path d="M3 5h18v14H3z M8 9h8v6H8z" />,
  // small
  plus: <path d="M12 5v14 M5 12h14" />,
  x: <path d="M6 6l12 12 M18 6 6 18" />,
  up: <path d="m6 15 6-6 6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: <path d="M2.5 12S6 5.5 12 5.5c1.8 0 3.4.6 4.7 1.4 M21.5 12s-1.1 2-3.2 3.8 M12 18.5c-6 0-9.5-6.5-9.5-6.5 M9.9 9.9a3 3 0 0 0 4.2 4.2 M4 4l16 16" />,
  suppress: <path d="M2.5 12S6 5.5 12 5.5c1.8 0 3.4.6 4.7 1.4 M21.5 12s-1.1 2-3.2 3.8 M12 18.5c-6 0-9.5-6.5-9.5-6.5 M9.9 9.9a3 3 0 0 0 4.2 4.2 M4 4l16 16" />,
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  alert: <path d="M12 4 2.5 20h19z M12 10v4 M12 17h.01" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5 M12 8h.01" />
    </>
  ),
  ruler: <path d="M3 15 15 3l6 6L9 21z M7 11l2 2 M10 8l2 2 M13 5l2 2" />,
  // sketch relations and dimensions, as SOLIDWORKS draws them
  smartDimension: <path d="M4 7v10 M20 7v10 M4 12h16 M7.5 9 4.5 12l3 3 M16.5 9l3 3-3 3" />,
  horizontal: <path d="M4 12h16 M4 9v6 M20 9v6" />,
  vertical: <path d="M12 4v16 M9 4h6 M9 20h6" />,
  coincident: (
    <>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2.5" fill="currentColor" />
    </>
  ),
  pointOn: (
    <>
      <path d="M3 18 21 6" />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
    </>
  ),
  midpoint: (
    <>
      <path d="M3 12h18 M3 9v6 M21 9v6" />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
    </>
  ),
  parallel: <path d="M4 17 14 5 M10 19 20 7" />,
  perpendicular: <path d="M4 20h16 M9 20V4 M9 15h5v5" />,
  collinear: <path d="M2 18 9.5 13.5 M14.5 10.5 22 6" />,
  tangent: (
    <>
      <circle cx="12" cy="14" r="6" />
      <path d="M3 8h18" />
    </>
  ),
  concentric: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" />
    </>
  ),
  equal: <path d="M5 9h14 M5 15h14" />,
  symmetric: (
    <>
      <path d="M12 3v18" style={dash} />
      <circle cx="6" cy="12" r="2.4" fill="currentColor" />
      <circle cx="18" cy="12" r="2.4" fill="currentColor" />
    </>
  ),
  fix: <path d="M12 3v10 M5 13h14 M7 16.5l2-3.5 M11 16.5l2-3.5 M15 16.5l2-3.5 M7 16.5h10" />,
  angle: <path d="M4 19h16 M4 19 15 6 M10.5 19a6.5 6.5 0 0 0-2.3-5" />,
  diameter: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M6.3 17.7 17.7 6.3" />
    </>
  ),
  radius: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 12l5.7-5.7" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    </>
  ),
  // Phase O model tools: a profile turned about an axis, swept along a path, lofted between two; a part hollowed, tapered, ribbed, scaled
  revolve: (
    <>
      <path d="M10 2.5v19" style={{ strokeDasharray: "5 2.2 1 2.2" }} />
      <path d="M10 11h8v9h-8z" fill="currentColor" fillOpacity={0.28} />
      <path d="M13.5 8.2A7 2.5 0 1 0 6.5 8.2 M4.7 6.3l1.8 1.9-2.4 1" />
    </>
  ),
  sweep: (
    <>
      <path d="M2 19C2 11 8 4 19 4 M7 19c0-5.5 4-10 12-10" />
      <ellipse cx="4.5" cy="19" rx="2.5" ry="1.1" fill="currentColor" fillOpacity={0.28} />
      <ellipse cx="19" cy="6.5" rx="1.1" ry="2.5" />
    </>
  ),
  loft: (
    <>
      <path d="M3 17l9-3 9 3-9 3z" fill="currentColor" fillOpacity={0.14} />
      <ellipse cx="12" cy="6" rx="4" ry="1.6" />
      <path d="M3 17 8 6 M21 17 16 6" />
    </>
  ),
  shell: <path d="M4 5v15h16V5h-3v12H7V5z" fill="currentColor" fillOpacity={0.14} />,
  draft: (
    <>
      <path d="M6 20 8.5 5h7L18 20z" fill="currentColor" fillOpacity={0.14} />
      <path d="M15.5 5v15" style={dash} />
      <path d="M3 20h18" />
    </>
  ),
  rib: (
    <>
      <path d="M3 16h18v4H3z" fill="currentColor" fillOpacity={0.14} />
      <path d="M10.5 16V4h3v12" fill="currentColor" fillOpacity={0.32} />
    </>
  ),
  scaleBody: (
    <>
      <path d="M4 20v-7h7v7z" fill="currentColor" fillOpacity={0.28} />
      <path d="M4 20V4h16v16z" style={dash} />
      <path d="M13 11l6-6 M14.5 5H19v4.5" />
    </>
  ),
  // Phase O reference geometry: a plane, an axis through a cylinder, a point; and the evaluate tools
  plane: <path d="M2.5 17 7 7h14.5L17 17z" fill="currentColor" fillOpacity={0.14} />,
  axis: (
    <>
      <ellipse cx="12" cy="7" rx="5" ry="2" />
      <path d="M7 7v10a5 2 0 0 0 10 0V7" />
      <path d="M12 1.5v21" style={{ strokeDasharray: "5 2.2 1 2.2" }} />
    </>
  ),
  datumPoint: (
    <>
      <path d="M12 4.5v15 M5.5 8.25l13 7.5 M5.5 15.75l13-7.5" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" />
    </>
  ),
  measure: <path d="M4 6h16 M6.5 3.5 4 6l2.5 2.5 M17.5 3.5 20 6l-2.5 2.5 M3 11h18v8H3z M7 11v3 M11 11v4.5 M15 11v3 M19 11v3" />,
  section: (
    <>
      <path d="M8 5.25l8 4.5v9l-8-4.5z" fill="currentColor" fillOpacity={0.28} />
      <path d="M8 5.25 12 3l8 4.5v9l-4 2.25 M16 9.75l4-2.25" />
      <path d="M8 5.25 4 7.5v9l8 4.5 4-2.25 M4 7.5l8 4.5 4-2.25 M12 12v9" style={dash} />
    </>
  ),
  sketchPattern: (
    <>
      <path d="M5 18 11 7l8 9" style={dash} />
      <path d="M3.5 16.5h3v3h-3z M9.5 5.5h3v3h-3z M17.5 14.5h3v3h-3z" fill="currentColor" fillOpacity={0.28} />
    </>
  ),
  // Phase O sketch tools: lines, rectangles, polygons, arcs, circles, slots and curves
  centerline: <path d="M4 20 20 4" style={{ strokeDasharray: "6 2.6 1.2 2.6" }} />,
  point: (
    <>
      <path d="M12 3v5 M12 16v5 M3 12h5 M16 12h5" />
      <circle cx="12" cy="12" r="2.2" fill="currentColor" />
    </>
  ),
  rectCenter: (
    <>
      <path d="M4 6h16v12H4z" />
      <path d="M4 6l16 12 M20 6 4 18" style={dash} />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </>
  ),
  rect3: (
    <>
      <path d="M3.5 13.5 13.5 3.5l7 7-10 10z" />
      <circle cx="3.5" cy="13.5" r="1.5" fill="currentColor" />
      <circle cx="13.5" cy="3.5" r="1.5" fill="currentColor" />
      <circle cx="20.5" cy="10.5" r="1.5" fill="currentColor" />
    </>
  ),
  parallelogram: <path d="M8 6h13l-5 12H3z" />,
  polygon: (
    <>
      <path d="M7.5 4.2h9l4.5 7.8-4.5 7.8h-9L3 12z" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </>
  ),
  arc3: (
    <>
      <path d="M4 16a8 8 0 0 1 16 0" />
      <circle cx="4" cy="16" r="1.5" fill="currentColor" />
      <circle cx="12" cy="8" r="1.5" fill="currentColor" />
      <circle cx="20" cy="16" r="1.5" fill="currentColor" />
    </>
  ),
  tangentArc: (
    <>
      <path d="M3 19h7a8 8 0 0 0 8-8" />
      <circle cx="10" cy="19" r="1.5" fill="currentColor" />
      <circle cx="18" cy="11" r="1.5" fill="currentColor" />
    </>
  ),
  circle3: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="4" r="1.5" fill="currentColor" />
      <circle cx="5.07" cy="16" r="1.5" fill="currentColor" />
      <circle cx="18.93" cy="16" r="1.5" fill="currentColor" />
    </>
  ),
  slotCenter: (
    <>
      <rect x="3" y="7.5" width="18" height="9" rx="4.5" />
      <path d="M7.5 12h9" style={dash} />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </>
  ),
  ellipse: (
    <>
      <ellipse cx="12" cy="12" rx="9" ry="5.5" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" />
    </>
  ),
  spline: (
    <>
      <path d="M3 18c3-9 6-12 9-6s6 3 9-6" />
      <circle cx="3" cy="18" r="1.5" fill="currentColor" />
      <circle cx="21" cy="6" r="1.5" fill="currentColor" />
    </>
  ),
  // Phase O sketch edit tools: trim, extend, split, fillet, chamfer, offset, mirror, patterns, move, rotate, scale, copy, convert
  trim: (
    <>
      <path d="M15 3v18 M3 12h12" />
      <path d="M15 12h6" style={dash} />
      <path d="M17 6.5l3 3 M20 6.5l-3 3" />
    </>
  ),
  extend: (
    <>
      <path d="M20 4v16 M3 12h8" />
      <path d="M11 12h6" style={dash} />
      <path d="M15 9.5l2.5 2.5-2.5 2.5" />
    </>
  ),
  splitEntity: (
    <>
      <path d="M3 12h6.4 M14.6 12H21" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  sketchFillet: (
    <>
      <path d="M4 20v-9a7 7 0 0 1 7-7h9" />
      <path d="M4 11V4h7" style={dash} />
    </>
  ),
  sketchChamfer: (
    <>
      <path d="M4 20v-9l7-7h9" />
      <path d="M4 11V4h7" style={dash} />
    </>
  ),
  offset: <path d="M3 21V10a7 7 0 0 1 7-7h11 M8 21v-9.5A3.5 3.5 0 0 1 11.5 8H21" />,
  mirrorEntities: (
    <>
      <path d="M12 3v18" style={{ strokeDasharray: "5 2.2 1 2.2" }} />
      <path d="M9 5 4 12l5 7 M15 5l5 7-5 7" />
    </>
  ),
  linearSketchPattern: (
    <>
      <circle cx="5" cy="9" r="2.5" />
      <circle cx="12" cy="9" r="2.5" />
      <circle cx="19" cy="9" r="2.5" />
      <path d="M3 17h17 M17 14.5l3 2.5-3 2.5" />
    </>
  ),
  circularSketchPattern: (
    <>
      <circle cx="12" cy="12" r="7" style={dash} />
      <circle cx="12" cy="5" r="2.2" />
      <circle cx="18.1" cy="15.5" r="2.2" />
      <circle cx="5.9" cy="15.5" r="2.2" />
    </>
  ),
  moveEntities: (
    <>
      <path d="M3 14h7v7H3z" style={dash} />
      <path d="M14 3h7v7h-7z" />
      <path d="M8 16l5.5-5.5 M9.5 10.5h4v4" />
    </>
  ),
  rotateEntities: (
    <>
      <path d="M4 19h16" style={dash} />
      <path d="M4 19l7.1-7.1 M17 19a13 13 0 0 0-3.8-9.2 M16.1 10.3l-2.9-.5.5 2.9" />
      <circle cx="4" cy="19" r="1.5" fill="currentColor" />
    </>
  ),
  scaleEntities: (
    <>
      <path d="M3 21l4-7 4 7z" fill="currentColor" fillOpacity={0.28} />
      <path d="M3 21l8.5-15L20 21z" style={dash} />
      <path d="M13 13l7-7 M15.5 6H20v4.5" />
    </>
  ),
  copyEntities: <path d="M8 8h12v12H8z M4 16V5a1 1 0 0 1 1-1h11" />,
  convertEntities: (
    <>
      <path d="M4 3v6c3-4 13-4 16 0V3z" fill="currentColor" fillOpacity={0.14} />
      <path d="M12 9.5v4 M10 11.5l2 2 2-2" />
      <path d="M4 19c3-4 13-4 16 0" />
      <circle cx="4" cy="19" r="1.5" fill="currentColor" />
      <circle cx="20" cy="19" r="1.5" fill="currentColor" />
    </>
  ),
  fullyDefine: (
    <>
      <path d="M3 9h11v11H3z M3 5h11 M3 3.5v3 M14 3.5v3" />
      <path d="M15.5 15l2.5 2.5 4.5-5" />
    </>
  ),
  // Phase O view: display styles and zoom to the selection
  displayStyle: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17a5 8.5 0 0 0 0-17z" fill="currentColor" fillOpacity={0.28} />
    </>
  ),
  wireframe: <path d="M4 8h12v12H4z M8 4h12v12H8z M4 8l4-4 M16 8l4-4 M4 20l4-4 M16 20l4-4" />,
  hiddenLines: (
    <>
      <path d="M4 8h12v12H4z M4 8l4-4h12v12l-4 4 M16 8l4-4" />
      <path d="M8 4v12h12 M4 20l4-4" style={dash} />
    </>
  ),
  shadedEdges: (
    <>
      <path d="M12 3l8 4.5-8 4.5-8-4.5z" {...face} fillOpacity={0.14} />
      <path d="M4 7.5 12 12v9l-8-4.5z" {...face} fillOpacity={0.34} />
      <path d="M20 7.5 12 12v9l8-4.5z" {...face} fillOpacity={0.22} />
      <path d={CUBE} />
    </>
  ),
  zoomSelection: (
    <>
      <path d="M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5" />
      <path d="M9 9h6v6H9z" fill="currentColor" fillOpacity={0.28} />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

/** An icon in the text colour. Decorative: the button or row it sits in says what it is. Inside an SVG, x and y place it. */
export function Icon({ name, size = 16, className, x, y }: { name: IconName; size?: number; className?: string; x?: number; y?: number }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ""}`}
      x={x}
      y={y}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}

/** Every icon's name, for checks that a tool's icon exists. */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

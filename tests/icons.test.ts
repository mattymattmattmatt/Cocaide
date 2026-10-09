// The icons for the tools still to come (Phase O) are there ahead of them,
// one line drawing each on the 24-unit grid, so the engineers adding the
// tools never touch the same lines of icons.tsx.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Icon, ICON_NAMES, type IconName } from "../src/ui/icons";

const PLANNED = [
  // model tools, reference geometry, evaluate
  "revolve", "sweep", "loft", "shell", "draft", "rib", "scaleBody", "plane", "axis", "datumPoint", "measure", "section", "sketchPattern",
  // sketch draw tools
  "centerline", "point", "rectCenter", "rect3", "parallelogram", "polygon", "arc3", "tangentArc", "circle3", "slotCenter", "ellipse", "spline",
  // sketch edit tools
  "trim", "extend", "splitEntity", "sketchFillet", "sketchChamfer", "offset", "mirrorEntities", "linearSketchPattern", "circularSketchPattern",
  "moveEntities", "rotateEntities", "scaleEntities", "copyEntities", "convertEntities", "fullyDefine",
  // view
  "displayStyle", "wireframe", "hiddenLines", "shadedEdges", "zoomSelection",
];

describe("icons", () => {
  it("has every icon the planned tools name, each drawing something in the text colour", () => {
    for (const name of PLANNED) {
      expect(ICON_NAMES, name).toContain(name);
      const svg = renderToStaticMarkup(createElement(Icon, { name: name as IconName }));
      expect(svg, name).toMatch(/^<svg[^>]*viewBox="0 0 24 24"[^>]*stroke="currentColor"/);
      expect(svg, name).toMatch(/<(path|circle|ellipse|rect) /);
      expect(svg, name).not.toMatch(/(fill|stroke)="#/);
    }
  });

  it("keeps every coordinate on the 24-unit grid", () => {
    for (const name of ICON_NAMES) {
      const svg = renderToStaticMarkup(createElement(Icon, { name }));
      for (const attr of svg.matchAll(/\s(cx|cy|x|y)="(-?[\d.]+)"/g)) {
        expect(Number(attr[2]), `${name} ${attr[1]}`).toBeGreaterThanOrEqual(0);
        expect(Number(attr[2]), `${name} ${attr[1]}`).toBeLessThanOrEqual(24);
      }
    }
  });
});

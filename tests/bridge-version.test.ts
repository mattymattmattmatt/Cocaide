// The bridge on the user's computer runs Cocaide's tools from their own copy
// of the folder, which can be older than the app on the website. The bridge's
// version is how the app notices: whenever the tool set changes, the version
// must change too, so this test pins the tool names to the version.

import { describe, expect, it } from "vitest";
import { BRIDGE_VERSION, bridgeOutdated, bridgeOutdatedNote } from "../src/bridge/protocol";
import { TOOLS } from "../src/mcp/server";

const TOOLSET: Record<string, string[]> = {
  "1.1.0": ["addConstraint","addEntity","addFeature","addLibraryProfile","addSheet","applyDetailPlan","batch","checkDrawing","cutList","deleteAnnotations","deleteConstraint","deleteEntity","deleteFeature","deleteParameter","deleteSheet","detailPlan","drawing","editAnnotation","exportCutList","exportDrawing","exportDxf","exportSTEP","exportSTL","facePlane","fitViews","fullyDefine","geoRefs","getFeature","getSketch","holes","importStep","listDatums","listEdges","listFaces","listFeatures","measure","measureBetween","moveSheet","moveView","newDrawing","partSummary","plan","rebuild","redo","reference","renameBody","renameDimension","renameNode","renameParameter","renameSheet","renderSheet","reorderFeature","saveBody","screenshot","setAnnotation","setBodyMaterial","setCutList","setDimension","setDrawingOptions","setDriven","setFolder","setNode","setParameter","setProperties","setSheet","setTable","setView","setWeld","sketchProfile","suppressFeature","suppressFolder","undo","updateEntity","updateFeature","validate"],
  "1.2.0": ["addConstraint","addEntity","addFeature","addLibraryProfile","addSheet","applyDetailPlan","batch","checkDrawing","cutList","deleteAnnotations","deleteConstraint","deleteEntity","deleteFeature","deleteParameter","deleteSheet","detailPlan","drawing","editAnnotation","exportCutList","exportDrawing","exportDxf","exportSTEP","exportSTL","facePlane","fitViews","fullyDefine","geoRefs","getFeature","getSketch","holes","importStep","listDatums","listEdges","listFaces","listFeatures","measure","measureBetween","moveSheet","moveView","newDrawing","partSummary","plan","rebuild","redo","reference","renameBody","renameDimension","renameNode","renameParameter","renameSheet","renderSheet","reorderFeature","saveBody","screenshot","setAnnotation","setBodyMaterial","setCutList","setDimension","setDrawingOptions","setDriven","setFolder","setNode","setParameter","setProperties","setSheet","setTable","setView","setWeld","sketchProfile","suppressFeature","suppressFolder","undo","updateEntity","updateFeature","validate"],
  "1.3.0": ["addConstraint","addEntity","addFeature","addLibraryProfile","addSheet","applyDetailPlan","batch","checkDrawing","cutList","deleteAnnotations","deleteConstraint","deleteEntity","deleteFeature","deleteParameter","deleteSheet","detailPlan","drawing","editAnnotation","exportCutList","exportDrawing","exportDxf","exportSTEP","exportSTL","facePlane","fitViews","fullyDefine","geoRefs","getFeature","getSketch","holes","importStep","listDatums","listEdges","listFaces","listFeatures","measure","measureBetween","moveSheet","moveView","newDrawing","partSummary","plan","rebuild","redo","reference","renameBody","renameDimension","renameNode","renameParameter","renameSheet","renderSheet","reorderFeature","reportToolIssue","saveBody","screenshot","setAnnotation","setBodyMaterial","setCutList","setDimension","setDrawingOptions","setDriven","setFolder","setNode","setParameter","setProperties","setSheet","setTable","setView","setWeld","sketchProfile","suppressFeature","suppressFolder","undo","updateEntity","updateFeature","validate"],
};

describe("bridge version", () => {
  it("changes whenever Cocaide's tools change", () => {
    const names = Object.keys(TOOLS).sort();
    expect(
      TOOLSET[BRIDGE_VERSION],
      `The MCP tools changed: bump BRIDGE_VERSION's minor number in src/bridge/protocol.ts and add its tool list here, so older bridges are told to update.`,
    ).toEqual(names);
  });

  it("calls an older bridge out of date, and says how to update", () => {
    expect(bridgeOutdated("1.0.0", "1.1.0")).toBe(true);
    expect(bridgeOutdated("1.1.0", "1.1.0")).toBe(false);
    expect(bridgeOutdated("1.1.0", "1.2.0")).toBe(true);
    expect(bridgeOutdated("1.2.0", "1.1.0")).toBe(false);
    expect(bridgeOutdated("2.0.0", "1.1.0")).toBe(true);
    expect(bridgeOutdatedNote("1.0.0")).toMatch(/start-cocaide\.bat/);
  });
});

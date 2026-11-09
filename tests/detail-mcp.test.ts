// Phase Q wave Q3B: the detailing tools over MCP (what Claude Code drives
// through the bridge, and any MCP client): detailPlan, applyDetailPlan as one
// revision, checkDrawing, renderSheet as a picture, deleteAnnotations; each
// one is in the server's tool list and the reference.

import { describe, expect, it } from "vitest";
import { AgentSession, EDIT_TOOLS, READ_TOOLS } from "../src/agent/session";
import { referenceSection } from "../src/mcp/sections";
import { TOOLS } from "../src/mcp/server";
import { decodePNG } from "../src/render/pngDecode";
import { example } from "./detail-fixtures";

describe("detailing over MCP", () => {
  it("lists the tools and documents them", () => {
    for (const t of ["detailPlan", "applyDetailPlan", "checkDrawing", "renderSheet", "deleteAnnotations"]) {
      expect(TOOLS[t], t).toBeDefined();
      expect([...EDIT_TOOLS, ...READ_TOOLS] as string[]).toContain(t);
    }
    expect(TOOLS.detailPlan.readOnly).toBe(true);
    expect(TOOLS.applyDetailPlan.readOnly).toBeFalsy();
    const ref = referenceSection("detailing")!;
    expect(ref).toContain("applyDetailPlan");
    expect(ref).toContain("H7/m6");
  });

  it("plans, applies as one revision, checks and renders the flange", async () => {
    const s = await AgentSession.open({ doc: example("flange") });
    expect((await s.call("newDrawing", { date: "2026-11-05" })).result).toMatchObject({ ok: true, revision: 1 });
    const plan = (await s.call("detailPlan", {})).result as { ok: boolean; design: string; items: string[] };
    expect(plan.ok).toBe(true);
    expect(plan.design).toContain("bore Ø24 (bearing)");
    expect(plan.items.some((i) => i.startsWith("[x] fit_") && i.includes("H7"))).toBe(true);
    const applied = (await s.call("applyDetailPlan", { skip: ["revision"] })).result as { ok: boolean; revision: number; items: string[]; findings: string[] };
    expect(applied.ok).toBe(true);
    expect(applied.revision).toBe(2);
    expect(applied.items.every((i) => i.startsWith("✓"))).toBe(true);
    const check = (await s.call("checkDrawing", {})).result as unknown as { passes: boolean; findings: string[] };
    expect(check.passes, check.findings.join("\n")).toBe(true);
    const shot = await s.call("renderSheet", {});
    expect(shot.result).toMatchObject({ ok: true, sheet: "sheet1" });
    const img = await decodePNG(shot.image!);
    expect(img.width).toBe(1800);
    const d = JSON.parse(s.text).drawing;
    expect(d.revisions).toBeUndefined();
    expect(d.generalTolerance).toBe("ISO 2768-mK");
    const del = (await s.call("deleteAnnotations", { ids: ["general_notes"] })).result;
    expect(del).toMatchObject({ ok: true, revision: 3 });
    s.close();
  });
});

// The general notes a detailed drawing carries (Phase Q wave Q3B): what the
// shop needs that no symbol on the views says. Numbered in the notes block.

import type { RawDocument } from "../../doc/commands";
import { partProperties } from "../../doc/properties";
import { validateDocument } from "../../doc/validate";
import type { Measurements } from "../../kernel/measure";
import type { DetailPlan } from "./plan";

const r2 = (x: number) => Math.round(x * 100) / 100;

/** The notes, in order: material, tolerances, surface, edges, finish, the weld rules for a weldment, units. */
export function notesFor(plan: DetailPlan, doc: RawDocument, m: Measurements | null): string[] {
  const v = validateDocument(doc);
  const props = partProperties(doc) as Record<string, unknown>;
  void m;
  // The part's own material (the measurements' "steel (default)" is no material).
  const material = plan.intent.material ?? v.material?.name;
  const finish = typeof props.finish === "string" && props.finish.trim() ? props.finish.trim() : null;
  const tol = plan.options.generalTolerance;
  const tolText = /^(ISO|EN|DIN)\b/.test(tol) ? tol : `AS TABULATED: ${tol}`;
  const out: string[] = [];
  if (material) out.push(`MATERIAL: ${material.toUpperCase()}.`);
  out.push(`GENERAL TOLERANCES ${tolText}.`);
  if (plan.intent.kind === "weldment") {
    out.push("WELDS TO ISO 2553, QUALITY LEVEL C TO ISO 5817, PROCESS 135 (MAG).");
    out.push("FILLET WELDS a3 ALL ROUND UNLESS OTHERWISE SHOWN.");
    out.push("REMOVE SPATTER AND SLAG; DEBURR ALL CUT ENDS.");
    out.push(finish ? `FINISH: ${finish.toUpperCase()}.` : "DEGREASE AND PAINT AFTER WELDING: PRIMER AND TOP COAT, COLOUR AS ORDERED.");
    out.push("SURFACES AS FABRICATED UNLESS OTHERWISE SHOWN.");
  } else {
    if (plan.options.roughness) out.push(`SURFACE ROUGHNESS ${plan.options.roughness} UNLESS OTHERWISE SHOWN (ISO 21920-1).`);
    out.push("REMOVE ALL BURRS; BREAK SHARP EDGES 0.2–0.5 × 45°.");
    if (plan.intent.holes.some((h) => h.purpose === "tapped")) out.push("THREADS ISO 965-1, 6H.");
    for (const f of v.features) {
      const x = f.feature as unknown as { op?: string; radius?: unknown; distance?: unknown } | undefined;
      if (x?.op === "fillet" && typeof x.radius === "number" && !out.some((l) => l.startsWith("FILLETS"))) out.push(`FILLETS R${r2(x.radius)} UNLESS OTHERWISE SHOWN.`);
      if (x?.op === "chamfer" && typeof x.distance === "number" && !out.some((l) => l.startsWith("CHAMFERS"))) out.push(`CHAMFERS ${r2(x.distance)} × 45° UNLESS OTHERWISE SHOWN.`);
    }
    out.push(finish ? `FINISH: ${finish.toUpperCase()}.` : /alumin/i.test(material ?? "") ? "FINISH: CLEAR ANODISE." : /stainless/i.test(material ?? "") ? "FINISH: PASSIVATE." : "FINISH: ZINC PLATE (ISO 2081), OR AS ORDERED.");
  }
  out.push("DIMENSIONS IN MILLIMETRES. DO NOT SCALE.");
  return out;
}

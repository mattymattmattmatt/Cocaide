// The assembly's bill of materials, in the cut list's shape so the drawing's
// BOM table and its balloons read it as they read a weldment's cut list: one
// item per part, numbered in the order the parts first come in, its quantity
// the components made from it, its bodies their ids (a balloon on a
// component's edge finds its item by them). Pure.

import { cutListSettings } from "../doc/cutListSettings";
import type { Assembly } from "../doc/types";
import type { CutItem, CutListResult } from "../weldment/items";
import { partDocument, partName } from "./model";

export interface BomPartInfo {
  massKg: number;
  material: string;
}

export function assemblyBom(doc: Record<string, unknown>, parts: Record<string, BomPartInfo> = {}): CutListResult | null {
  const asm = doc.assembly as Assembly | undefined;
  if (!asm?.components?.length) return null;
  const order: string[] = [];
  const byPart = new Map<string, string[]>();
  for (const k of asm.components) {
    if (!byPart.has(k.part)) {
      order.push(k.part);
      byPart.set(k.part, []);
    }
    byPart.get(k.part)!.push(k.id);
  }
  const items: CutItem[] = order.map((key, n) => {
    const d = (partDocument(doc, key) ?? {}) as Record<string, unknown>;
    const props = (typeof d.properties === "object" && d.properties ? d.properties : {}) as Record<string, unknown>;
    const name = partName(doc, key);
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const ids = byPart.get(key)!;
    const info = parts[key];
    const material = info?.material || str((d.material as Record<string, unknown> | undefined)?.name);
    const each = info?.massKg ?? 0;
    const custom: Record<string, string> = {};
    for (const [k, v] of Object.entries(props)) if (typeof v === "string" || typeof v === "number") custom[k] = String(v);
    return {
      item: n + 1,
      kind: "body",
      quantity: ids.length,
      members: ids,
      bodies: ids,
      description: str(props.description) || name,
      autoDescription: name,
      profile: name,
      standard: "",
      designation: str(props.partNumber) || str(props.number) || name,
      partName: str(props.partNumber) || str(props.number) || name,
      material,
      grade: "",
      length: 0,
      endsText: "",
      faces: ["", ""],
      massEach: each,
      massTotal: each * ids.length,
      areaEach: 0,
      areaTotal: 0,
      finish: str(props.finish),
      weldPrep: "",
      group: "",
      notes: str(props.notes),
      properties: custom,
    };
  });
  const quantity = items.reduce((s, i) => s + i.quantity, 0);
  const massKg = items.reduce((s, i) => s + i.massTotal, 0);
  return {
    items,
    totals: { quantity, massKg, paintArea: 0, byProfile: [], plates: [] },
    propertyNames: [...new Set(items.flatMap((i) => Object.keys(i.properties)))],
    settings: cutListSettings(doc),
  };
}

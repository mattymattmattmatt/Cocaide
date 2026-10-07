// Exports each example to STEP and opens it in FreeCAD, comparing what
// FreeCAD measures with what Cocaide measured. A .step argument is opened
// as it is (for a file the browser exported) and must be one valid solid.
//
//   FREECAD_CMD=/path/to/freecadcmd npm run verify:freecad [-- doc.cocaide.json | part.step ...]
//
// FreeCAD is not a project dependency; point FREECAD_CMD at any install.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { exportSTEP, loadOC, rebuild } from "../src/kernel";

const freecad = process.env.FREECAD_CMD ?? "freecadcmd";
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync("examples").filter((f) => f.endsWith(".cocaide.json")).map((f) => join("examples", f));

function openInFreeCAD(step: string): Record<string, unknown> & { importedObjects: string[]; valid: boolean; solids: number; faces: number; volume: number; area: number; bbox: number[]; freecad: string } {
  const output = execFileSync(freecad, [resolve("scripts/freecad_check.py")], {
    env: { ...process.env, COCAIDE_STEP: step },
    encoding: "utf8",
  });
  const line = output.split("\n").find((l) => l.startsWith("COCAIDE_FREECAD "));
  if (!line) throw new Error(`FreeCAD printed no report:\n${output}`);
  return JSON.parse(line.slice("COCAIDE_FREECAD ".length));
}

async function main() {
  const oc = await loadOC();
  mkdirSync("out", { recursive: true });
  let failed = 0;
  for (const file of files.filter((f) => f.toLowerCase().endsWith(".step"))) {
    const fc = openInFreeCAD(resolve(file));
    const ok = fc.importedObjects.length === 1 && fc.valid && fc.solids === 1;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"} ${file}`);
    console.log(`  FreeCAD ${fc.freecad}: object "${fc.importedObjects.join(", ")}", valid ${fc.valid}, ${fc.solids} solid, ${fc.faces} faces`);
    console.log(`  volume ${fc.volume.toFixed(6)} mm³, area ${fc.area.toFixed(6)} mm², bbox [${fc.bbox.map((v) => Math.round(v * 1e6) / 1e6).join(", ")}]`);
  }
  for (const file of files.filter((f) => !f.toLowerCase().endsWith(".step"))) {
    const result = rebuild(JSON.parse(readFileSync(file, "utf8")), oc);
    try {
      if (!result.ok || !result.solid) {
        console.log(`FAIL ${file}: rebuild errors\n  ${result.errors.join("\n  ")}`);
        failed++;
        continue;
      }
      const step = resolve("out", `${basename(file, ".cocaide.json")}.step`);
      writeFileSync(step, exportSTEP(oc, result.solid, result.name));
      const fc = openInFreeCAD(step);
      const m = result.measurements!;
      const bb = m.boundingBox!;
      const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1, Math.abs(b));
      const checks: [string, boolean][] = [
        ["FreeCAD imported one object", fc.importedObjects.length === 1],
        ["shape is valid", fc.valid === true],
        ["one solid", fc.solids === m.solids],
        ["same face count", fc.faces === m.faces],
        ["same volume (1e-6)", rel(fc.volume, m.volume) < 1e-6],
        ["same area (1e-6)", rel(fc.area, m.surfaceArea) < 1e-6],
        ["same bounding box", [...bb.min, ...bb.max].every((v, i) => Math.abs(v - fc.bbox[i]) < 1e-6)],
      ];
      const ok = checks.every(([, pass]) => pass);
      if (!ok) failed++;
      console.log(`${ok ? "PASS" : "FAIL"} ${file} -> ${step}`);
      console.log(`  FreeCAD ${fc.freecad}: object "${fc.importedObjects.join(", ")}", ${fc.solids} solid, ${fc.faces} faces`);
      console.log(`  volume  cocaide ${m.volume.toFixed(6)}  freecad ${fc.volume.toFixed(6)} mm³`);
      console.log(`  area    cocaide ${m.surfaceArea.toFixed(6)}  freecad ${fc.area.toFixed(6)} mm²`);
      for (const [name, pass] of checks) console.log(`  ${pass ? "ok  " : "FAIL"} ${name}`);
    } finally {
      result.dispose();
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

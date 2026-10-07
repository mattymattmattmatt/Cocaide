// Headless Cocaide: the same document and kernel the browser uses.
//
//   npm run cocaide -- rebuild <doc.cocaide.json>
//   npm run cocaide -- export-step <doc.cocaide.json> [out.step]
//
// Prints JSON. Exits 1 when the rebuild reports errors.

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseDocumentText } from "../src/doc/format";
import { exportRefusal, photoNote } from "../src/doc/photo";
import { exportSTEP, loadOC, rebuild } from "../src/kernel";

async function main() {
  const [command, file, out] = process.argv.slice(2);
  if (!command || !file || !["rebuild", "export-step"].includes(command)) {
    console.error("usage: cocaide rebuild <doc.cocaide.json>\n       cocaide export-step <doc.cocaide.json> [out.step]");
    process.exit(2);
  }
  const parsed = parseDocumentText(readFileSync(file, "utf8"));
  if (!parsed.ok) {
    console.log(JSON.stringify({ ok: false, errors: [`document: ${parsed.error}`] }, null, 2));
    process.exit(1);
  }
  const oc = await loadOC();
  const result = rebuild(parsed.value, oc);
  try {
    const summary = { ok: result.ok, errors: result.errors, features: result.features, measurements: result.measurements };
    if (command === "rebuild") {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      if (!result.ok || !result.solid) {
        console.log(JSON.stringify({ ...summary, exported: null }, null, 2));
        console.error("not exported: fix the rebuild errors first");
        process.exit(1);
      }
      const refused = exportRefusal(parsed.value);
      if (refused) {
        console.log(JSON.stringify({ ...summary, exported: null }, null, 2));
        console.error(refused);
        process.exit(1);
      }
      const target = out ?? `${basename(file).replace(/\.cocaide\.json$|\.json$/, "")}.step`;
      writeFileSync(target, exportSTEP(oc, result.solid, result.name, photoNote(parsed.value)));
      console.log(JSON.stringify({ ...summary, exported: target }, null, 2));
    }
    if (!result.ok) process.exit(1);
  } finally {
    result.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Replays an agent session log and checks every revision against it.
//
//   npm run replay -- run.log.jsonl                    replay the last session
//   npm run replay -- run.log.jsonl --session 1        the first session in the file
//   npm run replay -- run.log.jsonl --revision 3 --out r3.cocaide.json
//                                                      stop at revision 3 and save the document

import { readFileSync, writeFileSync } from "node:fs";
import { parseLog, replay } from "../src/agent/replay";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!file) {
  console.error("usage: replay <log.jsonl> [--session N] [--revision R] [--seq S] [--out file]");
  process.exit(2);
}
const sessions = parseLog(readFileSync(file, "utf8"));
if (!sessions.length) {
  console.error(`${file}: no session in the log`);
  process.exit(1);
}
const n = flag("--session") ? Number(flag("--session")) : sessions.length;
const run = sessions[n - 1];
if (!run) {
  console.error(`${file}: there are ${sessions.length} sessions; --session ${n} is out of range`);
  process.exit(2);
}
const result = await replay(run, {
  untilRevision: flag("--revision") ? Number(flag("--revision")) : undefined,
  untilSeq: flag("--seq") ? Number(flag("--seq")) : undefined,
});
console.log(`session ${n} of ${sessions.length}, started ${run.session.at}, scope ${JSON.stringify(run.session.writeScope ?? ["*"])}`);
for (const s of result.steps) {
  const mark = s.matches ? "  " : "!!";
  console.log(`${mark} #${s.seq} ${s.tool} -> ${s.ok ? `r${s.revision}` : `rejected: ${s.error}`}`);
}
const out = flag("--out");
if (out) {
  writeFileSync(out, result.document);
  console.log(`wrote revision ${result.revision} to ${out}`);
}
if (result.divergedAt !== undefined) {
  console.log(`diverged from the log at call #${result.divergedAt}`);
  process.exit(1);
}
console.log(`replayed ${result.steps.length} edits; every revision matches the log (now at r${result.revision})`);

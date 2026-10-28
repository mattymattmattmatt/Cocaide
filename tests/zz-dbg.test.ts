import { it } from "vitest";
import { buildProfile } from "../src/geom/profile";
it("dbg", () => {
  const p = buildProfile([{ id: "t1", type: "text", at: [0, 0], text: "O", height: 10 }]);
  throw new Error(JSON.stringify(p.ok ? p.regions.length : p.error));
});

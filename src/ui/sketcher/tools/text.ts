// Text: a click places it, its anchor on the baseline (left end by default),
// and the text box opens to type what it says (Enter takes it). Its height
// (capital letters, mm) is the strip's option; the box changes it, the font
// style, the alignment and the angle afterwards, and a distance dimension on
// it holds the height. Extrude it to emboss, cut it to engrave.

import type { SketchToolDef } from "./types";

/** What new text says until it is typed. */
export const NEW_TEXT = "Text";

export const tools: SketchToolDef[] = [
  {
    id: "sketch.text",
    name: "text",
    label: "Text",
    icon: "sketchText",
    title: "Text: click where its baseline starts, then type it (Enter). Extrude it to emboss, cut it to engrave",
    flyout: { id: "curve", label: "Curve" },
    clicks: 1,
    prompts: ["Click where the text's baseline starts"],
    options: [{ kind: "number", key: "height", label: "Height", title: "The capital letters' height", default: 5, min: 0.1, max: 10000, step: 1, unit: "mm" }],
    build: (clicks, options, ids) => {
      const id = ids("t");
      const height = typeof options.height === "number" && options.height > 0 ? options.height : 5;
      return { entities: [{ id, type: "text", at: clicks[0].p, text: NEW_TEXT, height }], relations: [], roles: [{ point: `${id}.at` }] };
    },
  },
];

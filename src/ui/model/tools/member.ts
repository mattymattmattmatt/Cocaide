// Member (weldments): another of the selected (or last) member, else the
// section library to pick a size from.

import type { ProfileDef } from "../../../doc/types";
import { placeMember } from "../../../weldment/library";
import type { ToolDef } from "../ToolContext";

export const tools: ToolDef[] = [
  {
    id: "tool.member",
    label: "Member",
    icon: "member",
    tab: "weldments",
    group: "members",
    title: "A straight member of a weldment profile: another like the selected one, or pick a size in Sections",
    testId: "tool-member",
    run: (ctx) => {
      const { doc } = ctx;
      if (!doc) return ctx.notice("Fix the document JSON first.");
      const like = (ctx.selected?.op === "member" ? ctx.selected : [...ctx.resolved].reverse().find((f) => f.op === "member")) as { profile: string; size: string } | undefined;
      if (!like || !(doc.profiles as Record<string, ProfileDef> | undefined)?.[like.profile]) {
        ctx.setRightTab("sections");
        return ctx.notice(
          ctx.library.length ? "Pick a size in Sections, then + Member." : "The section library is empty: draw a section as a sketch, tick Weldment profile and finish it.",
          "info",
        );
      }
      const r = placeMember(doc, like.profile, like.size);
      if (!r.ok) return ctx.notice(r.error);
      ctx.replace(r.doc, r.id);
    },
  },
];

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
    title: "Members of a weldment profile: pick a size, then click sketch lines (or type a path of nodes); choose where the section sits on the line and how the corners join",
    testId: "tool-member",
    run: (ctx) => {
      const { doc } = ctx;
      if (!doc) return ctx.notice("Fix the document JSON first.");
      const like = (ctx.selected?.op === "member" ? ctx.selected : [...ctx.resolved].reverse().find((f) => f.op === "member")) as { profile: string; size: string } | undefined;
      // The Member command: a size, the lines (or nodes) they run along, where the section sits, the corners.
      if (ctx.members) {
        const known = like && (doc.profiles as Record<string, ProfileDef> | undefined)?.[like.profile];
        return ctx.members(known ? { size: `part|${like.profile}|${like.size}` } : {});
      }
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

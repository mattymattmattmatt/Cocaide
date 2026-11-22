// Plan symbols on a sheet: Door (click the hinge, then the far end of the
// shut leaf, then the side it opens to) and Room (type its name, click inside
// the room: its area comes from the plan's lines round the click). Both keep
// their points in the view's own millimetres, so they scale and move with it.

import type { ReactNode } from "react";
import type { DoorAnnotation, Vec2 } from "../../../doc/types";
import { sheetToView } from "../../../drafting/compose";
import { ANNOTATION_SCHEMAS } from "../../../drafting/annotate";
import { fieldsOf } from "./annotationKinds";
import { registerAnnotationKind, type KindCtx } from "./kinds";
import { registerDrawingTool } from "./registry";
import { noViews, ToolSession } from "./toolSession";
import type { OverlayShape, SheetPointer } from "./types";
import { Commit, Row } from "./ui";

const mm = (x: number) => Math.round(x) + 0;
const half = (x: number) => Math.round(x * 2) / 2 + 0;

/** A drag on the sheet as a move in the view: by the view's scale, turned back with it. */
function viewDelta(ctx: KindCtx, view: unknown, d: Vec2): Vec2 | null {
  const cv = typeof view === "string" ? ctx.sheet.views.find((v) => v.id === view) : undefined;
  if (!cv) return null;
  const a = sheetToView(cv, [cv.centre[0], cv.centre[1]]);
  const b = sheetToView(cv, [cv.centre[0] + d[0], cv.centre[1] + d[1]]);
  return [b[0] - a[0], b[1] - a[1]];
}

// ------------------------------------------------------------------ door

class DoorSession extends ToolSession {
  onView: string | null = null;
  hinge: Vec2 | null = null;
  far: Vec2 | null = null;
  double = false;
  name() {
    return "Door";
  }
  busy() {
    return !!this.hinge;
  }
  reset() {
    this.onView = this.hinge = this.far = null;
  }
  prompt() {
    return !this.hinge ? "Click the door's hinge on a plan view (it snaps to the plan's corners)" : !this.far ? "Click the far end of the shut leaf (the other jamb)" : "Click the side it opens to";
  }
  inView(p: SheetPointer): Vec2 | null {
    const cv = p.view ? this.cv(p.view) : undefined;
    return cv ? sheetToView(cv, p.at) : null;
  }
  door(side?: Vec2): Omit<DoorAnnotation, "id"> | null {
    if (!this.onView || !this.hinge) return null;
    const far = this.far ?? side;
    if (!far) return null;
    const d: Vec2 = [far[0] - this.hinge[0], far[1] - this.hinge[1]];
    const width = Math.hypot(d[0], d[1]);
    if (width < 1) return null;
    const angle = half((Math.atan2(d[1], d[0]) * 180) / Math.PI);
    // Which side of the leaf's line the pointer is: counter-clockwise is "left".
    const s = this.far && side ? d[0] * (side[1] - this.hinge[1]) - d[1] * (side[0] - this.hinge[0]) : 1;
    return { type: "door", view: this.onView, hinge: [mm(this.hinge[0]), mm(this.hinge[1])], width: mm(width), ...(angle ? { angle } : {}), ...(s < 0 ? { swing: "right" as const } : {}), ...(this.double ? { double: true } : {}) };
  }
  click(p: SheetPointer) {
    const q = this.inView(p);
    const c = this.ctx();
    if (!q || (this.onView && p.view !== this.onView)) return c.notice("Click in the plan view", "error");
    if (!this.hinge) {
      this.onView = p.view;
      this.hinge = q;
    } else if (!this.far) this.far = q;
    else {
      const d = this.door(q);
      if (d && this.add(d as never)) this.reset();
    }
    c.refresh();
  }
  overlay(): OverlayShape[] {
    const h = this.hover;
    const q = h ? this.inView(h) : null;
    const d = this.door(q ?? undefined);
    return [...this.highlight(h?.snap), ...(d ? this.preview(d as never) : [])];
  }
  panel(): ReactNode {
    return (
      <div className="session-options">
        <Row label="Double">
          <input type="checkbox" checked={this.double} onChange={(e) => { this.double = e.target.checked; this.ctx().refresh(); }} data-testid="door-double" />
        </Row>
      </div>
    );
  }
}

registerDrawingTool({
  id: "annotation.door",
  tab: "annotation",
  group: "notes",
  label: "Door",
  icon: "arc",
  title: "A door's swing on a plan: click the hinge, the far end of the shut leaf, then the side it opens to",
  testId: "tool-annotation-door",
  disabled: noViews,
  run: (get) => new DoorSession("annotation.door", get),
});

// ------------------------------------------------------------------ room

class RoomSession extends ToolSession {
  label = "";
  area = true;
  size = false;
  name() {
    return "Room";
  }
  busy() {
    return false;
  }
  reset() {}
  prompt() {
    return "Type the room's name, then click inside it on a plan view";
  }
  room(p: SheetPointer | null) {
    const cv = p?.view ? this.cv(p.view) : undefined;
    if (!p || !cv) return null;
    const at = sheetToView(cv, p.raw);
    const n = this.made.length + 1;
    return { type: "room", view: cv.id, name: this.label.trim() || `ROOM ${n}`, at: [mm(at[0]), mm(at[1])], ...(this.area ? {} : { area: false }), ...(this.size ? { size: true } : {}) };
  }
  click(p: SheetPointer) {
    const r = this.room(p);
    if (!r) return this.ctx().notice("Click inside a room on a plan view", "error");
    if (this.add(r)) this.label = "";
    this.ctx().refresh();
  }
  overlay(): OverlayShape[] {
    const r = this.room(this.hover);
    return r ? this.preview(r) : [];
  }
  panel(): ReactNode {
    const c = this.ctx();
    return (
      <div className="session-options">
        <Row label="Name">
          <Commit value={this.label} width={140} placeholder={`ROOM ${this.made.length + 1}`} onCommit={(s) => { this.label = s; c.refresh(); }} testId="room-name" />
        </Row>
        <Row label="Area">
          <input type="checkbox" checked={this.area} onChange={(e) => { this.area = e.target.checked; c.refresh(); }} data-testid="room-area" />
        </Row>
        <Row label="Size across">
          <input type="checkbox" checked={this.size} onChange={(e) => { this.size = e.target.checked; c.refresh(); }} data-testid="room-size" />
        </Row>
      </div>
    );
  }
}

registerDrawingTool({
  id: "annotation.room",
  tab: "annotation",
  group: "notes",
  label: "Room",
  icon: "rect",
  title: "A room's name and area on a plan: type the name, click inside the room; the area comes from the plan's lines round it (doors close their openings)",
  testId: "tool-annotation-room",
  disabled: noViews,
  run: (get) => new RoomSession("annotation.room", get),
});

// ------------------------------------------------------------------ kinds

registerAnnotationKind({
  type: "door",
  label: "Door",
  icon: "arc",
  prefix: "door",
  schema: { fields: fieldsOf(ANNOTATION_SCHEMAS.door) },
  describe: (a) => `door ${String(a.width ?? "")}${a.double ? " double" : ""}`,
  move: (a, d, ctx) => {
    const v = viewDelta(ctx, a.view, d);
    return v && Array.isArray(a.hinge) ? { hinge: [mm((a.hinge as Vec2)[0] + v[0]), mm((a.hinge as Vec2)[1] + v[1])] } : null;
  },
});

registerAnnotationKind({
  type: "room",
  label: "Room",
  icon: "rect",
  prefix: "room",
  schema: { fields: fieldsOf(ANNOTATION_SCHEMAS.room) },
  describe: (_a, said) => `room ${said?.text ?? ""}`.trim().slice(0, 70),
  move: (a, d, ctx) => {
    const v = viewDelta(ctx, a.view, d);
    return v && Array.isArray(a.at) ? { at: [mm((a.at as Vec2)[0] + v[0]), mm((a.at as Vec2)[1] + v[1])] } : null;
  },
});

// Plain constants of the intent schema, without zod, for the UI.

export const SOURCES = ["stated", "standard", "inferred", "missing"] as const;
export const PLACEMENTS = ["corners", "center", "grid", "points", "circle", "unspecified"] as const;
export const KINDS = ["plate", "disc", "frame", "other"] as const;
/** table: a rectangle on top and a leg at each corner. rectangle: one flat rectangle. */
export const FRAME_TYPES = ["table", "rectangle"] as const;
export const CORNERS = ["mitre", "butt", "unspecified"] as const;

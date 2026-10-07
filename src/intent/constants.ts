// Plain constants of the intent schema, without zod, for the UI.

export const SOURCES = ["stated", "standard", "inferred", "missing"] as const;
export const PLACEMENTS = ["corners", "center", "grid", "points", "circle", "unspecified"] as const;
export const KINDS = ["plate", "disc", "other"] as const;

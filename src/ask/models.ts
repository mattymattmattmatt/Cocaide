// The models the ask can use. Kept apart from model.ts so the UI can list
// them without loading the SDK.

export type Effort = "low" | "medium" | "high";

export const MODELS: { id: string; label: string; effort: boolean }[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", effort: true },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", effort: true },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", effort: false },
];
export const DEFAULT_MODEL = "claude-opus-5-5";

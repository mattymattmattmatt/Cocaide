// The structured outputs the ask reads (readIntent's `schema`), by name. Kept
// apart from model.ts so a provider that does not use the Anthropic SDK (the
// Ollama one) can share them without loading the SDK.

import { DrawingReading } from "../intent/drawing";
import { PhotoReading } from "../intent/photo";
import { Intent } from "../intent/schema";
import { ProfileSuggestion } from "./profile";

export const SCHEMAS = { intent: Intent, drawing: DrawingReading, photo: PhotoReading, profile: ProfileSuggestion } as const;

export type SchemaName = keyof typeof SCHEMAS;

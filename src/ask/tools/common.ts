// Small pieces the AI tools share: the result shape, rounding, and reading
// tool arguments. Browser-safe (the right-click agent runs in the page).

import type { Vec2, Vec3 } from "../../doc/types";
import { isObject } from "../../doc/validate";
import { round6 } from "../../kernel/inspect";

/** What every tool returns: ok, and an error that says what to do when not. */
export type Outcome = { ok: boolean; error?: string } & Record<string, unknown>;

export const fail = (error: string): Outcome => ({ ok: false, error });

/** Numbers to a millionth of a mm, -0 as 0. */
export const r6 = (x: number): number => round6(x) + 0;
export const r3v = (v: readonly number[]): number[] => v.map((x) => r6(x));

export function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

export function isVec2(v: unknown): v is Vec2 {
  return Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

/** The tool's arguments as an object (a model may send null or nothing). */
export function argsOf(input: unknown): Record<string, unknown> {
  return isObject(input) ? input : {};
}

/** A positive whole number argument, or the default. */
export function limitOf(v: unknown, d: number, max = 400): number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? Math.min(v, max) : d;
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

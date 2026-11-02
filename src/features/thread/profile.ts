// ISO metric thread geometry (ISO 68-1 basic profile), pure: the fundamental
// triangle's height H = √3/2 · P; the basic minor diameter d1 = d − 5/4 · H
// (= d − 1.0825 P); the crest flat P/8 at the major diameter and the root flat
// P/4 at the minor (for an external thread; an internal one the other way).
//
// The groove a modelled thread cuts, in a plane through the axis, is a
// trapezoid one pitch long: external, P/4 wide at the minor radius, 7P/8 at
// the major; internal, 3P/4 wide at the minor radius, P/8 at the major. Its
// sides lean 30° (the 60° thread). Swept along the helix its volume over a
// length L is (L / P) · 2π ∫ ρ w(ρ) dρ over the part of the trapezoid in the
// material (Pappus for a screw motion: each turn sweeps what one revolution
// would).

import { ISO_METRIC, type ScrewSize } from "../hole/standards";

/** An external thread's class (ISO 965, medium for bolts). */
export const EXTERNAL_CLASS = "6g";
/** How near (mm) a face's diameter must be to a size's to fit it. */
export const FIT = 0.25;

/** The size a face fits: a shaft of the size's major diameter, a hole of its tap drill (or its minor diameter). */
export function sizeFor(diameter: number, internal: boolean): ScrewSize | undefined {
  const near = (x: number) => Math.abs(x - diameter) <= FIT;
  return ISO_METRIC.find((r) => (internal ? near(r.tapDrill) || near(basicMinor(r.d, r.pitch)) : near(r.d)));
}

/** The fundamental triangle's height for a pitch. */
export function fundamentalHeight(pitch: number): number {
  return (Math.sqrt(3) / 2) * pitch;
}

/** The basic minor diameter d1 (= D1) of a thread. */
export function basicMinor(major: number, pitch: number): number {
  return major - 1.25 * fundamentalHeight(pitch);
}

/**
 * The groove's width (along the axis) at radius ρ, as a line w(ρ) = a + bρ
 * between the minor and major radii: external, P/4 at the minor to 7P/8 at
 * the major; internal, 3P/4 to P/8.
 */
export function grooveWidth(external: boolean, major: number, pitch: number): { a: number; b: number; r0: number; r1: number } {
  const r0 = basicMinor(major, pitch) / 2;
  const r1 = major / 2;
  const [w0, w1] = external ? [pitch / 4, (7 * pitch) / 8] : [(3 * pitch) / 4, pitch / 8];
  const b = (w1 - w0) / (r1 - r0);
  return { a: w0 - b * r0, b, r0, r1 };
}

/**
 * The volume (mm³) a modelled thread cuts over a length L: from a shaft of
 * radius `surface` (external) or the wall of a bore of radius `surface`
 * (internal). Only the groove's part in the material counts: outside the
 * shaft, or inside the bore, there is none to cut.
 */
export function grooveVolume(external: boolean, major: number, pitch: number, surface: number, length: number): number {
  const g = grooveWidth(external, major, pitch);
  // External: the groove from the minor radius out, cut where there is shaft (ρ ≤ surface); internal: up to the major, where there is wall (ρ ≥ surface).
  const lo = external ? g.r0 : Math.max(g.r0, surface);
  const hi = external ? Math.min(g.r1, surface) : g.r1;
  if (hi <= lo) return 0;
  // ∫ ρ (a + bρ) dρ = a ρ²/2 + b ρ³/3.
  const F = (r: number) => (g.a * r * r) / 2 + (g.b * r * r * r) / 3;
  return (length / pitch) * 2 * Math.PI * (F(hi) - F(lo));
}

/** The groove's outline (radius, along the axis), centred on 0 along the axis, reaching `extra` mm past the material so the cut is clean. */
export function grooveOutline(external: boolean, major: number, pitch: number, extra: number): [number, number][] {
  const g = grooveWidth(external, major, pitch);
  const half = (r: number) => (g.a + g.b * r) / 2;
  if (external) {
    const out = g.r1 + extra;
    return [
      [g.r0, -half(g.r0)],
      [out, -half(out)],
      [out, half(out)],
      [g.r0, half(g.r0)],
    ];
  }
  const inn = g.r0 - extra;
  return [
    [inn, -half(inn)],
    [g.r1, -half(g.r1)],
    [g.r1, half(g.r1)],
    [inn, half(inn)],
  ];
}

/** A modelled thread of more turns than this rebuilds slowly: the editor says so. */
export const SLOW_TURNS = 60;
/** The most turns a modelled thread may have. */
export const MAX_TURNS = 400;

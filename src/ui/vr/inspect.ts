// Inspecting a part in VR: holding it like an object in a game. One hand's grip
// takes it as if gripped (it follows the hand, turning with it); two hands move
// it with their middle, turn it as the line between them turns and scale it as
// they spread. Let go and it stays where it is, in the air. The scale is only
// how big it looks: measures are taken in the part's own millimetres. Pure.

import * as THREE from "three";

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 50;

/** Where the part is in the world: its position, turn and how big it is shown (1: true size). */
export interface HeldPose {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: number;
}

/** Two hands from where they gripped (a0, b0) to where they are (a, b): the part's pose from where it was. */
export function twoHandPose(a0: THREE.Vector3, b0: THREE.Vector3, from: HeldPose, a: THREE.Vector3, b: THREE.Vector3): HeldPose {
  const m0 = a0.clone().add(b0).multiplyScalar(0.5);
  const m = a.clone().add(b).multiplyScalar(0.5);
  const d0 = b0.clone().sub(a0);
  const d = b.clone().sub(a);
  const l0 = Math.max(d0.length(), 1e-3);
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (from.scale * d.length()) / l0));
  const k = scale / from.scale;
  const q = d0.lengthSq() > 1e-9 && d.lengthSq() > 1e-9 ? new THREE.Quaternion().setFromUnitVectors(d0.clone().normalize(), d.clone().normalize()) : new THREE.Quaternion();
  return { pos: from.pos.clone().sub(m0).multiplyScalar(k).applyQuaternion(q).add(m), quat: q.multiply(from.quat.clone()), scale };
}

/** The pose scaled about a point (the part's middle stays put): back to true size, say. */
export function scaledAbout(from: HeldPose, about: THREE.Vector3, scale: number): HeldPose {
  const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  return { pos: from.pos.clone().sub(about).multiplyScalar(s / from.scale).add(about), quat: from.quat.clone(), scale: s };
}

/** How big to show a part first: true size when its longest side is up to 1.2 m, else small enough to fit in a metre. */
export function startScale(longestMm: number): number {
  const m = longestMm / 1000;
  return m <= 1.2 || !(m > 0) ? 1 : 1 / m;
}

/** "×2.5", "1:4", "1:1": how big the part is shown. */
export function scaleText(s: number): string {
  if (Math.abs(s - 1) < 0.005) return "1:1";
  if (s > 1) return `×${s >= 10 ? Math.round(s) : Math.round(s * 10) / 10}`;
  const r = 1 / s;
  return `1:${r >= 10 ? Math.round(r) : Math.round(r * 10) / 10}`;
}

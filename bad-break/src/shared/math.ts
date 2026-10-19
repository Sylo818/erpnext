/**
 * Small math helpers shared by simulation, client and server.
 * Scratch-vector helpers avoid allocations inside the fixed-step hot loop.
 */
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector.js";

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
export function easeInOut(t: number): number {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
}
export function easeOut(t: number): number {
  t = clamp01(t);
  return 1 - (1 - t) * (1 - t);
}
export function easeIn(t: number): number {
  t = clamp01(t);
  return t * t;
}
/** Exponential approach: moves current toward target with time constant tau (seconds). */
export function approach(current: number, target: number, tau: number, dt: number): number {
  if (tau <= 0) return target;
  const k = 1 - Math.exp(-dt / tau);
  return current + (target - current) * k;
}
/** Linear move toward target by at most maxDelta. */
export function moveToward(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}
export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}
export function angleLerp(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}
/** Yaw (rotation about +Y) whose forward vector (sin, 0, cos) points along (x, z). */
export function yawFromDirection(x: number, z: number): number {
  return Math.atan2(x, z);
}
export function directionFromYaw(yaw: number, out: Vector3): Vector3 {
  return out.set(Math.sin(yaw), 0, Math.cos(yaw));
}
export function horizontalDistance(a: Vector3, b: Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
export function quatFromYaw(yaw: number, out: Quaternion): Quaternion {
  const h = yaw * 0.5;
  return out.set(0, Math.sin(h), 0, Math.cos(h));
}
/** Quaternion from Euler degrees applied as Z (roll), then X (pitch), then Y (yaw) - Babylon YawPitchRoll. */
export function quatFromEulerDeg(pitchX: number, yawY: number, rollZ: number, out: Quaternion): Quaternion {
  return Quaternion.RotationYawPitchRollToRef(yawY * DEG, pitchX * DEG, rollZ * DEG, out);
}

const _q = new Quaternion();
/**
 * Rotation taking `from` to `to`, expressed as an axis*angle vector in world space
 * (shortest path). Used by bounded PD joint drives.
 */
export function rotationErrorToRef(from: Quaternion, to: Quaternion, out: Vector3): Vector3 {
  // delta = to * inverse(from)
  _q.set(-from.x, -from.y, -from.z, from.w);
  to.multiplyToRef(_q, _q);
  let { x, y, z, w } = _q;
  const n = Math.hypot(x, y, z, w) || 1;
  x /= n;
  y /= n;
  z /= n;
  w /= n;
  if (w < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  const s = Math.hypot(x, y, z);
  if (s < 1e-7) return out.set(0, 0, 0);
  const angle = 2 * Math.atan2(s, w);
  const k = angle / s;
  return out.set(x * k, y * k, z * k);
}
/** Limits the length of a vector in place. Returns true if clamped. */
export function limitLength(v: Vector3, max: number): boolean {
  const l = v.length();
  if (l > max && l > 0) {
    v.scaleInPlace(max / l);
    return true;
  }
  return false;
}
export function isFiniteVec(v: Vector3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}
export function isFiniteQuat(q: Quaternion): boolean {
  return Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w);
}

/** Deterministic seeded PRNG (mulberry32) so bots, debris and variants are reproducible per seed. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  int(lo: number, hiInclusive: number): number {
    return lo + Math.floor(this.next() * (hiInclusive - lo + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  get state(): number {
    return this.s;
  }
}

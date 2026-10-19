/**
 * Procedural gait: foot planting + two-bone leg IK. Feet stay planted in world space while the body
 * moves over them, then step to a predicted home position when stretched too far. No foot skating.
 */
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { RigSpec } from "../data/rigspec.js";
import { clamp, easeInOut } from "../math.js";

export interface FootState {
  planted: boolean;
  pos: Vector3; // ground contact point under the ankle
  from: Vector3;
  to: Vector3;
  t: number;
  dur: number;
  yaw: number;
  pitch: number;
  /** Lift above ground (swing arc). */
  lift: number;
}

const _m = new Matrix();
export function basisToQuat(x: Vector3, y: Vector3, z: Vector3, out: Quaternion): Quaternion {
  Matrix.FromXYZAxesToRef(x, y, z, _m);
  return Quaternion.FromRotationMatrixToRef(_m, out);
}

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _dir = new Vector3();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();

export interface LegSolveOut {
  thighQ: Quaternion;
  shinQ: Quaternion;
  knee: Vector3;
  reach: number; // 0..1 how stretched
}

/**
 * Solve a leg lying in the plane spanned by hip->ankle and the pole direction.
 * Both thigh and shin share the same hinge axis (their local X), matching the rig's knee hinge.
 */
export function solveLegIK(l1: number, l2: number, hip: Vector3, ankle: Vector3, pole: Vector3, out: LegSolveOut): LegSolveOut {
  _dir.copyFrom(ankle).subtractInPlace(hip);
  let D = _dir.length();
  const maxD = (l1 + l2) * 0.999;
  const minD = Math.abs(l1 - l2) + 0.02;
  if (D < 1e-5) {
    _dir.set(0, -1, 0);
    D = 1e-5;
  } else _dir.scaleInPlace(1 / D);
  const Dc = clamp(D, minD, maxD);
  out.reach = clamp(Dc / (l1 + l2), 0, 1);
  const a = (l1 * l1 - l2 * l2 + Dc * Dc) / (2 * Dc);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  // perpendicular direction toward the pole (bending forward)
  _a.copyFrom(pole);
  const pd = Vector3.Dot(_a, _dir);
  _a.addInPlace(_dir.scale(-pd));
  if (_a.lengthSquared() < 1e-6) _a.set(0, 0, 1);
  _a.normalize();
  // knee
  out.knee.copyFrom(hip).addInPlace(_dir.scale(a)).addInPlace(_a.scale(h));
  // thigh bone dir
  _b.copyFrom(out.knee).subtractInPlace(hip).normalize();
  // shin bone dir (to the clamped ankle)
  _c.copyFrom(hip).addInPlace(_dir.scale(Dc));
  _c.subtractInPlace(out.knee).normalize();
  // hinge axis (local X): perpendicular to the leg plane, +X for a forward-facing leg
  _d.copyFrom(_dir);
  Vector3.CrossToRef(_b.negate(), pole, _x); // y1 x pole, with y1 = -boneDir
  if (_x.lengthSquared() < 1e-6) _x.set(1, 0, 0);
  _x.normalize();
  // thigh: y = -boneDir, x = hinge, z = x cross y
  _y.copyFrom(_b).negateInPlace();
  Vector3.CrossToRef(_x, _y, _z);
  _z.normalize();
  basisToQuat(_x, _y, _z, out.thighQ);
  // shin: same hinge axis
  _y.copyFrom(_c).negateInPlace();
  Vector3.CrossToRef(_x, _y, _z);
  _z.normalize();
  basisToQuat(_x, _y, _z, out.shinQ);
  return out;
}

export interface GaitParams {
  /** Horizontal root velocity (world). */
  vx: number;
  vz: number;
  yaw: number;
  rootX: number;
  rootZ: number;
  groundY: number;
  /** Stance half-width multiplier. */
  stance: number;
  /** Forward offset of the lead foot (staggered fighting stance), +ve = right foot forward. */
  stagger: number;
  /** 0 = left foot disabled (hopping on right), etc. */
  enabled: [boolean, boolean];
  stepScale: number;
  dt: number;
  /** Pause stepping (e.g. attacking, planted). */
  freeze: boolean;
}

export class Gait {
  feet: [FootState, FootState];
  /** Accumulated distance walked, for arm swing phase. */
  travel = 0;
  /** 0..1 smoothed speed. */
  speed = 0;
  /** Step cycle phase 0..1 (0 left plant, 0.5 right plant) derived from swing states. */
  stepPhase = 0;
  private hipHalf: number;
  constructor(private spec: RigSpec) {
    this.hipHalf = spec.byName.thighR.pivotParent[0];
    const mk = (): FootState => ({ planted: true, pos: new Vector3(), from: new Vector3(), to: new Vector3(), t: 0, dur: 0.3, yaw: 0, pitch: 0, lift: 0 });
    this.feet = [mk(), mk()];
  }

  reset(x: number, z: number, yaw: number, groundY: number) {
    const sx = Math.cos(yaw),
      sz = -Math.sin(yaw); // right vector for yaw (forward = sin,cos)
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const f = this.feet[i];
      f.planted = true;
      f.t = 0;
      f.pos.set(x + sx * side * this.hipHalf * 1.15, groundY, z + sz * side * this.hipHalf * 1.15);
      f.from.copyFrom(f.pos);
      f.to.copyFrom(f.pos);
      f.yaw = yaw;
      f.pitch = 0;
      f.lift = 0;
    }
    this.travel = 0;
  }

  update(p: GaitParams) {
    const sp = Math.hypot(p.vx, p.vz);
    this.speed += (clamp(sp / 4.2, 0, 1) - this.speed) * Math.min(1, p.dt * 8);
    this.travel += sp * p.dt;
    const fx = Math.sin(p.yaw),
      fz = Math.cos(p.yaw);
    const rx = fz,
      rz = -fx; // right
    const dirx = sp > 0.05 ? p.vx / sp : 0,
      dirz = sp > 0.05 ? p.vz / sp : 0;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const f = this.feet[i];
      const o = this.feet[1 - i];
      const stagger = p.stagger * (i === 1 ? 1 : -1) * 0.5;
      const hx = p.rootX + rx * side * this.hipHalf * 1.15 * p.stance + fx * stagger + p.vx * 0.1;
      const hz = p.rootZ + rz * side * this.hipHalf * 1.15 * p.stance + fz * stagger + p.vz * 0.1;
      if (!p.enabled[i]) {
        // disabled legs (detached / hopping lifted leg) dangle: just follow under the hip
        f.planted = true;
        f.pos.set(hx, p.groundY + 0.25, hz);
        f.lift = 0.25;
        continue;
      }
      if (f.planted) {
        const dx = f.pos.x - hx,
          dz = f.pos.z - hz;
        const d = Math.hypot(dx, dz);
        const thresh = (0.17 + 0.07 * this.speed) / Math.max(0.5, p.stepScale);
        const otherOk = o.planted || o.t > 0.55 || !p.enabled[1 - i];
        if (!p.freeze && d > thresh && otherOk) {
          f.planted = false;
          f.t = 0;
          f.from.copyFrom(f.pos);
          f.dur = clamp(0.42 - 0.07 * sp, 0.15, 0.42);
          f.to.set(hx + dirx * 0.12 * sp * 0.5, p.groundY, hz + dirz * 0.12 * sp * 0.5);
        }
        f.lift = 0;
        f.pitch += (0 - f.pitch) * Math.min(1, p.dt * 14);
        f.pos.y = p.groundY;
      } else {
        f.t += p.dt / f.dur;
        // retarget continuously so the foot lands under the (moving) hips
        f.to.set(hx + dirx * 0.12 * sp * 0.5, p.groundY, hz + dirz * 0.12 * sp * 0.5);
        const t = clamp(f.t, 0, 1);
        const e = easeInOut(t);
        f.pos.x = f.from.x + (f.to.x - f.from.x) * e;
        f.pos.z = f.from.z + (f.to.z - f.from.z) * e;
        f.lift = Math.sin(Math.PI * t) * (0.06 + 0.04 * this.speed);
        f.pos.y = p.groundY + f.lift;
        f.pitch = (1 - t) * 0.45 * Math.min(1, sp) - t * 0.18 * Math.min(1, sp);
        if (f.t >= 1) {
          f.planted = true;
          f.pos.y = p.groundY;
          f.lift = 0;
        }
      }
      // toe direction follows body yaw with slight toe-out
      f.yaw += clamp(p.yaw + side * 0.12 - f.yaw, -p.dt * 14, p.dt * 14);
    }
    const sw0 = this.feet[0].planted ? 0 : this.feet[0].t;
    const sw1 = this.feet[1].planted ? 0 : this.feet[1].t;
    this.stepPhase = sw0 > 0 ? 0.5 * sw0 : sw1 > 0 ? 0.5 + 0.5 * sw1 : this.stepPhase;
  }
}

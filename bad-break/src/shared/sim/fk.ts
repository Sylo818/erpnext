import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { RIG_BODIES, RIG_COUNT, RIG_INDEX, RIG_PARENT, type RigBody } from "../data/regions.js";
import type { RigSpec } from "../data/rigspec.js";

/**
 * A pose = per-joint local Euler rotations (rx, ry, rz radians; rest-frame, see rigspec.ts)
 * plus a root transform for the pelvis. Used as the hidden animation target rig.
 */
export class Pose {
  /** rx, ry, rz per body, indexed by RIG_INDEX. The pelvis entry is the pelvis local lean (relative to root yaw). */
  euler = new Float32Array(RIG_COUNT * 3);
  rootPos = new Vector3();
  rootQ = Quaternion.Identity();
  copyFrom(o: Pose): this {
    this.euler.set(o.euler);
    this.rootPos.copyFrom(o.rootPos);
    this.rootQ.copyFrom(o.rootQ);
    return this;
  }
  clearEuler(): this {
    this.euler.fill(0);
    return this;
  }
  set(b: RigBody, rx: number, ry = 0, rz = 0): this {
    const i = RIG_INDEX[b] * 3;
    this.euler[i] = rx;
    this.euler[i + 1] = ry;
    this.euler[i + 2] = rz;
    return this;
  }
  get(b: RigBody, axis: 0 | 1 | 2): number {
    return this.euler[RIG_INDEX[b] * 3 + axis];
  }
}

export class FkResult {
  q: Quaternion[] = [];
  p: Vector3[] = [];
  constructor() {
    for (let i = 0; i < RIG_COUNT; i++) {
      this.q.push(Quaternion.Identity());
      this.p.push(new Vector3());
    }
  }
}

const _local = Quaternion.Identity();
const _v = new Vector3();
const _w = new Vector3();

/** Local rotation from rest-frame Euler: Babylon yaw=ry, pitch=rx, roll=rz. */
export function localQuat(rx: number, ry: number, rz: number, out: Quaternion): Quaternion {
  return Quaternion.RotationYawPitchRollToRef(ry, rx, rz, out);
}

/**
 * Forward kinematics. Pelvis origin world = pose.rootPos; pelvis world rotation = rootQ * local(pelvis euler).
 * child.q = parent.q * local; child.p = parent.p + parent.q*pivotParent - child.q*pivotSelf.
 */
export function computeFK(spec: RigSpec, pose: Pose, out: FkResult): FkResult {
  for (let i = 0; i < RIG_COUNT; i++) {
    const name = RIG_BODIES[i];
    const e = pose.euler;
    localQuat(e[i * 3], e[i * 3 + 1], e[i * 3 + 2], _local);
    const bs = spec.byName[name];
    if (name === "pelvis") {
      pose.rootQ.multiplyToRef(_local, out.q[i]);
      out.p[i].copyFrom(pose.rootPos);
    } else {
      const pi = RIG_INDEX[RIG_PARENT[name as Exclude<RigBody, "pelvis">]];
      out.q[pi].multiplyToRef(_local, out.q[i]);
      _v.set(bs.pivotParent[0], bs.pivotParent[1], bs.pivotParent[2]);
      _v.rotateByQuaternionToRef(out.q[pi], _v);
      _w.set(bs.pivotSelf[0], bs.pivotSelf[1], bs.pivotSelf[2]);
      _w.rotateByQuaternionToRef(out.q[i], _w);
      out.p[i].copyFrom(out.p[pi]).addInPlace(_v).subtractInPlace(_w);
    }
  }
  return out;
}

/** World position of a joint (parent-side anchor) of body `name` given FK. */
export function jointWorld(spec: RigSpec, fk: FkResult, name: RigBody, out: Vector3): Vector3 {
  const i = RIG_INDEX[name];
  const bs = spec.byName[name];
  out.set(bs.pivotSelf[0], bs.pivotSelf[1], bs.pivotSelf[2]);
  out.rotateByQuaternionToRef(fk.q[i], out);
  return out.addInPlace(fk.p[i]);
}
/** World position of a point given in body-local coordinates. */
export function localToWorld(fk: FkResult, name: RigBody, local: readonly [number, number, number], out: Vector3): Vector3 {
  const i = RIG_INDEX[name];
  out.set(local[0], local[1], local[2]);
  out.rotateByQuaternionToRef(fk.q[i], out);
  return out.addInPlace(fk.p[i]);
}

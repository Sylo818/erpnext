/**
 * Pose layers and keyframe sampling for the hidden animation-target rig.
 * A Layer is a full set of joint Euler rotations (radians) plus root parameters.
 */
import { RIG_BODIES, RIG_COUNT, RIG_INDEX, mirrorName, type RigBody } from "../data/regions.js";
import type { JointPose, Key, MoveDef, RootKey } from "../data/moves.js";
import { DEG, easeInOut, lerp } from "../math.js";

export class RootState {
  lean = 0; // degrees fwd
  twist = 0; // degrees
  side = 0;
  drop = 0; // metres
  fwd = 0; // metres
  yaw = 0; // degrees
  copyFrom(o: RootState): this {
    this.lean = o.lean;
    this.twist = o.twist;
    this.side = o.side;
    this.drop = o.drop;
    this.fwd = o.fwd;
    this.yaw = o.yaw;
    return this;
  }
  clear(): this {
    this.lean = this.twist = this.side = this.drop = this.fwd = this.yaw = 0;
    return this;
  }
  lerpTo(o: RootState, t: number): this {
    this.lean = lerp(this.lean, o.lean, t);
    this.twist = lerp(this.twist, o.twist, t);
    this.side = lerp(this.side, o.side, t);
    this.drop = lerp(this.drop, o.drop, t);
    this.fwd = lerp(this.fwd, o.fwd, t);
    this.yaw = lerp(this.yaw, o.yaw, t);
    return this;
  }
  addKey(r: RootKey | undefined, w: number, mirror: boolean) {
    if (!r) return;
    if (r.lean !== undefined) this.lean += r.lean * w;
    if (r.twist !== undefined) this.twist += (mirror ? -r.twist : r.twist) * w;
    if (r.side !== undefined) this.side += (mirror ? -r.side : r.side) * w;
    if (r.drop !== undefined) this.drop += r.drop * w;
    if (r.fwd !== undefined) this.fwd += r.fwd * w;
    if (r.yaw !== undefined) this.yaw += (mirror ? -r.yaw : r.yaw) * w;
  }
}

export class Layer {
  e = new Float32Array(RIG_COUNT * 3);
  root = new RootState();
  copyFrom(o: Layer): this {
    this.e.set(o.e);
    this.root.copyFrom(o.root);
    return this;
  }
  clear(): this {
    this.e.fill(0);
    this.root.clear();
    return this;
  }
  lerpTo(o: Layer, t: number): this {
    if (t <= 0) return this;
    if (t >= 1) return this.copyFrom(o);
    for (let i = 0; i < this.e.length; i++) this.e[i] += (o.e[i] - this.e[i]) * t;
    this.root.lerpTo(o.root, t);
    return this;
  }
  /** Replace only joints present in `pose` (absolute, degrees) blended by weight. */
  setPose(pose: JointPose, w = 1, mirror = false) {
    for (const key in pose) {
      const name = (mirror ? mirrorName(key as RigBody) : (key as RigBody)) as RigBody;
      const v = pose[key as RigBody]!;
      const i = RIG_INDEX[name] * 3;
      const sgn = mirror ? -1 : 1;
      this.e[i] += ((v[0] ?? 0) * DEG - this.e[i]) * w;
      this.e[i + 1] += ((v[1] ?? 0) * DEG * sgn - this.e[i + 1]) * w;
      this.e[i + 2] += ((v[2] ?? 0) * DEG * sgn - this.e[i + 2]) * w;
    }
  }
  /** Add degrees on top. */
  addPose(pose: JointPose, w = 1, mirror = false) {
    for (const key in pose) {
      const name = (mirror ? mirrorName(key as RigBody) : (key as RigBody)) as RigBody;
      const v = pose[key as RigBody]!;
      const i = RIG_INDEX[name] * 3;
      const sgn = mirror ? -1 : 1;
      this.e[i] += (v[0] ?? 0) * DEG * w;
      this.e[i + 1] += (v[1] ?? 0) * DEG * sgn * w;
      this.e[i + 2] += (v[2] ?? 0) * DEG * sgn * w;
    }
  }
  add(b: RigBody, rx: number, ry = 0, rz = 0) {
    const i = RIG_INDEX[b] * 3;
    this.e[i] += rx;
    this.e[i + 1] += ry;
    this.e[i + 2] += rz;
  }
  set(b: RigBody, rx: number, ry = 0, rz = 0) {
    const i = RIG_INDEX[b] * 3;
    this.e[i] = rx;
    this.e[i + 1] = ry;
    this.e[i + 2] = rz;
  }
  /** Blend only specific joints from another layer. */
  lerpJoints(o: Layer, joints: readonly RigBody[], t: number) {
    for (const b of joints) {
      const i = RIG_INDEX[b] * 3;
      for (let k = 0; k < 3; k++) this.e[i + k] += (o.e[i + k] - this.e[i + k]) * t;
    }
  }
}

export const ARM_R: readonly RigBody[] = ["upperArmR", "forearmR", "handR"];
export const ARM_L: readonly RigBody[] = ["upperArmL", "forearmL", "handL"];
export const LEG_R: readonly RigBody[] = ["thighR", "shinR", "footR"];
export const LEG_L: readonly RigBody[] = ["thighL", "shinL", "footL"];
export const TORSO: readonly RigBody[] = ["spine", "chest", "head"];
export const UPPER_ALL: readonly RigBody[] = [...ARM_R, ...ARM_L, ...TORSO];

// ---- compiled keyframe move ----
interface CompiledKey {
  t: number;
  /** per rig index: [rx,ry,rz] in radians or null = inherit base */
  v: (Float32Array | null)[];
  root: RootKey | undefined;
}
export interface CompiledMove {
  keys: CompiledKey[];
  joints: number[]; // rig indices touched by any key
  duration: number;
}

const compiledCache = new WeakMap<object, CompiledMove>();

function compileKeys(keys: Key[]): CompiledMove {
  const out: CompiledKey[] = [];
  const touched = new Set<number>();
  for (const k of keys) {
    const v: (Float32Array | null)[] = new Array(RIG_COUNT).fill(null);
    if (k.j) {
      for (const key in k.j) {
        const idx = RIG_INDEX[key as RigBody];
        const p = k.j[key as RigBody]!;
        v[idx] = Float32Array.of((p[0] ?? 0) * DEG, (p[1] ?? 0) * DEG, (p[2] ?? 0) * DEG);
        touched.add(idx);
      }
    }
    out.push({ t: k.t, v, root: k.r });
  }
  return { keys: out, joints: [...touched], duration: keys.length ? keys[keys.length - 1].t : 0 };
}
export function compileMove(m: { keys: Key[] }): CompiledMove {
  let c = compiledCache.get(m);
  if (!c) {
    c = compileKeys(m.keys);
    compiledCache.set(m, c);
  }
  return c;
}

const _rootTmp = new RootState();
/**
 * Evaluate a compiled keyframe set at time t over `base` (the stance layer). Writes the result into `out`
 * (which must already hold `base`). `weight` fades the whole effect. Mirror flips the authored side.
 */
export function sampleKeys(cm: CompiledMove, t: number, base: Layer, out: Layer, mirror: boolean, weight = 1) {
  const keys = cm.keys;
  if (keys.length === 0) return;
  let i = 0;
  if (t >= keys[keys.length - 1].t) i = keys.length - 2;
  else {
    while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
  }
  if (i < 0) i = 0;
  const a = keys[i];
  const b = keys[Math.min(i + 1, keys.length - 1)];
  const span = Math.max(1e-6, b.t - a.t);
  const u = t <= a.t ? 0 : t >= b.t ? 1 : easeInOut((t - a.t) / span);
  for (const ji of cm.joints) {
    const tgt = mirror ? RIG_INDEX[mirrorName(RIG_BODIES[ji])] : ji;
    const sgn = mirror ? -1 : 1;
    // base values live at the *authored* joint of the output (mirror target)
    const ob = tgt * 3;
    const va = a.v[ji];
    const vb = b.v[ji];
    for (let k = 0; k < 3; k++) {
      const s = k === 0 ? 1 : sgn;
      const bv = base.e[ob + k];
      const x0 = va ? va[k] * s : bv;
      const x1 = vb ? vb[k] * s : bv;
      const x = x0 + (x1 - x0) * u;
      out.e[ob + k] = bv + (x - bv) * weight;
    }
  }
  // root
  _rootTmp.clear();
  const ra = a.root,
    rb = b.root;
  const addR = (r: RootKey | undefined, w: number) => _rootTmp.addKey(r, w, mirror);
  addR(ra, 1 - u);
  addR(rb, u);
  const o = out.root;
  o.lean = base.root.lean + (_rootTmp.lean - base.root.lean) * weight;
  o.twist = base.root.twist + (_rootTmp.twist - base.root.twist) * weight;
  o.side = base.root.side + (_rootTmp.side - base.root.side) * weight;
  o.drop = base.root.drop + (_rootTmp.drop - base.root.drop) * weight;
  o.fwd = base.root.fwd + (_rootTmp.fwd - base.root.fwd) * weight;
  o.yaw = base.root.yaw + (_rootTmp.yaw - base.root.yaw) * weight;
}

export function sampleMove(m: MoveDef, t: number, base: Layer, out: Layer, weight = 1) {
  sampleKeys(compileMove(m), t, base, out, m.side === "L", weight);
}

/** Fraction (0..1) of the way through a move's hit window for effects. */
export function bump(t: number, a: number, b: number): number {
  if (t <= a || t >= b) return 0;
  const u = (t - a) / (b - a);
  return Math.sin(u * Math.PI);
}

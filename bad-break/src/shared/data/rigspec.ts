/**
 * Data-driven physical rig specification (pure numbers, no engine imports) so the simulation,
 * the offline asset tools and the renderer share one source of truth.
 *
 * Conventions
 *  - Left-handed, Y up, character faces +Z. The fighter's RIGHT side is +X, LEFT is -X.
 *  - Every body frame is aligned with the world at the standing rest pose (identity rotation).
 *  - Body origin == shape centre. `pivotParent` is the joint point in the parent's frame (relative to
 *    the parent origin); `pivotSelf` is the same joint point in the child's own frame.
 *  - Limb positive rotations (rest frame): rotX>0 swings a hanging bone BACKWARD (-Z); rotZ>0 swings it
 *    toward +X (outward for the right arm); rotY is twist about the bone's long axis.
 */
import { RIG_BODIES, RIG_PARENT, type RigBody, mirrorName } from "./regions.js";

export type V3 = readonly [number, number, number];
export type Range = readonly [number, number];

export type ShapeSpec =
  | { kind: "capsule"; a: V3; b: V3; r: number }
  | { kind: "box"; c: V3; half: V3 }
  | { kind: "sphere"; c: V3; r: number };

export interface JointLimits {
  /** Rest-frame rotation limits in radians. Missing = locked at 0. */
  x?: Range;
  y?: Range;
  z?: Range;
}

export interface DriveSpec {
  /** Angular spring gain (1/s): desired angular velocity = gain * rotation error. */
  gain: number;
  /** Max angular acceleration the drive may command (rad/s^2). Bounds torque = inertia * this. */
  maxAccel: number;
  /** Max angular speed the drive will ask for (rad/s). */
  maxSpeed: number;
  /** Passive damping applied to the body while driven (angular, 1/s). */
  damping: number;
}

export interface BodySpec {
  name: RigBody;
  parent: RigBody | null;
  pivotParent: V3;
  pivotSelf: V3;
  shape: ShapeSpec;
  mass: number;
  inertia: V3; // diagonal, body frame
  limits: JointLimits;
  drive: DriveSpec;
  /** Standing rest world centre relative to the pelvis origin rest at (0, pelvisHeight, 0). */
  restCenter: V3;
  /** Rest-pose joint (pivot) world position relative to ground, x/z relative to the root. */
  restJoint: V3;
  /** Approx capsule/box dimensions for the asset tools: length along local Y and radius. */
  length: number;
  radius: number;
}

export interface RigSpec {
  height: number;
  girth: number;
  totalMass: number;
  pelvisHeight: number; // standing height of the pelvis origin above ground
  bodies: BodySpec[];
  byName: Record<RigBody, BodySpec>;
  /** Face hit volumes in HEAD body local space. */
  face: { nose: { c: V3; r: number }; eyeL: { c: V3; r: number }; eyeR: { c: V3; r: number } };
  /** Palm grip anchor in hand local space, and fingertip strike point. */
  gripAnchor: V3;
  strikePoint: V3;
  /** Movement capsule. */
  capsule: { height: number; radius: number };
  /** Chest/torso half-width etc. for guard geometry. */
  shoulderHalfWidth: number;
}

interface BaseBody {
  parent: RigBody | null;
  pp: V3; // pivotParent (base units)
  ps: V3; // pivotSelf
  shape: (s: number, g: number) => ShapeSpec;
  mass: number;
  limits: JointLimits;
  drive: DriveSpec;
}

const D = (gain: number, maxAccel: number, maxSpeed: number, damping: number): DriveSpec => ({ gain, maxAccel, maxSpeed, damping });
const mirrorLimits = (l: JointLimits): JointLimits => ({
  x: l.x,
  y: l.y ? [-l.y[1], -l.y[0]] : undefined,
  z: l.z ? [-l.z[1], -l.z[0]] : undefined,
});
const neg = (v: V3): V3 => [-v[0], v[1], v[2]];

const BASE: Record<RigBody, BaseBody> = {
  pelvis: {
    parent: null,
    pp: [0, 0, 0],
    ps: [0, 0, 0],
    shape: () => ({ kind: "box", c: [0, 0, 0], half: [0.165, 0.09, 0.105] }),
    mass: 11,
    limits: {},
    drive: D(14, 900, 20, 2),
  },
  spine: {
    parent: "pelvis",
    pp: [0, 0.07, 0],
    ps: [0, -0.09, 0],
    shape: () => ({ kind: "box", c: [0, 0, 0], half: [0.15, 0.09, 0.095] }),
    mass: 7,
    limits: { x: [-0.45, 0.65], y: [-0.5, 0.5], z: [-0.4, 0.4] },
    drive: D(16, 1000, 18, 2),
  },
  chest: {
    parent: "spine",
    pp: [0, 0.09, 0],
    ps: [0, -0.16, 0],
    shape: () => ({ kind: "box", c: [0, 0, 0], half: [0.185, 0.16, 0.12] }),
    mass: 16,
    limits: { x: [-0.45, 0.5], y: [-0.6, 0.6], z: [-0.35, 0.35] },
    drive: D(16, 1000, 18, 2),
  },
  head: {
    parent: "chest",
    pp: [0, 0.16, 0],
    ps: [0, -0.15, 0],
    shape: () => ({ kind: "sphere", c: [0, 0.03, 0], r: 0.11 }),
    mass: 5,
    limits: { x: [-0.75, 0.7], y: [-1.1, 1.1], z: [-0.55, 0.55] },
    drive: D(18, 1400, 22, 3),
  },
  upperArmR: {
    parent: "chest",
    pp: [0.205, 0.12, 0],
    ps: [0, 0.14, 0],
    shape: () => ({ kind: "capsule", a: [0, 0.09, 0], b: [0, -0.09, 0], r: 0.052 }),
    mass: 2.2,
    // x: forward raise negative / backward positive. z: abduction outward positive (right). y: twist.
    limits: { x: [-3.0, 1.3], y: [-1.2, 1.2], z: [-0.3, 1.45] },
    drive: D(20, 1600, 26, 1.5),
  },
  upperArmL: { parent: "chest", pp: [-0.205, 0.12, 0], ps: [0, 0.14, 0], shape: () => ({ kind: "capsule", a: [0, 0.09, 0], b: [0, -0.09, 0], r: 0.052 }), mass: 2.2, limits: mirrorLimits({ x: [-3.0, 1.3], y: [-1.2, 1.2], z: [-0.3, 1.45] }), drive: D(20, 1600, 26, 1.5) },
  forearmR: {
    parent: "upperArmR",
    pp: [0, -0.14, 0],
    ps: [0, 0.125, 0],
    shape: () => ({ kind: "capsule", a: [0, 0.08, 0], b: [0, -0.08, 0], r: 0.044 }),
    mass: 1.4,
    // Elbow flexes forward: negative rotX.
    limits: { x: [-2.65, 0.04], y: [-0.5, 0.5], z: [-0.06, 0.06] },
    drive: D(22, 2200, 30, 1.2),
  },
  forearmL: { parent: "upperArmL", pp: [0, -0.14, 0], ps: [0, 0.125, 0], shape: () => ({ kind: "capsule", a: [0, 0.08, 0], b: [0, -0.08, 0], r: 0.044 }), mass: 1.4, limits: mirrorLimits({ x: [-2.65, 0.04], y: [-0.5, 0.5], z: [-0.06, 0.06] }), drive: D(22, 2200, 30, 1.2) },
  handR: {
    parent: "forearmR",
    pp: [0, -0.125, 0],
    ps: [0, 0.075, 0],
    shape: () => ({ kind: "box", c: [0, 0, 0], half: [0.048, 0.08, 0.04] }),
    mass: 0.55,
    limits: { x: [-0.9, 0.9], y: [-0.3, 0.3], z: [-0.5, 0.5] },
    drive: D(24, 3000, 32, 1),
  },
  handL: { parent: "forearmL", pp: [0, -0.125, 0], ps: [0, 0.075, 0], shape: () => ({ kind: "box", c: [0, 0, 0], half: [0.048, 0.08, 0.04] }), mass: 0.55, limits: mirrorLimits({ x: [-0.9, 0.9], y: [-0.3, 0.3], z: [-0.5, 0.5] }), drive: D(24, 3000, 32, 1) },
  thighR: {
    parent: "pelvis",
    pp: [0.095, -0.06, 0],
    ps: [0, 0.215, 0],
    shape: () => ({ kind: "capsule", a: [0, 0.14, 0], b: [0, -0.14, 0], r: 0.075 }),
    mass: 8.5,
    limits: { x: [-1.9, 0.7], y: [-0.6, 0.6], z: [-0.45, 0.8] },
    drive: D(18, 1200, 20, 2),
  },
  thighL: { parent: "pelvis", pp: [-0.095, -0.06, 0], ps: [0, 0.215, 0], shape: () => ({ kind: "capsule", a: [0, 0.14, 0], b: [0, -0.14, 0], r: 0.075 }), mass: 8.5, limits: mirrorLimits({ x: [-1.9, 0.7], y: [-0.6, 0.6], z: [-0.45, 0.8] }), drive: D(18, 1200, 20, 2) },
  shinR: {
    parent: "thighR",
    pp: [0, -0.215, 0],
    ps: [0, 0.205, 0],
    shape: () => ({ kind: "capsule", a: [0, 0.15, 0], b: [0, -0.15, 0], r: 0.055 }),
    mass: 3.6,
    // Knee flexes backward: positive rotX.
    limits: { x: [-0.04, 2.5], y: [-0.2, 0.2], z: [-0.05, 0.05] },
    drive: D(20, 1600, 24, 1.5),
  },
  shinL: { parent: "thighL", pp: [0, -0.215, 0], ps: [0, 0.205, 0], shape: () => ({ kind: "capsule", a: [0, 0.15, 0], b: [0, -0.15, 0], r: 0.055 }), mass: 3.6, limits: mirrorLimits({ x: [-0.04, 2.5], y: [-0.2, 0.2], z: [-0.05, 0.05] }), drive: D(20, 1600, 24, 1.5) },
  footR: {
    parent: "shinR",
    pp: [0, -0.205, 0],
    ps: [0, 0.075, -0.055],
    shape: () => ({ kind: "box", c: [0, 0, 0], half: [0.052, 0.04, 0.125] }),
    mass: 1.1,
    limits: { x: [-0.6, 0.8], y: [-0.25, 0.25], z: [-0.25, 0.25] },
    drive: D(22, 2400, 24, 1.5),
  },
  footL: { parent: "shinL", pp: [0, -0.205, 0], ps: [0, 0.075, -0.055], shape: () => ({ kind: "box", c: [0, 0, 0], half: [0.052, 0.04, 0.125] }), mass: 1.1, limits: mirrorLimits({ x: [-0.6, 0.8], y: [-0.25, 0.25], z: [-0.25, 0.25] }), drive: D(22, 2400, 24, 1.5) },
};

/** Standing pelvis height (origin) in base units. */
const BASE_PELVIS_H = 1.02;

function scaleV(v: V3, s: number): V3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}
function scaleShape(sh: ShapeSpec, s: number, g: number): ShapeSpec {
  const sv = (v: V3): V3 => [v[0] * s * g, v[1] * s, v[2] * s * g];
  switch (sh.kind) {
    case "capsule":
      return { kind: "capsule", a: sv(sh.a), b: sv(sh.b), r: sh.r * s * g };
    case "box":
      return { kind: "box", c: sv(sh.c), half: sv(sh.half) };
    case "sphere":
      return { kind: "sphere", c: sv(sh.c), r: sh.r * s * Math.sqrt(g) };
  }
}
function inertiaFor(sh: ShapeSpec, m: number): V3 {
  switch (sh.kind) {
    case "box": {
      const [hx, hy, hz] = sh.half;
      const w = hx * 2,
        h = hy * 2,
        d = hz * 2;
      return [(m / 12) * (h * h + d * d), (m / 12) * (w * w + d * d), (m / 12) * (w * w + h * h)];
    }
    case "sphere": {
      const i = 0.4 * m * sh.r * sh.r;
      return [i, i, i];
    }
    case "capsule": {
      const len = Math.hypot(sh.b[0] - sh.a[0], sh.b[1] - sh.a[1], sh.b[2] - sh.a[2]) + 2 * sh.r;
      // approximate as cylinder of full length
      const iy = 0.5 * m * sh.r * sh.r;
      const ixz = (m / 12) * (3 * sh.r * sh.r + len * len);
      return [ixz, iy, ixz];
    }
  }
}
function lengthRadius(sh: ShapeSpec): { length: number; radius: number } {
  switch (sh.kind) {
    case "capsule":
      return { length: Math.hypot(sh.b[0] - sh.a[0], sh.b[1] - sh.a[1], sh.b[2] - sh.a[2]) + 2 * sh.r, radius: sh.r };
    case "box":
      return { length: sh.half[1] * 2, radius: Math.max(sh.half[0], sh.half[2]) };
    case "sphere":
      return { length: sh.r * 2, radius: sh.r };
  }
}

export function buildRigSpec(height = 1, girth = 1, totalMass = 80): RigSpec {
  const s = height;
  const g = girth;
  // First pass: scaled specs without masses so we can normalise to totalMass.
  const baseMassSum = RIG_BODIES.reduce((a, n) => a + BASE[n].mass, 0);
  const massScale = totalMass / baseMassSum;
  const bodies: BodySpec[] = [];
  const byName = {} as Record<RigBody, BodySpec>;
  const centers: Record<string, [number, number, number]> = {};
  const pelvisH = BASE_PELVIS_H * s;
  for (const name of RIG_BODIES) {
    const b = BASE[name];
    const shape = scaleShape(b.shape(s, g), s, g);
    const mass = b.mass * massScale;
    const pp: V3 = [b.pp[0] * s * g, b.pp[1] * s, b.pp[2] * s * g];
    const ps: V3 = [b.ps[0] * s * g, b.ps[1] * s, b.ps[2] * s * g];
    let center: [number, number, number];
    if (b.parent === null) center = [0, pelvisH, 0];
    else {
      const pc = centers[b.parent];
      center = [pc[0] + pp[0] - ps[0], pc[1] + pp[1] - ps[1], pc[2] + pp[2] - ps[2]];
    }
    centers[name] = center;
    const lr = lengthRadius(shape);
    const spec: BodySpec = {
      name,
      parent: b.parent,
      pivotParent: pp,
      pivotSelf: ps,
      shape,
      mass,
      inertia: inertiaFor(shape, mass),
      limits: b.limits,
      drive: b.drive,
      restCenter: center,
      restJoint: [center[0] + ps[0], center[1] + ps[1], center[2] + ps[2]],
      length: lr.length,
      radius: lr.radius,
    };
    bodies.push(spec);
    byName[name] = spec;
  }
  return {
    height: s,
    girth: g,
    totalMass,
    pelvisHeight: pelvisH,
    bodies,
    byName,
    face: {
      nose: { c: scaleV([0, 0.0, 0.105], s), r: 0.036 * s },
      eyeL: { c: scaleV([-0.045, 0.06, 0.092], s), r: 0.03 * s },
      eyeR: { c: scaleV([0.045, 0.06, 0.092], s), r: 0.03 * s },
    },
    gripAnchor: scaleV([0, -0.02, 0.04], s),
    strikePoint: scaleV([0, -0.075, 0.02], s),
    capsule: { height: 1.55 * s, radius: 0.3 * s * Math.sqrt(g) },
    shoulderHalfWidth: 0.205 * s * g,
  };
}

export { RIG_PARENT, mirrorName, neg };

/**
 * Hidden animation-target data. Poses are authored for the RIGHT side where it matters and mirrored
 * automatically for the left. Angles are DEGREES [rx, ry, rz] in each joint's rest frame:
 *   rx: pitch  (arm/leg: negative = raise forward; shin: positive = knee bend; torso: positive = lean forward)
 *   ry: twist  (torso: negative turns the RIGHT shoulder forward)
 *   rz: roll   (right arm: positive = out to the side; torso: positive = lean left)
 * Times are seconds from the start of the move. Hit window = [windup, windup + active].
 */
import type { RigBody } from "./regions.js";
import type { MoveKind } from "../sim/events.js";

export type JointPose = Partial<Record<RigBody, readonly [number, number?, number?]>>;
export interface RootKey {
  /** Forward lean of the whole body in degrees. */
  lean?: number;
  /** Extra torso twist in degrees (negative = right shoulder forward). */
  twist?: number;
  /** Sideways lean (rz) in degrees, positive = lean to the left. */
  side?: number;
  /** Crouch: pelvis lowered in metres. */
  drop?: number;
  /** Pelvis shifted forward in the facing frame (metres). */
  fwd?: number;
  /** Yaw of the whole pelvis relative to facing in degrees. */
  yaw?: number;
}
export interface Key {
  t: number;
  j?: JointPose;
  r?: RootKey;
}
export type StrikeBody = "handR" | "handL" | "footR" | "footL" | "shoulderR" | "shoulderL" | "weapon" | "both" | "head";

export interface MoveDef {
  id: string;
  kind: MoveKind;
  /** Which side the authored (right-hand) keys are for; "L" mirrors them. */
  side: "R" | "L" | "both";
  windup: number;
  active: number;
  recovery: number;
  keys: Key[];
  strike: StrikeBody;
  radius: number;
  /** Cost and effect tuning */
  stamina: number;
  /** Effective mass fraction of the fighter's mass behind the blow. */
  massFrac: number;
  /** Nominal strike speed (m/s) used as a floor for the impulse calc. */
  speed: number;
  /** Impulse multiplier. */
  power: number;
  balanceDmg: number;
  knockback: number;
  /** Forward lunge velocity during the active window (m/s). */
  lunge: number;
  /** Can be held to charge (heavy). */
  chargeable?: boolean;
  /** Hits that may chain to this move id when light is pressed in the chain window. */
  chain?: string;
  /** Grants brief turning control while winding up. */
  turn: number;
  /** Legs animated by FK in this move (disable IK for them). */
  fkLegs?: "R" | "L" | "both";
  /** Height emphasis deltas (degrees) applied at the strike per unit of height (+1 high, -1 low). */
  heightMod?: JointPose;
  heightRoot?: RootKey;
  /** Blocks movement during the move? multiplier on walk speed. */
  moveMult: number;
  /** Tags. */
  tags?: string[];
}

const k = (t: number, j?: JointPose, r?: RootKey): Key => ({ t, j, r });

export const MOVES: Record<string, MoveDef> = {
  jab: {
    id: "jab", kind: "jab", side: "R", windup: 0.11, active: 0.09, recovery: 0.2, strike: "handR", radius: 0.075,
    stamina: 6, massFrac: 0.07, speed: 5.5, power: 1.0, balanceDmg: 7, knockback: 0.8, lunge: 1.2, chain: "cross", turn: 0.7, moveMult: 0.45,
    keys: [
      k(0.0),
      k(0.11, { upperArmR: [-40, 8, 10], forearmR: [-125, 0, 0], handR: [10, 0, 0], chest: [4, 10, 0], spine: [2, 6, 0] }, { lean: 4, twist: 6 }),
      k(0.2, { upperArmR: [-88, -5, 4], forearmR: [-5, 0, 0], handR: [0, 0, 0], chest: [8, -20, 0], spine: [4, -10, 0], head: [-6, 0, 0] }, { lean: 8, twist: -14, fwd: 0.12 }),
      k(0.3, { upperArmR: [-85, -5, 4], forearmR: [-8, 0, 0], handR: [0, 0, 0], chest: [8, -18, 0], spine: [4, -8, 0] }, { lean: 7, twist: -12, fwd: 0.1 }),
      k(0.4),
    ],
    heightMod: { upperArmR: [-14, 0, 0] }, heightRoot: { lean: -3 },
  },
  cross: {
    id: "cross", kind: "cross", side: "L", windup: 0.12, active: 0.09, recovery: 0.22, strike: "handL", radius: 0.08,
    stamina: 8, massFrac: 0.1, speed: 6.2, power: 1.15, balanceDmg: 9, knockback: 1.1, lunge: 1.4, chain: "hook", turn: 0.7, moveMult: 0.4,
    keys: [
      k(0.0),
      k(0.12, { upperArmR: [-40, 8, 10], forearmR: [-125, 0, 0], chest: [4, 14, 0], spine: [2, 8, 0], thighR: [4, 0, 0] }, { lean: 5, twist: 10, drop: 0.03 }),
      k(0.21, { upperArmR: [-90, -6, 2], forearmR: [-4, 0, 0], handR: [0, 0, 0], chest: [10, -32, 0], spine: [4, -16, 0], head: [-8, 0, 0] }, { lean: 11, twist: -26, fwd: 0.18 }),
      k(0.32, { upperArmR: [-86, -6, 2], forearmR: [-8, 0, 0], chest: [10, -28, 0], spine: [4, -14, 0] }, { lean: 10, twist: -22, fwd: 0.16 }),
      k(0.43),
    ],
    heightMod: { upperArmR: [-14, 0, 0] }, heightRoot: { lean: -3 },
  },
  hook: {
    id: "hook", kind: "hook", side: "R", windup: 0.15, active: 0.1, recovery: 0.3, strike: "handR", radius: 0.09,
    stamina: 10, massFrac: 0.13, speed: 6.5, power: 1.35, balanceDmg: 12, knockback: 1.6, lunge: 1.8, turn: 0.5, moveMult: 0.3,
    keys: [
      k(0.0),
      k(0.15, { upperArmR: [-10, 25, 80], forearmR: [-95, 0, 0], handR: [0, 0, 0], chest: [4, 34, 6], spine: [2, 16, 0] }, { lean: 6, twist: 24, drop: 0.05 }),
      k(0.25, { upperArmR: [-70, -55, 78], forearmR: [-85, 0, 0], handR: [0, 0, 0], chest: [8, -48, -6], spine: [4, -24, 0], head: [-4, -10, 0] }, { lean: 9, twist: -40, fwd: 0.2 }),
      k(0.36, { upperArmR: [-68, -50, 74], forearmR: [-85, 0, 0], chest: [8, -44, -6], spine: [4, -22, 0] }, { lean: 9, twist: -36, fwd: 0.18 }),
      k(0.55),
    ],
    heightMod: { upperArmR: [-20, 0, 0] },
  },
  heavy: {
    id: "heavy", kind: "heavy", side: "R", windup: 0.34, active: 0.12, recovery: 0.5, strike: "handR", radius: 0.1,
    stamina: 20, massFrac: 0.1, speed: 8.0, power: 1.8, balanceDmg: 26, knockback: 3.2, lunge: 2.6, chargeable: true, turn: 0.4, moveMult: 0.2,
    keys: [
      k(0.0),
      k(0.34, { upperArmR: [-170, 5, 20], forearmR: [-60, 0, 0], handR: [0, 0, 0], chest: [-8, 40, 8], spine: [-4, 22, 0], head: [-8, 0, 0] }, { lean: -8, twist: 32, drop: 0.08, fwd: -0.1 }),
      k(0.46, { upperArmR: [-75, -20, 6], forearmR: [-8, 0, 0], handR: [0, 0, 0], chest: [20, -48, -4], spine: [10, -24, 0], head: [10, -10, 0] }, { lean: 22, twist: -42, drop: 0.1, fwd: 0.3 }),
      k(0.6, { upperArmR: [-70, -22, 6], forearmR: [-12, 0, 0], chest: [22, -44, -4], spine: [10, -22, 0] }, { lean: 24, twist: -40, drop: 0.1, fwd: 0.28 }),
      k(0.96),
    ],
    heightMod: { upperArmR: [-26, 0, 0] }, heightRoot: { lean: -6 },
  },
  kick: {
    id: "kick", kind: "kick", side: "R", windup: 0.16, active: 0.11, recovery: 0.34, strike: "footR", radius: 0.1,
    stamina: 12, massFrac: 0.12, speed: 6.8, power: 1.45, balanceDmg: 18, knockback: 2.4, lunge: 1.0, turn: 0.4, fkLegs: "R", moveMult: 0.25,
    keys: [
      k(0.0),
      k(0.16, { thighR: [-55, 0, 6], shinR: [105, 0, 0], footR: [20, 0, 0], chest: [-6, 0, 0], spine: [-4, 0, 0], upperArmL: [-60, 0, 14], forearmL: [-95, 0, 0], upperArmR: [-35, 0, 8], forearmR: [-100, 0, 0] }, { lean: -6, drop: 0.02 }),
      k(0.27, { thighR: [-92, 0, 4], shinR: [8, 0, 0], footR: [-8, 0, 0], chest: [-14, 0, 0], spine: [-8, 0, 0], upperArmL: [-70, 0, 30], forearmL: [-60, 0, 0], upperArmR: [-30, 0, 20] }, { lean: -14, fwd: 0.1 }),
      k(0.38, { thighR: [-88, 0, 4], shinR: [12, 0, 0], footR: [-6, 0, 0], chest: [-12, 0, 0], upperArmL: [-70, 0, 30] }, { lean: -12, fwd: 0.08 }),
      k(0.5),
    ],
    heightMod: { thighR: [-22, 0, 0] }, heightRoot: { lean: -8 },
  },
  shove: {
    id: "shove", kind: "shove", side: "both", windup: 0.1, active: 0.1, recovery: 0.3, strike: "both", radius: 0.16,
    stamina: 9, massFrac: 0.28, speed: 3.6, power: 0.3, balanceDmg: 34, knockback: 4.2, lunge: 1.6, turn: 0.5, moveMult: 0.3,
    keys: [
      k(0.0),
      k(0.1, { upperArmR: [-60, 0, 10], forearmR: [-120, 0, 0], upperArmL: [-60, 0, -10], forearmL: [-120, 0, 0], chest: [4, 0, 0] }, { lean: 4, drop: 0.05 }),
      k(0.2, { upperArmR: [-88, -6, 6], forearmR: [-10, 0, 0], upperArmL: [-88, 6, -6], forearmL: [-10, 0, 0], chest: [14, 0, 0], spine: [6, 0, 0] }, { lean: 16, drop: 0.07, fwd: 0.22 }),
      k(0.3, { upperArmR: [-86, -6, 6], forearmR: [-14, 0, 0], upperArmL: [-86, 6, -6], forearmL: [-14, 0, 0], chest: [14, 0, 0] }, { lean: 14, fwd: 0.2, drop: 0.07 }),
      k(0.5),
    ],
  },
  shoulder: {
    id: "shoulder", kind: "shoulder", side: "R", windup: 0.12, active: 0.22, recovery: 0.5, strike: "shoulderR", radius: 0.2,
    stamina: 16, massFrac: 0.25, speed: 4.2, power: 1.25, balanceDmg: 48, knockback: 5.0, lunge: 4.2, turn: 0.1, moveMult: 1.0,
    keys: [
      k(0.0),
      k(0.12, { upperArmR: [-20, 20, 30], forearmR: [-70, 0, 0], upperArmL: [-40, 0, -10], forearmL: [-100, 0, 0], chest: [10, 20, 0] }, { lean: 14, twist: 18, drop: 0.1 }),
      k(0.34, { upperArmR: [-30, -20, 14], forearmR: [-85, 0, 0], upperArmL: [-40, 0, -14], forearmL: [-100, 0, 0], chest: [22, -46, -4], spine: [10, -20, 0] }, { lean: 28, twist: -50, drop: 0.12, fwd: 0.25 }),
      k(0.56),
    ],
  },
  // --- weapon swings (right main hand, optionally off hand follows). Poses are generic; props decide damage.
  swingClub: {
    id: "swingClub", kind: "weapon", side: "R", windup: 0.2, active: 0.16, recovery: 0.34, strike: "weapon", radius: 0.07,
    stamina: 9, massFrac: 0.1, speed: 9, power: 1.0, balanceDmg: 14, knockback: 1.8, lunge: 1.4, turn: 0.5, moveMult: 0.3,
    keys: [
      k(0.0),
      k(0.2, { upperArmR: [-40, 10, 60], forearmR: [-80, 0, 0], handR: [-20, 0, 0], chest: [0, 46, 4], spine: [0, 22, 0] }, { lean: 0, twist: 34, drop: 0.04 }),
      k(0.36, { upperArmR: [-80, -20, 54], forearmR: [-20, 0, 0], handR: [10, 0, 0], chest: [10, -52, -4], spine: [4, -26, 0] }, { lean: 10, twist: -44, drop: 0.06, fwd: 0.2 }),
      k(0.5, { upperArmR: [-70, -20, 50], forearmR: [-30, 0, 0], chest: [10, -46, -4] }, { lean: 8, twist: -38, fwd: 0.16 }),
      k(0.7),
    ],
  },
  swingOverhead: {
    id: "swingOverhead", kind: "weapon", side: "R", windup: 0.32, active: 0.14, recovery: 0.5, strike: "weapon", radius: 0.09,
    stamina: 16, massFrac: 0.18, speed: 8, power: 1.3, balanceDmg: 22, knockback: 2.4, lunge: 1.8, turn: 0.4, moveMult: 0.2, chargeable: true,
    keys: [
      k(0.0),
      k(0.32, { upperArmR: [-165, 4, 14], upperArmL: [-165, -4, -14], forearmR: [-55, 0, 0], forearmL: [-55, 0, 0], handR: [-30, 0, 0], handL: [-30, 0, 0], chest: [-12, 0, 0], spine: [-6, 0, 0] }, { lean: -10, drop: 0.04, fwd: -0.08 }),
      k(0.46, { upperArmR: [-62, 0, 8], upperArmL: [-62, 0, -8], forearmR: [-18, 0, 0], forearmL: [-18, 0, 0], handR: [18, 0, 0], handL: [18, 0, 0], chest: [26, 0, 0], spine: [12, 0, 0] }, { lean: 26, drop: 0.12, fwd: 0.26 }),
      k(0.6, { upperArmR: [-58, 0, 8], upperArmL: [-58, 0, -8], forearmR: [-22, 0, 0], forearmL: [-22, 0, 0], chest: [26, 0, 0] }, { lean: 24, drop: 0.12, fwd: 0.24 }),
      k(0.96),
    ],
  },
  thrust: {
    id: "thrust", kind: "weapon", side: "R", windup: 0.22, active: 0.14, recovery: 0.36, strike: "weapon", radius: 0.06,
    stamina: 8, massFrac: 0.09, speed: 7.5, power: 0.95, balanceDmg: 12, knockback: 2.4, lunge: 2.0, turn: 0.6, moveMult: 0.3,
    keys: [
      k(0.0),
      k(0.22, { upperArmR: [-30, 10, 18], upperArmL: [-40, -10, -20], forearmR: [-120, 0, 0], forearmL: [-110, 0, 0], chest: [0, 22, 0] }, { lean: 2, twist: 16, drop: 0.06, fwd: -0.1 }),
      k(0.36, { upperArmR: [-86, -4, 10], upperArmL: [-84, 4, -16], forearmR: [-8, 0, 0], forearmL: [-10, 0, 0], chest: [10, -26, 0] }, { lean: 14, twist: -20, drop: 0.08, fwd: 0.26 }),
      k(0.5, { upperArmR: [-84, -4, 10], upperArmL: [-84, 4, -16], forearmR: [-12, 0, 0], forearmL: [-12, 0, 0] }, { lean: 12, twist: -18, fwd: 0.22 }),
      k(0.72),
    ],
  },
  bashShield: {
    id: "bashShield", kind: "weapon", side: "R", windup: 0.14, active: 0.12, recovery: 0.34, strike: "weapon", radius: 0.2,
    stamina: 8, massFrac: 0.16, speed: 5, power: 0.9, balanceDmg: 30, knockback: 3.4, lunge: 2.0, turn: 0.5, moveMult: 0.4,
    keys: [
      k(0.0),
      k(0.14, { upperArmR: [-50, 0, 18], forearmR: [-120, 0, 0], handR: [0, 0, 0], chest: [0, 14, 0] }, { lean: 2, drop: 0.05, twist: 10 }),
      k(0.26, { upperArmR: [-84, -8, 12], forearmR: [-30, 0, 0], handR: [0, 0, 0], chest: [10, -20, 0] }, { lean: 12, drop: 0.07, fwd: 0.2, twist: -14 }),
      k(0.4),
    ],
  },
  grappleKnee: {
    id: "grappleKnee", kind: "grappleStrike", side: "R", windup: 0.12, active: 0.1, recovery: 0.28, strike: "footR", radius: 0.14,
    stamina: 12, massFrac: 0.12, speed: 4.2, power: 1.2, balanceDmg: 22, knockback: 0.5, lunge: 0.0, turn: 0.2, fkLegs: "R", moveMult: 0.1,
    keys: [
      k(0.0),
      k(0.12, { thighR: [-20, 0, 0], shinR: [40, 0, 0], upperArmR: [-70, 0, 8], upperArmL: [-70, 0, -8], forearmR: [-60, 0, 0], forearmL: [-60, 0, 0] }, { lean: 4 }),
      k(0.22, { thighR: [-100, 0, 4], shinR: [95, 0, 0], footR: [20, 0, 0], upperArmR: [-70, 0, 8], upperArmL: [-70, 0, -8], forearmR: [-60, 0, 0], forearmL: [-60, 0, 0], chest: [20, 0, 0], head: [10, 0, 0] }, { lean: 14 }),
      k(0.4),
    ],
  },
  grappleHead: {
    id: "grappleHead", kind: "grappleStrike", side: "R", windup: 0.14, active: 0.1, recovery: 0.3, strike: "head", radius: 0.12,
    stamina: 10, massFrac: 0.08, speed: 3.6, power: 1.1, balanceDmg: 12, knockback: 0.3, lunge: 0.0, turn: 0.2, moveMult: 0.1,
    keys: [
      k(0.0),
      k(0.14, { head: [-30, 0, 0], chest: [-6, 0, 0], upperArmR: [-70, 0, 8], upperArmL: [-70, 0, -8], forearmR: [-60, 0, 0], forearmL: [-60, 0, 0] }, { lean: -6 }),
      k(0.24, { head: [32, 0, 0], chest: [16, 0, 0], upperArmR: [-70, 0, 8], upperArmL: [-70, 0, -8], forearmR: [-60, 0, 0], forearmL: [-60, 0, 0] }, { lean: 14, fwd: 0.06 }),
      k(0.44),
    ],
  },
};

/** Non-attack pose snippets (key poses, evaluated by name). Right-hand authored; mirror as needed. */
export const POSES: Record<string, { j: JointPose; r?: RootKey }> = {
  // stances
  stanceHeavy: { j: { upperArmR: [-14, 0, 14], upperArmL: [-14, 0, -14], forearmR: [-58, 0, 0], forearmL: [-58, 0, 0], handR: [0, 0, 0], handL: [0, 0, 0], chest: [4, 0, 0], head: [-2, 0, 0], spine: [2, 0, 0] }, r: { lean: 4, drop: 0.06 } },
  stanceBouncy: { j: { upperArmR: [-38, 0, 8], upperArmL: [-40, 0, -8], forearmR: [-108, 0, 0], forearmL: [-110, 0, 0], handR: [0, 0, 0], handL: [0, 0, 0], chest: [3, 0, 0], spine: [2, 0, 0], head: [-3, 0, 0] }, r: { lean: 3, drop: 0.05 } },
  guardFists: { j: { upperArmR: [-52, 0, 4], upperArmL: [-54, 0, -4], forearmR: [-122, 0, 0], forearmL: [-124, 0, 0], handR: [0, 0, 0], handL: [0, 0, 0], chest: [10, 0, 0], spine: [4, 0, 0], head: [8, 0, 0] }, r: { lean: 10, drop: 0.09 } },
  guardShield: { j: { upperArmL: [-70, 0, -10], forearmL: [-90, 0, 0], upperArmR: [-50, 0, 6], forearmR: [-120, 0, 0], chest: [8, 0, 0] }, r: { lean: 8, drop: 0.09 } },
  // carrying poses (main hand = right)
  carry1H: { j: { upperArmR: [-30, 8, 14], forearmR: [-92, 0, 0], handR: [-6, 0, 0] } },
  carry2H: { j: { upperArmR: [-42, 6, 10], upperArmL: [-40, -6, -10], forearmR: [-95, 0, 0], forearmL: [-95, 0, 0], handR: [-6, 0, 0], handL: [-6, 0, 0] } },
  carryHeavy: { j: { upperArmR: [-30, 0, 8], upperArmL: [-30, 0, -8], forearmR: [-70, 0, 0], forearmL: [-70, 0, 0], chest: [14, 0, 0], spine: [6, 0, 0] }, r: { lean: 12, drop: 0.08 } },
  // reaching to pick up (bend)
  reachDown: { j: { upperArmR: [-55, 0, 6], forearmR: [-30, 0, 0], upperArmL: [-30, 0, -6], forearmL: [-40, 0, 0], chest: [42, 0, 0], spine: [20, 0, 0], head: [-26, 0, 0] }, r: { lean: 24, drop: 0.28, fwd: 0.1 } },
  // throws
  throwWind: { j: { upperArmR: [-150, 0, 25], forearmR: [-95, 0, 0], handR: [-20, 0, 0], upperArmL: [-60, 0, -20], forearmL: [-60, 0, 0], chest: [-10, 32, 6], spine: [-4, 16, 0] }, r: { lean: -8, twist: 22, drop: 0.05 } },
  throwRelease: { j: { upperArmR: [-70, -10, 8], forearmR: [-10, 0, 0], handR: [20, 0, 0], upperArmL: [-40, 0, -34], forearmL: [-40, 0, 0], chest: [20, -40, -4], spine: [8, -20, 0] }, r: { lean: 20, twist: -34, fwd: 0.2, drop: 0.06 } },
  // grapple (holder)
  holdFighter: { j: { upperArmR: [-62, 4, 6], upperArmL: [-62, -4, -6], forearmR: [-72, 0, 0], forearmL: [-72, 0, 0], handR: [0, 0, 0], handL: [0, 0, 0], chest: [8, 0, 0] }, r: { lean: 8, drop: 0.08 } },
  throwFighterWind: { j: { upperArmR: [-120, 10, 24], upperArmL: [-120, -10, -24], forearmR: [-50, 0, 0], forearmL: [-50, 0, 0], chest: [-14, 24, 0], spine: [-8, 12, 0] }, r: { lean: -14, twist: 20, drop: 0.12 } },
  throwFighterRelease: { j: { upperArmR: [-70, -6, 8], upperArmL: [-70, 6, -8], forearmR: [-12, 0, 0], forearmL: [-12, 0, 0], chest: [26, -26, 0], spine: [12, -12, 0] }, r: { lean: 26, twist: -22, fwd: 0.3, drop: 0.1 } },
  // grabbed (being held): arms flail up
  grabbed: { j: { upperArmR: [-40, 0, 50], upperArmL: [-40, 0, -50], forearmR: [-60, 0, 0], forearmL: [-60, 0, 0], head: [10, 0, 0], chest: [-4, 0, 0] }, r: { lean: -4 } },
  // taunts
  tauntFlex: { j: { upperArmR: [-20, 0, 78], upperArmL: [-20, 0, -78], forearmR: [-125, 0, 0], forearmL: [-125, 0, 0], handR: [0, 0, 0], handL: [0, 0, 0], chest: [-6, 0, 0], head: [-10, 0, 0] }, r: { lean: -6, drop: 0.02 } },
  tauntFlair: { j: { upperArmR: [-170, 0, 40], upperArmL: [-30, 0, -50], forearmR: [-20, 0, 0], forearmL: [-100, 0, 0], handR: [0, 0, 20], chest: [-4, 0, 8], head: [-8, 0, 14] }, r: { lean: -4, side: 10, drop: 0.0 } },
  // injuries
  armHang: { j: { upperArmR: [4, 0, 8], forearmR: [-6, 0, 0], handR: [8, 0, 0] } },
  armCradle: { j: { upperArmR: [-18, 0, 4], forearmR: [-98, 0, 0], handR: [6, 0, 0] } },
  ribsClutch: { j: { upperArmR: [-30, 0, 4], forearmR: [-110, 0, 0], upperArmL: [-26, 0, -4], forearmL: [-110, 0, 0], chest: [20, 0, 6], spine: [14, 0, 0], head: [10, 0, 0] }, r: { lean: 20, drop: 0.12 } },
  dazed: { j: { upperArmR: [-8, 0, 12], upperArmL: [-8, 0, -12], forearmR: [-30, 0, 0], forearmL: [-30, 0, 0], head: [14, 0, 6], chest: [6, 0, 4] }, r: { lean: 6, drop: 0.04 } },
  // stagger flail (additive-ish full pose)
  stagger: { j: { upperArmR: [-14, 0, 44], upperArmL: [-10, 0, -44], forearmR: [-30, 0, 0], forearmL: [-30, 0, 0], chest: [-14, 0, 0], spine: [-6, 0, 0], head: [-12, 0, 0] }, r: { lean: -12, drop: 0.07 } },
  // celebrations
  celebrateA: { j: { upperArmR: [-168, 0, 20], upperArmL: [-168, 0, -20], forearmR: [-12, 0, 0], forearmL: [-12, 0, 0], chest: [-8, 0, 0], head: [-14, 0, 0] }, r: { lean: -8 } },
  celebrateB: { j: { upperArmR: [-140, 0, 56], upperArmL: [-30, 0, -50], forearmR: [-40, 0, 0], forearmL: [-120, 0, 0], handR: [0, 0, 0], chest: [-6, 0, 12], head: [-12, 0, 12] }, r: { lean: -6, side: 14 } },
  // crawl
  crawl: { j: { upperArmR: [-70, 0, 16], upperArmL: [-70, 0, -16], forearmR: [-20, 0, 0], forearmL: [-20, 0, 0], chest: [64, 0, 0], spine: [30, 0, 0], head: [-50, 0, 0] }, r: { lean: 70, drop: 0.55 } },
};

export interface GetUpDef {
  id: "supine" | "prone" | "side" | "furniture" | "roll";
  duration: number;
  /** Key poses over time; pelvis height fraction (0 = lying, 1 = standing) at each key. */
  keys: { t: number; h: number; j: JointPose; r?: RootKey }[];
}
export const GETUPS: Record<string, GetUpDef> = {
  supine: {
    id: "supine", duration: 1.35,
    keys: [
      { t: 0.0, h: 0.0, j: { upperArmR: [-20, 0, 40], upperArmL: [-20, 0, -40], thighR: [-60, 0, 0], thighL: [-60, 0, 0], shinR: [100, 0, 0], shinL: [100, 0, 0] } },
      { t: 0.45, h: 0.2, j: { upperArmR: [-30, 0, 20], upperArmL: [-30, 0, -20], forearmR: [-40, 0, 0], forearmL: [-40, 0, 0], chest: [50, 0, 0], thighR: [-80, 0, 0], thighL: [-70, 0, 0], shinR: [120, 0, 0], shinL: [120, 0, 0] }, r: { lean: 50 } },
      { t: 0.9, h: 0.6, j: { chest: [30, 0, 0], thighR: [-55, 0, 0], thighL: [-30, 0, 0], shinR: [90, 0, 0], shinL: [60, 0, 0], upperArmR: [-40, 0, 10], upperArmL: [-40, 0, -10] }, r: { lean: 30, drop: 0.25 } },
      { t: 1.35, h: 1.0, j: {}, r: { lean: 0, drop: 0.06 } },
    ],
  },
  prone: {
    id: "prone", duration: 1.5,
    keys: [
      { t: 0.0, h: 0.0, j: { upperArmR: [-20, 0, 60], upperArmL: [-20, 0, -60] } },
      { t: 0.5, h: 0.22, j: { upperArmR: [-90, 0, 14], upperArmL: [-90, 0, -14], forearmR: [-12, 0, 0], forearmL: [-12, 0, 0], chest: [-14, 0, 0], thighR: [-80, 0, 0], thighL: [-30, 0, 0], shinR: [110, 0, 0], shinL: [60, 0, 0] }, r: { lean: 70 } },
      { t: 1.0, h: 0.55, j: { upperArmR: [-70, 0, 14], upperArmL: [-70, 0, -14], forearmR: [-30, 0, 0], forearmL: [-30, 0, 0], chest: [40, 0, 0], thighR: [-60, 0, 0], thighL: [-40, 0, 0], shinR: [90, 0, 0], shinL: [70, 0, 0] }, r: { lean: 50, drop: 0.3 } },
      { t: 1.5, h: 1.0, j: {}, r: { lean: 0, drop: 0.06 } },
    ],
  },
  side: {
    id: "side", duration: 1.4,
    keys: [
      { t: 0.0, h: 0.0, j: { upperArmR: [-20, 0, 40], upperArmL: [-20, 0, -40] } },
      { t: 0.5, h: 0.25, j: { upperArmR: [-60, 0, 30], upperArmL: [-30, 0, -20], chest: [30, 0, 0], thighR: [-70, 0, 0], shinR: [100, 0, 0] }, r: { lean: 40, side: 15 } },
      { t: 0.95, h: 0.6, j: { chest: [28, 0, 0], thighR: [-50, 0, 0], shinR: [80, 0, 0] }, r: { lean: 30, drop: 0.25 } },
      { t: 1.4, h: 1.0, j: {}, r: { drop: 0.06 } },
    ],
  },
  furniture: {
    id: "furniture", duration: 1.9,
    keys: [
      { t: 0.0, h: 0.0, j: { upperArmR: [-60, 0, 30], upperArmL: [-60, 0, -30], forearmR: [-30, 0, 0], forearmL: [-30, 0, 0] } },
      { t: 0.7, h: 0.3, j: { upperArmR: [-110, 0, 20], upperArmL: [-110, 0, -20], forearmR: [-20, 0, 0], forearmL: [-20, 0, 0], chest: [30, 0, 0], thighR: [-80, 0, 0], shinR: [110, 0, 0] }, r: { lean: 40 } },
      { t: 1.3, h: 0.7, j: { upperArmR: [-90, 0, 14], upperArmL: [-90, 0, -14], forearmR: [-30, 0, 0], forearmL: [-30, 0, 0], chest: [34, 0, 0] }, r: { lean: 34, drop: 0.2 } },
      { t: 1.9, h: 1.0, j: {}, r: { drop: 0.06 } },
    ],
  },
  roll: {
    id: "roll", duration: 0.75,
    keys: [
      { t: 0.0, h: 0.0, j: { upperArmR: [-50, 0, 20], upperArmL: [-50, 0, -20] } },
      { t: 0.35, h: 0.35, j: { chest: [60, 0, 0], thighR: [-90, 0, 0], thighL: [-90, 0, 0], shinR: [130, 0, 0], shinL: [130, 0, 0], upperArmR: [-70, 0, 10], upperArmL: [-70, 0, -10] }, r: { lean: 60, drop: 0.4 } },
      { t: 0.75, h: 1.0, j: {}, r: { drop: 0.1 } },
    ],
  },
};

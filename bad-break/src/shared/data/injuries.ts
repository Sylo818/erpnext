/**
 * Tunable injury rules. Fictional gameplay rules, not medical simulation.
 * Impulse units are N*s of effective contact impulse after guard reduction.
 */
import type { BodyRegion } from "./regions.js";

export interface RegionTuning {
  /** Contact impulse that must be exceeded before bone integrity is lost. */
  boneThreshold: number;
  /** Bone integrity (0..100) lost per N*s above the threshold. */
  boneScale: number;
  /** Soft-tissue / bruise damage (0..100) per N*s (any contact). */
  softScale: number;
  /** Multiplier for vitality loss. */
  vitality: number;
  /** Limb root regions that can come off. */
  detachable: boolean;
}

export const REGION_TUNING: Record<BodyRegion, RegionTuning> = {
  head: { boneThreshold: 34, boneScale: 0.55, softScale: 0.55, vitality: 1.5, detachable: false },
  neck: { boneThreshold: 30, boneScale: 0.7, softScale: 0.5, vitality: 1.8, detachable: false },
  chest: { boneThreshold: 36, boneScale: 0.45, softScale: 0.4, vitality: 1.0, detachable: false },
  abdomen: { boneThreshold: 34, boneScale: 0.5, softScale: 0.45, vitality: 1.1, detachable: false },
  pelvis: { boneThreshold: 40, boneScale: 0.45, softScale: 0.35, vitality: 0.9, detachable: false },
  upperArmL: { boneThreshold: 24, boneScale: 0.8, softScale: 0.5, vitality: 0.55, detachable: true },
  upperArmR: { boneThreshold: 24, boneScale: 0.8, softScale: 0.5, vitality: 0.55, detachable: true },
  forearmL: { boneThreshold: 20, boneScale: 0.95, softScale: 0.5, vitality: 0.45, detachable: true },
  forearmR: { boneThreshold: 20, boneScale: 0.95, softScale: 0.5, vitality: 0.45, detachable: true },
  handL: { boneThreshold: 16, boneScale: 1.1, softScale: 0.55, vitality: 0.35, detachable: false },
  handR: { boneThreshold: 16, boneScale: 1.1, softScale: 0.55, vitality: 0.35, detachable: false },
  thighL: { boneThreshold: 30, boneScale: 0.65, softScale: 0.45, vitality: 0.6, detachable: true },
  thighR: { boneThreshold: 30, boneScale: 0.65, softScale: 0.45, vitality: 0.6, detachable: true },
  shinL: { boneThreshold: 22, boneScale: 0.9, softScale: 0.5, vitality: 0.5, detachable: true },
  shinR: { boneThreshold: 22, boneScale: 0.9, softScale: 0.5, vitality: 0.5, detachable: true },
  footL: { boneThreshold: 18, boneScale: 1.0, softScale: 0.5, vitality: 0.35, detachable: false },
  footR: { boneThreshold: 18, boneScale: 1.0, softScale: 0.5, vitality: 0.35, detachable: false },
};

/** Bone integrity thresholds (0..100). Level: 0 healthy, 1 minor, 2 fracture, 3 severe, 4 detached. */
export const BONE_LEVELS = { minor: 85, fracture: 55, severe: 25 } as const;
export const SOFT_MINOR = 25;

export const INJURY = {
  /** A limb can only come off if its root bone is below this integrity AND the hit is at least this big. */
  detachIntegrity: 14,
  detachImpulse: 95,
  /** Fraction of the hit impulse that needs a sharp/heavy source for dismember to apply. Blunt light hits cannot detach. */
  detachMinWeaponHeft: 0.55,
  /** Face. */
  noseBreakImpulse: 26,
  eyeDamageImpulse: 20,
  eyeLossImpulse: 52,
  faceHitRadiusBonus: 0.01,
  /** Head trauma. */
  dazePerImpulse: 0.9,
  dazeDecayPerSecond: 7,
  dazedThreshold: 45,
  blackoutImpulse: 78,
  blackoutDaze: 100,
  /** Blackout can't retrigger for this long after recovery ("recovery protection"). */
  blackoutImmunitySeconds: 3.0,
  /** More than this many blackouts in one round -> knockout. */
  blackoutsBeforeKnockout: 2,
  /** Combo limiter: blackouts within one continuous combo (hits closer than this) are suppressed. */
  comboGapSeconds: 1.2,
  /** Fatal thresholds. */
  fatalHeadIntegrity: 6,
  fatalHeadImpulse: 120,
  fatalTorsoIntegrity: 4,
  fatalTorsoImpulse: 150,
  /** Vitality below 0 ends the round as exhaustion KO (not fatal). */
  /** Stamina / balance. */
  staminaRegen: 16,
  staminaRegenDelay: 0.7,
  balanceRegen: 30,
  /** Anti-stunlock: repeated identical knockdowns shrink the knockdown chance by this factor each time (decays). */
  knockdownFatigueStep: 0.7,
  knockdownFatigueDecay: 6,
  /** Recovery protection after getting up. */
  getUpProtectionSeconds: 1.0,
  /** Grapple. */
  grappleMaxSeconds: 4.0,
  grappleEscapeWindowSeconds: 0.35,
} as const;

export type ConsciousnessState = "awake" | "dazed" | "blackout" | "knockout" | "dead";

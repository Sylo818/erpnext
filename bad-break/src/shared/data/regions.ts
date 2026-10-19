/**
 * Anatomical regions and the physical rig bodies that carry them.
 * 16 rig bodies per fighter. "neck" lives on the head body; "abdomen" on the spine body.
 * Facial regions (nose, eyes) are local hit volumes on the head body, not rigid bodies.
 */
export const RIG_BODIES = [
  "pelvis",
  "spine",
  "chest",
  "head",
  "upperArmL",
  "upperArmR",
  "forearmL",
  "forearmR",
  "handL",
  "handR",
  "thighL",
  "thighR",
  "shinL",
  "shinR",
  "footL",
  "footR",
] as const;
export type RigBody = (typeof RIG_BODIES)[number];
export const RIG_COUNT = RIG_BODIES.length;
export const RIG_INDEX: Record<RigBody, number> = Object.fromEntries(
  RIG_BODIES.map((b, i) => [b, i]),
) as Record<RigBody, number>;

export const BODY_REGIONS = [
  "head",
  "neck",
  "chest",
  "abdomen",
  "pelvis",
  "upperArmL",
  "upperArmR",
  "forearmL",
  "forearmR",
  "handL",
  "handR",
  "thighL",
  "thighR",
  "shinL",
  "shinR",
  "footL",
  "footR",
] as const;
export type BodyRegion = (typeof BODY_REGIONS)[number];
export const FACE_REGIONS = ["nose", "eyeL", "eyeR"] as const;
export type FaceRegion = (typeof FACE_REGIONS)[number];
export type HitRegion = BodyRegion | FaceRegion;
export const ALL_REGIONS: readonly HitRegion[] = [...BODY_REGIONS, ...FACE_REGIONS];

export const RIG_BODY_TO_REGION: Record<RigBody, BodyRegion> = {
  pelvis: "pelvis",
  spine: "abdomen",
  chest: "chest",
  head: "head",
  upperArmL: "upperArmL",
  upperArmR: "upperArmR",
  forearmL: "forearmL",
  forearmR: "forearmR",
  handL: "handL",
  handR: "handR",
  thighL: "thighL",
  thighR: "thighR",
  shinL: "shinL",
  shinR: "shinR",
  footL: "footL",
  footR: "footR",
};

/** Parent body for every non-root rig body (joint child -> parent). */
export const RIG_PARENT: Record<Exclude<RigBody, "pelvis">, RigBody> = {
  spine: "pelvis",
  chest: "spine",
  head: "chest",
  upperArmL: "chest",
  upperArmR: "chest",
  forearmL: "upperArmL",
  forearmR: "upperArmR",
  handL: "forearmL",
  handR: "forearmR",
  thighL: "pelvis",
  thighR: "pelvis",
  shinL: "thighL",
  shinR: "thighR",
  footL: "shinL",
  footR: "shinR",
};

export type LimbId = "armL" | "armR" | "legL" | "legR";
export const LIMB_IDS: readonly LimbId[] = ["armL", "armR", "legL", "legR"];
/** Detaching a limb root carries the whole branch (root first). */
export const LIMB_BRANCHES: Record<LimbId, readonly RigBody[]> = {
  armL: ["upperArmL", "forearmL", "handL"],
  armR: ["upperArmR", "forearmR", "handR"],
  legL: ["thighL", "shinL", "footL"],
  legR: ["thighR", "shinR", "footR"],
};
/** Which bodies remain when a *joint* is severed: severing body X removes X and all descendants. */
export function branchFrom(root: RigBody): RigBody[] {
  const out: RigBody[] = [root];
  for (const b of RIG_BODIES) {
    if (b === "pelvis") continue;
    if (out.includes(RIG_PARENT[b]) && !out.includes(b)) out.push(b);
  }
  return out;
}
export function limbOfBody(b: RigBody): LimbId | null {
  for (const k of LIMB_IDS) if (LIMB_BRANCHES[k].includes(b)) return k;
  return null;
}
export function sideOf(r: string): "L" | "R" | null {
  return r.endsWith("L") ? "L" : r.endsWith("R") ? "R" : null;
}
export function mirrorName<T extends string>(n: T): T {
  if (n.endsWith("L")) return (n.slice(0, -1) + "R") as T;
  if (n.endsWith("R")) return (n.slice(0, -1) + "L") as T;
  return n;
}
export const REGION_LABEL: Record<HitRegion, string> = {
  head: "SKULL",
  neck: "NECK",
  chest: "RIBS",
  abdomen: "GUT",
  pelvis: "PELVIS",
  upperArmL: "LEFT UPPER ARM",
  upperArmR: "RIGHT UPPER ARM",
  forearmL: "LEFT FOREARM",
  forearmR: "RIGHT FOREARM",
  handL: "LEFT HAND",
  handR: "RIGHT HAND",
  thighL: "LEFT THIGH",
  thighR: "RIGHT THIGH",
  shinL: "LEFT SHIN",
  shinR: "RIGHT SHIN",
  footL: "LEFT FOOT",
  footR: "RIGHT FOOT",
  nose: "NOSE",
  eyeL: "LEFT EYE",
  eyeR: "RIGHT EYE",
};

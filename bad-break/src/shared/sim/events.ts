import type { HitRegion, LimbId, RigBody } from "../data/regions.js";

/** Strongly typed gameplay events. Every event carries a monotonically increasing revision for net ordering. */
export type MoveKind = "jab" | "cross" | "hook" | "heavy" | "kick" | "shove" | "shoulder" | "weapon" | "grappleStrike" | "thrown" | "environment" | "debris";

export type SimEvent =
  | { t: "hit"; rev: number; attacker: number; target: number; region: HitRegion; body: RigBody; impulse: number; damage: number; kind: MoveKind; pos: [number, number, number]; nrm: [number, number, number]; guarded: boolean; weaponId: string | null; material: string }
  | { t: "whiff"; rev: number; attacker: number; kind: MoveKind; heavy: boolean }
  | { t: "swing"; rev: number; attacker: number; kind: MoveKind; heavy: boolean; weaponId: string | null; pos: [number, number, number] }
  | { t: "block"; rev: number; defender: number; with: string; pos: [number, number, number]; strength: number }
  | { t: "injury"; rev: number; fighter: number; region: HitRegion; level: number; kind: "bruise" | "fracture" | "severe" | "nose" | "eye" | "eyeLoss" | "detach"; label: string; cause: string }
  | { t: "state"; rev: number; fighter: number; state: string }
  | { t: "consciousness"; rev: number; fighter: number; state: "awake" | "dazed" | "blackout" | "knockout" | "dead"; cause: string }
  | { t: "limbDetached"; rev: number; fighter: number; limb: LimbId; objectId: string; pos: [number, number, number] }
  | { t: "wallBreak"; rev: number; wallId: string; patches: number[]; pos: [number, number, number]; by: number }
  | { t: "propBreak"; rev: number; propId: string; kind: string; pieces: string[]; pos: [number, number, number]; by: number }
  | { t: "furnitureBreak"; rev: number; id: string; kind: string; pos: [number, number, number] }
  | { t: "doorBreak"; rev: number; id: string; pos: [number, number, number] }
  | { t: "grab"; rev: number; fighter: number; hand: "L" | "R" | "both"; targetKind: "prop" | "fighter" | "limb"; targetId: string }
  | { t: "release"; rev: number; fighter: number; targetId: string; reason: string }
  | { t: "throw"; rev: number; fighter: number; targetKind: "prop" | "fighter" | "limb"; targetId: string; speed: number }
  | { t: "ownership"; rev: number; propId: string; owner: number; hand: "L" | "R" | "both" | "none" }
  | { t: "taunt"; rev: number; fighter: number }
  | { t: "stamina"; rev: number; fighter: number; empty: boolean }
  | { t: "announce"; rev: number; line: string; cooldownKey: string }
  | { t: "roundStart"; rev: number; round: number }
  | { t: "roundEnd"; rev: number; round: number; winner: number | "draw"; reason: string }
  | { t: "matchEnd"; rev: number; winner: number | "draw"; scores: [number, number] }
  | { t: "impact"; rev: number; material: string; pos: [number, number, number]; strength: number; a: string; b: string };

export type SimEventInput = SimEvent extends infer E ? (E extends { rev: number } ? Omit<E, "rev"> : never) : never;

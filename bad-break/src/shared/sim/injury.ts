import { BODY_REGIONS, type BodyRegion, type HitRegion, LIMB_BRANCHES, type LimbId, REGION_LABEL, type FaceRegion, type RigBody, RIG_BODY_TO_REGION } from "../data/regions.js";
import { BONE_LEVELS, INJURY, REGION_TUNING, SOFT_MINOR, type ConsciousnessState } from "../data/injuries.js";
import { clamp } from "../math.js";

export type BoneLevel = 0 | 1 | 2 | 3 | 4; // healthy, minor, fracture, severe, detached
export type EyeState = 0 | 1 | 2; // ok, damaged, lost
export type NoseState = "intact" | "broken";

export interface HitInput {
  region: BodyRegion;
  face?: FaceRegion | null;
  /** Effective contact impulse (N*s) after guard reduction. */
  impulse: number;
  /** 0..1, how heavy/sharp the damaging object is (fist .15, bat .6, axe 1). Gates detachment. */
  heft: number;
  /** Multipliers for special sources (environment, thrown bodies). */
  boneMult?: number;
  vitMult?: number;
  /** Source description for "cause of defeat". */
  cause: string;
  /** Is this hit environmental (wall impact / thrown)? Allows detach from big forces. */
  environmental?: boolean;
  time: number;
}

export type InjuryNote =
  | { kind: "injury"; region: HitRegion; level: number; ik: "bruise" | "fracture" | "severe" | "nose" | "eye" | "eyeLoss" | "detach"; label: string }
  | { kind: "consciousness"; state: ConsciousnessState; cause: string };

export interface HitOutcome {
  vitalityLoss: number;
  notes: InjuryNote[];
  /** Limb that should be severed by the sim at the next safe boundary. */
  detach: LimbId | null;
  blackout: boolean;
  knockout: boolean;
  fatal: boolean;
  /** Head impulse that contributed to daze. */
  daze: number;
}

const LEVEL_LABEL: Record<number, string> = { 1: "BRUISED", 2: "FRACTURED", 3: "SHATTERED", 4: "TORN OFF" };

export function boneLevel(bone: number, soft: number): BoneLevel {
  if (bone >= BONE_LEVELS.minor && soft < SOFT_MINOR) return 0;
  if (bone >= BONE_LEVELS.fracture) return 1;
  if (bone >= BONE_LEVELS.severe) return 2;
  return 3;
}

export class InjuryState {
  bone = {} as Record<BodyRegion, number>;
  soft = {} as Record<BodyRegion, number>;
  attached: Record<LimbId, boolean> = { armL: true, armR: true, legL: true, legR: true };
  nose: NoseState = "intact";
  eye: { L: EyeState; R: EyeState } = { L: 0, R: 0 };
  vitality = 100;
  stamina = 100;
  balance = 100;
  daze = 0;
  consciousness: ConsciousnessState = "awake";
  consciousTimer = 0;
  blackoutCount = 0;
  deathCause: string | null = null;
  lastCause = "";
  // anti-stunlock bookkeeping
  private blackoutImmuneUntil = -1;
  private lastBlackoutAt = -99;
  private lastHeadHitAt = -99;
  knockdownFatigue = 0;
  /** Time (sim seconds) since last stamina use; regen starts after delay. */
  staminaIdle = 0;

  constructor() {
    this.reset();
  }

  reset() {
    for (const r of BODY_REGIONS) {
      this.bone[r] = 100;
      this.soft[r] = 0;
    }
    this.attached = { armL: true, armR: true, legL: true, legR: true };
    this.nose = "intact";
    this.eye = { L: 0, R: 0 };
    this.vitality = 100;
    this.stamina = 100;
    this.balance = 100;
    this.daze = 0;
    this.consciousness = "awake";
    this.consciousTimer = 0;
    this.blackoutCount = 0;
    this.deathCause = null;
    this.lastCause = "";
    this.blackoutImmuneUntil = -1;
    this.lastBlackoutAt = -99;
    this.lastHeadHitAt = -99;
    this.knockdownFatigue = 0;
    this.staminaIdle = 0;
  }

  get alive(): boolean {
    return this.consciousness !== "dead";
  }
  get unconscious(): boolean {
    return this.consciousness === "blackout" || this.consciousness === "knockout" || this.consciousness === "dead";
  }
  /** True while the fighter cannot act (limp). */
  get incapacitated(): boolean {
    return this.unconscious;
  }

  /** Is the region attached to the body (false if it or an ancestor limb root was detached)? */
  isAttachedBody(b: RigBody): boolean {
    for (const k of Object.keys(LIMB_BRANCHES) as LimbId[]) {
      if (LIMB_BRANCHES[k].includes(b)) return this.attached[k];
    }
    return true;
  }
  level(region: BodyRegion): BoneLevel {
    const limb = (Object.keys(LIMB_BRANCHES) as LimbId[]).find((k) => LIMB_BRANCHES[k].some((b) => RIG_BODY_TO_REGION[b] === region));
    if (limb && !this.attached[limb]) return 4;
    return boneLevel(this.bone[region], this.soft[region]);
  }
  /** Overall level of a limb chain: the worst of its segments. */
  limbLevel(limb: LimbId): BoneLevel {
    if (!this.attached[limb]) return 4;
    let worst: BoneLevel = 0;
    for (const b of LIMB_BRANCHES[limb]) worst = Math.max(worst, this.level(RIG_BODY_TO_REGION[b])) as BoneLevel;
    return worst;
  }

  /** Spend stamina. Returns false if the fighter lacked enough (action still allowed but exhausted). */
  spendStamina(amount: number): boolean {
    const eff = amount * effectsCostMult(this);
    this.staminaIdle = 0;
    const had = this.stamina >= eff;
    this.stamina = Math.max(0, this.stamina - eff);
    return had;
  }

  tickRegen(dt: number, exerting: boolean) {
    this.staminaIdle += dt;
    if (!exerting && this.staminaIdle > INJURY.staminaRegenDelay && this.alive) {
      const torso = Math.max(this.level("chest"), this.level("abdomen"));
      const mult = torso >= 3 ? 0.45 : torso === 2 ? 0.65 : 1;
      this.stamina = Math.min(100, this.stamina + INJURY.staminaRegen * mult * dt);
    }
    if (this.alive) this.balance = Math.min(100, this.balance + INJURY.balanceRegen * dt * (this.legPenalty() > 0.4 ? 0.6 : 1));
    this.knockdownFatigue = Math.max(0, this.knockdownFatigue - INJURY.knockdownFatigueDecay * dt * 0.1);
    this.daze = Math.max(0, this.daze - INJURY.dazeDecayPerSecond * dt);
  }

  legPenalty(): number {
    const l = legFunction(this, "legL");
    const r = legFunction(this, "legR");
    return 1 - Math.min(l, r);
  }

  /** Advance consciousness timers. Returns notes for transitions. */
  tickConsciousness(dt: number, time: number): InjuryNote[] {
    const notes: InjuryNote[] = [];
    if (this.consciousness === "blackout") {
      this.consciousTimer -= dt;
      if (this.consciousTimer <= 0) {
        this.consciousness = this.daze >= INJURY.dazedThreshold ? "dazed" : "awake";
        this.daze = Math.min(this.daze, 55);
        this.blackoutImmuneUntil = time + INJURY.blackoutImmunitySeconds;
        notes.push({ kind: "consciousness", state: "awake", cause: "recovered" });
      }
    } else if (this.consciousness === "knockout") {
      this.consciousTimer += dt; // counts up for the knockout count
    } else if (this.consciousness === "awake" && this.daze >= INJURY.dazedThreshold) {
      this.consciousness = "dazed";
      notes.push({ kind: "consciousness", state: "dazed", cause: "head trauma" });
    } else if (this.consciousness === "dazed" && this.daze < INJURY.dazedThreshold * 0.6) {
      this.consciousness = "awake";
      notes.push({ kind: "consciousness", state: "awake", cause: "recovered" });
    }
    return notes;
  }

  /** Protection granted when someone gets up from a knockdown. */
  get blackoutImmune(): boolean {
    return false;
  }

  recordKnockdown(): number {
    const chance = Math.pow(INJURY.knockdownFatigueStep, this.knockdownFatigue);
    this.knockdownFatigue += 1;
    return chance;
  }

  private enter(state: ConsciousnessState, cause: string, notes: InjuryNote[]) {
    if (this.consciousness === state) return;
    this.consciousness = state;
    notes.push({ kind: "consciousness", state, cause });
  }

  applyHit(h: HitInput, blackoutSeconds: number): HitOutcome {
    const out: HitOutcome = { vitalityLoss: 0, notes: [], detach: null, blackout: false, knockout: false, fatal: false, daze: 0 };
    if (!this.alive) return out;
    const tun = REGION_TUNING[h.region];
    const before = this.level(h.region);
    const J = Math.max(0, h.impulse);
    this.lastCause = h.cause;

    // soft tissue
    this.soft[h.region] = clamp(this.soft[h.region] + J * tun.softScale * 0.35, 0, 100);
    // bone
    let boneLoss = Math.max(0, J - tun.boneThreshold) * tun.boneScale * (h.boneMult ?? 1);
    if (this.bone[h.region] < BONE_LEVELS.fracture) boneLoss *= 1.25; // already weakened
    this.bone[h.region] = clamp(this.bone[h.region] - boneLoss, 0, 100);
    // vitality
    out.vitalityLoss = J * 0.2 * tun.vitality * (h.vitMult ?? 1);
    this.vitality = Math.max(0, this.vitality - out.vitalityLoss);

    const after = this.level(h.region);
    if (after > before) {
      for (let lv = before + 1; lv <= after; lv++) {
        out.notes.push({
          kind: "injury",
          region: h.region,
          level: lv,
          ik: lv === 1 ? "bruise" : lv === 2 ? "fracture" : "severe",
          label: `${REGION_LABEL[h.region]} ${LEVEL_LABEL[lv]}`,
        });
      }
    }

    // detachment: substantial localized damage AND suitably forceful event
    if (tun.detachable) {
      const limb = limbOfRegion(h.region);
      if (limb && this.attached[limb] && this.bone[h.region] <= INJURY.detachIntegrity && J >= INJURY.detachImpulse && (h.heft >= INJURY.detachMinWeaponHeft || h.environmental)) {
        out.detach = limb;
      }
    }

    // face
    if (h.face === "nose" && this.nose === "intact" && J >= INJURY.noseBreakImpulse) {
      this.nose = "broken";
      out.notes.push({ kind: "injury", region: "nose", level: 2, ik: "nose", label: "NOSE BROKEN" });
    }
    if (h.face === "eyeL" || h.face === "eyeR") {
      const side = h.face === "eyeL" ? "L" : "R";
      const cur = this.eye[side];
      if (cur < 2 && J >= INJURY.eyeLossImpulse && (h.heft >= 0.3 || cur === 1)) {
        this.eye[side] = 2;
        out.notes.push({ kind: "injury", region: h.face, level: 3, ik: "eyeLoss", label: `${side === "L" ? "LEFT" : "RIGHT"} EYE LOST` });
      } else if (cur < 1 && J >= INJURY.eyeDamageImpulse) {
        this.eye[side] = 1;
        out.notes.push({ kind: "injury", region: h.face, level: 1, ik: "eye", label: `${side === "L" ? "LEFT" : "RIGHT"} EYE DAMAGED` });
      }
    }

    // head trauma
    const headish = h.region === "head" || h.region === "neck";
    if (headish) {
      const gain = J * INJURY.dazePerImpulse * (h.face ? 1.15 : 1);
      this.daze = Math.min(160, this.daze + gain);
      out.daze = gain;
      const gap = h.time - this.lastHeadHitAt;
      this.lastHeadHitAt = h.time;
      // fatal outcomes
      if (this.bone.head <= INJURY.fatalHeadIntegrity && J >= INJURY.fatalHeadImpulse) {
        out.fatal = true;
        this.die("fatal head trauma", out.notes);
      } else if (h.region === "neck" && this.bone.neck <= INJURY.fatalHeadIntegrity && J >= INJURY.fatalHeadImpulse * 0.9) {
        out.fatal = true;
        this.die("broken neck", out.notes);
      } else if (this.alive && !this.unconscious) {
        const strong = J >= INJURY.blackoutImpulse || this.daze >= INJURY.blackoutDaze;
        if (strong) {
          const immune = h.time < this.blackoutImmuneUntil;
          const inCombo = h.time - this.lastBlackoutAt < INJURY.comboGapSeconds || gap < 0.0;
          if (immune || inCombo) {
            this.daze = Math.min(this.daze, 80); // recovery protection: absorb, no new blackout
          } else {
            this.blackoutCount++;
            this.lastBlackoutAt = h.time;
            if (this.blackoutCount > INJURY.blackoutsBeforeKnockout || J >= INJURY.blackoutImpulse * 2.2) {
              this.consciousTimer = 0;
              this.enter("knockout", "head trauma", out.notes);
              out.knockout = true;
            } else {
              this.consciousTimer = blackoutSeconds * (1 + 0.2 * (this.blackoutCount - 1));
              this.enter("blackout", "head trauma", out.notes);
              out.blackout = true;
            }
          }
        }
      }
    }

    // torso fatal
    if (this.alive && (h.region === "chest" || h.region === "abdomen") && this.bone[h.region] <= INJURY.fatalTorsoIntegrity && J >= INJURY.fatalTorsoImpulse) {
      out.fatal = true;
      this.die("crushed torso", out.notes);
    }
    // exhaustion knockout when vitality empty
    if (this.alive && this.vitality <= 0 && this.consciousness !== "knockout") {
      this.consciousTimer = 0;
      this.enter("knockout", "beaten senseless", out.notes);
      out.knockout = true;
    }
    return out;
  }

  die(cause: string, notes: InjuryNote[]) {
    if (this.consciousness === "dead") return;
    this.deathCause = cause;
    this.consciousness = "dead";
    this.vitality = 0;
    notes.push({ kind: "consciousness", state: "dead", cause });
  }

  /** Commit a detachment exactly once. Returns false if already detached. */
  commitDetach(limb: LimbId, notes: InjuryNote[]): boolean {
    if (!this.attached[limb]) return false;
    this.attached[limb] = false;
    const root = LIMB_BRANCHES[limb][0];
    const region = RIG_BODY_TO_REGION[root];
    this.bone[region] = 0;
    notes.push({ kind: "injury", region, level: 4, ik: "detach", label: `${limb.startsWith("arm") ? (limb.endsWith("L") ? "LEFT ARM" : "RIGHT ARM") : limb.endsWith("L") ? "LEFT LEG" : "RIGHT LEG"} TORN OFF` });
    // bleeding out: heavy vitality hit
    this.vitality = Math.max(0, this.vitality - 14);
    return true;
  }
}

function limbOfRegion(r: BodyRegion): LimbId | null {
  for (const k of Object.keys(LIMB_BRANCHES) as LimbId[]) if (LIMB_BRANCHES[k].some((b) => RIG_BODY_TO_REGION[b] === r)) return k;
  return null;
}

const SEG = [1, 0.92, 0.55, 0.2, 0];
/** 0..1 usable function of an arm (strikes, grip). */
export function armFunction(inj: InjuryState, limb: "armL" | "armR"): number {
  if (!inj.attached[limb]) return 0;
  const s = limb === "armL" ? "L" : "R";
  const u = SEG[inj.level(`upperArm${s}` as BodyRegion)];
  const f = SEG[inj.level(`forearm${s}` as BodyRegion)];
  const h = SEG[inj.level(`hand${s}` as BodyRegion)];
  return clamp(Math.min(u, f + 0.15) * (0.55 + 0.45 * Math.min(f, 1)) * (0.7 + 0.3 * h), 0, 1);
}
export function gripFunction(inj: InjuryState, limb: "armL" | "armR"): number {
  if (!inj.attached[limb]) return 0;
  const s = limb === "armL" ? "L" : "R";
  const f = SEG[inj.level(`forearm${s}` as BodyRegion)];
  const h = SEG[inj.level(`hand${s}` as BodyRegion)];
  const u = SEG[inj.level(`upperArm${s}` as BodyRegion)];
  return clamp(Math.min(h, 1) * (0.5 + 0.5 * f) * (0.6 + 0.4 * u), 0, 1);
}
export function legFunction(inj: InjuryState, limb: "legL" | "legR"): number {
  if (!inj.attached[limb]) return 0;
  const s = limb === "legL" ? "L" : "R";
  const t = SEG[inj.level(`thigh${s}` as BodyRegion)];
  const sh = SEG[inj.level(`shin${s}` as BodyRegion)];
  const f = SEG[inj.level(`foot${s}` as BodyRegion)];
  return clamp(Math.min(t, sh + 0.1) * (0.6 + 0.4 * Math.min(sh, 1)) * (0.75 + 0.25 * f), 0, 1);
}
export type Locomotion = "walk" | "limp" | "hop" | "crawl";
export interface Effects {
  armL: number;
  armR: number;
  gripL: number;
  gripR: number;
  legL: number;
  legR: number;
  locomotion: Locomotion;
  speedMult: number;
  canDodge: boolean;
  canRun: boolean;
  /** Both arms usable for a two-handed grip. */
  canTwoHand: boolean;
  staminaCostMult: number;
  balanceLossMult: number;
  /** Aim-assist radius multiplier (eye injuries reduce, never remove manual aim). */
  aimAssist: number;
  /** Which leg is worse (for limp animation): -1 left, +1 right, 0 none. */
  limpSide: -1 | 0 | 1;
  /** Strike strength multiplier (broken arm weakens). */
  strikeMultL: number;
  strikeMultR: number;
  kickMultL: number;
  kickMultR: number;
  /** Max held object weight class the fighter can lift one handed (kg). */
  liftLimit: number;
  /** Grounded defense only (cannot stand). */
  mustCrawl: boolean;
  dazed: boolean;
}

export function computeEffects(inj: InjuryState): Effects {
  const aL = armFunction(inj, "armL"),
    aR = armFunction(inj, "armR");
  const gL = gripFunction(inj, "armL"),
    gR = gripFunction(inj, "armR");
  const lL = legFunction(inj, "legL"),
    lR = legFunction(inj, "legR");
  const worst = Math.min(lL, lR);
  const best = Math.max(lL, lR);
  let loco: Locomotion = "walk";
  let speed = 1;
  if (best < 0.3) {
    // both legs unusable: grounded crawl
    loco = "crawl";
    speed = 0.22;
  } else if (worst < 0.3) {
    // one good leg: hop
    loco = "hop";
    speed = worst < 0.05 ? 0.5 : 0.55;
  } else if (worst < 0.8) {
    loco = "limp";
    speed = 0.68 + (0.3 * (worst - 0.3)) / 0.5;
  } else if (worst < 0.97) {
    loco = "limp";
    speed = 0.92;
  }
  const torso = Math.max(inj.level("chest"), inj.level("abdomen"));
  const eyes = (inj.eye.L === 2 ? 1 : 0) + (inj.eye.R === 2 ? 1 : 0) + ((inj.eye.L === 1 ? 0.35 : 0) + (inj.eye.R === 1 ? 0.35 : 0));
  return {
    armL: aL,
    armR: aR,
    gripL: gL,
    gripR: gR,
    legL: lL,
    legR: lR,
    locomotion: loco,
    speedMult: speed * (inj.consciousness === "dazed" ? 0.85 : 1),
    canDodge: worst >= 0.55,
    canRun: worst >= 0.8,
    canTwoHand: gL > 0.35 && gR > 0.35,
    staminaCostMult: torso >= 3 ? 1.5 : torso === 2 ? 1.25 : 1,
    balanceLossMult: 1 + (1 - worst) * 1.2,
    aimAssist: clamp(1 - eyes * 0.45, 0.1, 1),
    limpSide: lL < lR - 0.05 ? -1 : lR < lL - 0.05 ? 1 : 0,
    strikeMultL: 0.25 + 0.75 * aL,
    strikeMultR: 0.25 + 0.75 * aR,
    kickMultL: 0.3 + 0.7 * lL,
    kickMultR: 0.3 + 0.7 * lR,
    liftLimit: 4 + 28 * Math.max(gL, gR) + (gL > 0.35 && gR > 0.35 ? 22 * Math.min(gL, gR) : 0),
    mustCrawl: best < 0.3,
    dazed: inj.consciousness === "dazed",
  };
}
function effectsCostMult(inj: InjuryState): number {
  const torso = Math.max(inj.level("chest"), inj.level("abdomen"));
  return torso >= 3 ? 1.5 : torso === 2 ? 1.25 : 1;
}

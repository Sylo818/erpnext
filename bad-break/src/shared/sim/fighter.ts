/**
 * A fighter: movement controller + active-ragdoll rig + state machine + hidden animation target.
 *
 * Root ownership (exactly one writer at a time):
 *   upright states (neutral/attack/guard/dodge/stagger/pickup/throw/grapple/grabbed/taunt/celebrate)
 *        -> PhysicsCharacterController owns the root; the pelvis is a KINEMATIC body following it.
 *   getup  -> a scripted curve owns the root; the pelvis is KINEMATIC.
 *   ragdoll-> the pelvis is DYNAMIC; the controller capsule is parked away. Velocity is transferred explicitly.
 */
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { PhysicsCharacterController, CharacterSupportedState } from "@babylonjs/core/Physics/v2/characterController.js";
import { PhysicsShapeCapsule } from "@babylonjs/core/Physics/v2/physicsShape.js";
import { BONE_REGION_IDS } from "./boneRegions.js";
import { INJURY } from "../data/injuries.js";
import { FIGHTERS, type FighterDef } from "../data/fighters.js";
import { GETUPS, MOVES, POSES, type MoveDef } from "../data/moves.js";
import { RIG_BODIES, RIG_COUNT, RIG_INDEX, type RigBody } from "../data/regions.js";
import { buildRigSpec, type RigSpec } from "../data/rigspec.js";
import { PROPS, type PropDef } from "../data/props.js";
import { DEG, TAU, angleLerp, approach, clamp, clamp01, easeInOut, lerp, moveToward, smoothstep, wrapAngle } from "../math.js";
import { ARM_L, ARM_R, Layer, RootState, bump, compileMove, sampleKeys, sampleMove } from "./anim.js";
import { Gait, solveLegIK, type LegSolveOut } from "./gait.js";
import { BTN, copyIntent, emptyIntent, type Intent } from "./input.js";
import { InjuryState, computeEffects, type Effects } from "./injury.js";
import { Pose } from "./fk.js";
import { G, capCollideMask, capGroup } from "./groups.js";
import { Rig } from "./rig.js";
import type { SimWorld } from "./world.js";
import type { Prop } from "./props.js";

export type FState = "neutral" | "attack" | "guard" | "dodge" | "stagger" | "pickup" | "throw" | "grapple" | "grabbed" | "taunt" | "ragdoll" | "getup" | "celebrate";
export type RagKind = "knockdown" | "limp" | "ko" | "dead" | "thrown";

const DOWN = new Vector3(0, -1, 0);
const GRAV = new Vector3(0, -9.81, 0);
const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _q1 = Quaternion.Identity();

export interface Highlight {
  kind: "prop" | "fighter";
  id: string;
  dist: number;
}

export class Fighter {
  readonly slot: number;
  readonly def: FighterDef;
  readonly spec: RigSpec;
  readonly rig: Rig;
  readonly cc: PhysicsCharacterController;
  readonly inj = new InjuryState();
  readonly gait: Gait;
  fx: Effects;
  private fxVersion = -1;
  injVersion = 0;

  state: FState = "neutral";
  stateT = 0;
  facing = 0;
  vel = new Vector3(); // intended horizontal velocity
  ext = new Vector3(); // knockback / lunge velocity (decays)
  pos = new Vector3(); // ground position under the capsule
  groundY = 0;
  intent: Intent = emptyIntent();
  prevButtons = 0;
  edges = 0;

  // attack
  move: MoveDef | null = null;
  moveT = 0;
  moveScale = 1; // time scale (tempo, weapon heft)
  moveHeight: -1 | 0 | 1 = 0;
  moveCharge = 0;
  moveCharging = false;
  moveHeavyHeld = false;
  moveWeapon: Prop | null = null;
  attackId = 0;
  hitThisAttack = new Set<string>();
  comboIdx = 0;
  chainQueued = false;
  lastAttackEnd = -9;
  hitStop = 0;
  cooldownAttack = 0;

  // guard / dodge
  guardW = 0; // 0..1 blend
  dodgeT = 0;
  dodgeDir = new Vector3();
  dodgeCooldown = 0;
  iframes = 0;
  recoveryProtect = 0;

  // stagger
  staggerT = 0;

  // interaction
  highlight: Highlight | null = null;
  heldMain: Prop | null = null; // main (right) hand prop
  heldOff: Prop | null = null; // off (left) hand prop (or second grip of two-hander)
  pickupTarget: Prop | null = null;
  pickupT = 0;
  throwT = 0;
  throwKind: "prop" | "fighter" = "prop";
  /** Grapple relationship. */
  grappleRole: "none" | "holder" | "held" = "none";
  grappleOther: Fighter | null = null;
  grappleT = 0;
  grappleStrain = 0;
  grappleEscapeOpen = 0; // >0 while an escape window is open
  grappleEscapeCd = 0;
  grappleImmune = 0;
  grappleStrikeQueued = false;

  // ragdoll
  ragKind: RagKind = "knockdown";
  ragT = 0;
  settleT = 0;
  getupKind = "supine";
  getupT = 0;
  getupFrom = new Vector3();
  getupFromYaw = 0;
  getupFromQ = Quaternion.Identity();
  getupRoll = false;
  thrownBy = -1;
  thrownT = 0;
  lastImpactT = -9;

  // taunt
  tauntT = 0;
  // celebrate
  celebrateT = 0;
  celebrateKind = 0;

  // animation
  readonly stance = new Layer();
  readonly cur = new Layer();
  readonly from = new Layer();
  readonly tmp = new Layer();
  readonly rootState = new RootState();
  blendT = 1;
  blendDur = 0.12;
  readonly pose = new Pose();
  private legOut: LegSolveOut[] = [
    { thighQ: Quaternion.Identity(), shinQ: Quaternion.Identity(), knee: new Vector3(), reach: 0 },
    { thighQ: Quaternion.Identity(), shinQ: Quaternion.Identity(), knee: new Vector3(), reach: 0 },
  ];
  private footQ = [Quaternion.Identity(), Quaternion.Identity()];
  private hipW = new Vector3();
  private ankleW = new Vector3();
  private l1: number;
  private l2: number;
  private ankleH: number;
  breath = 0;
  bobPhase = 0;
  stunned = 0;

  /** Pelvis velocity entering the physics step (pre-impact), used for impact magnitudes. */
  preVel = new Vector3();

  // stats for results
  stats = { damageDealt: 0, damageTaken: 0, propsBroken: 0, wallsBroken: 0, majorInjuries: [] as string[], throws: 0, blocks: 0, hits: 0, whiffs: 0 };

  private capLowered = false;
  private lastLoco = "walk";

  constructor(readonly world: SimWorld, slot: number, defId: string, spawn: { pos: readonly [number, number, number]; yaw: number }) {
    this.slot = slot;
    this.def = FIGHTERS[defId];
    this.spec = buildRigSpec(this.def.height, this.def.girth, this.def.mass);
    this.rig = new Rig({ scene: world.scene, spec: this.spec, slot, name: `f${slot}` });
    const cap = this.spec.capsule;
    const shape = new PhysicsShapeCapsule(new Vector3(0, cap.height / 2 - cap.radius, 0), new Vector3(0, -cap.height / 2 + cap.radius, 0), cap.radius, world.scene);
    shape.filterMembershipMask = capGroup(slot);
    shape.filterCollideMask = capCollideMask(slot);
    this.cc = new PhysicsCharacterController(new Vector3(spawn.pos[0], cap.height / 2 + 0.06, spawn.pos[2]), { shape }, world.scene);
    this.cc.footOffset = cap.height / 2;
    this.cc.keepDistance = 0.03;
    this.cc.keepContactTolerance = 0.06;
    this.cc.maxSlopeCosine = Math.cos((50 * Math.PI) / 180);
    this.cc.maxCastIterations = 8;
    this.cc.characterMass = this.def.mass;
    this.cc.characterStrength = 60;
    this.cc.maxStepHeight = 0.18;
    this.gait = new Gait(this.spec);
    this.fx = computeEffects(this.inj);
    this.l1 = Math.abs(this.spec.byName.thighR.pivotParent[1] - 0) * 0 + (this.spec.byName.thighR.pivotSelf[1] + Math.abs(this.spec.byName.shinR.pivotParent[1]));
    this.l2 = this.spec.byName.shinR.pivotSelf[1] + Math.abs(this.spec.byName.footR.pivotParent[1]);
    this.ankleH = this.spec.byName.footR.restJoint[1];
    this.buildStance();
    this.placeAt(spawn.pos, spawn.yaw);
  }

  // ---------------------------------------------------------------- placement / reset
  buildStance() {
    const src = this.def.stance === "heavy" ? POSES.stanceHeavy : POSES.stanceBouncy;
    this.stance.clear();
    this.stance.setPose(src.j);
    this.stance.root.addKey(src.r, 1, false);
  }

  placeAt(p: readonly [number, number, number], yaw: number) {
    const cap = this.spec.capsule;
    this.groundY = p[1];
    this.cc.setPosition(new Vector3(p[0], p[1] + cap.height / 2 + 0.06, p[2]));
    this.cc.setVelocity(Vector3.Zero());
    this.pos.set(p[0], p[1], p[2]);
    this.facing = yaw;
    this.vel.setAll(0);
    this.ext.setAll(0);
    this.state = "neutral";
    this.stateT = 0;
    this.gait.reset(p[0], p[2], yaw, p[1]);
    this.cur.copyFrom(this.stance);
    this.from.copyFrom(this.stance);
    this.blendT = 1;
    this.composeTargets(0, true);
    this.rig.teleportToFk(this.rig.target);
    this.rig.setRootKinematic(true);
    this.rig.tone.fill(1);
    this.capLowered = false;
  }

  /** Full reset between rounds. */
  resetForRound(spawn: { pos: readonly [number, number, number]; yaw: number }) {
    this.releaseEverything("round reset");
    this.inj.reset();
    this.injVersion++;
    this.move = null;
    this.guardW = 0;
    this.dodgeT = 0;
    this.iframes = 0;
    this.recoveryProtect = 0;
    this.staggerT = 0;
    this.stunned = 0;
    this.hitStop = 0;
    this.grappleRole = "none";
    this.grappleOther = null;
    this.thrownBy = -1;
    this.celebrateT = 0;
    this.tauntT = 0;
    this.comboIdx = 0;
    this.prevButtons = 0;
    this.intent = emptyIntent();
    this.restoreStandingRig();
    this.placeAt(spawn.pos, spawn.yaw);
    this.fx = computeEffects(this.inj);
  }

  /** Rebuild any severed limbs. Called on round reset. */
  private restoreStandingRig() {
    this.world.restoreFighterRig(this);
  }

  releaseEverything(reason: string) {
    this.world.props.releaseAll(this, reason);
    if (this.grappleOther) this.world.grapples.end(this, reason);
  }

  get dead(): boolean {
    return !this.inj.alive;
  }
  get unconscious(): boolean {
    return this.inj.unconscious;
  }
  get mass(): number {
    return this.def.mass;
  }
  get upright(): boolean {
    return this.state !== "ragdoll" && this.state !== "getup";
  }
  get opponent(): Fighter {
    return this.world.fighters[1 - this.slot];
  }
  get rootPos(): Vector3 {
    return this.rig.nodes[0].position;
  }
  forward(out: Vector3): Vector3 {
    return out.set(Math.sin(this.facing), 0, Math.cos(this.facing));
  }
  right(out: Vector3): Vector3 {
    return out.set(Math.cos(this.facing), 0, -Math.sin(this.facing));
  }

  setState(s: FState) {
    if (this.state === s) return;
    this.from.copyFrom(this.cur);
    this.blendT = 0;
    this.blendDur = s === "ragdoll" ? 0.02 : s === "attack" ? 0.06 : s === "getup" ? 0.05 : 0.14;
    this.state = s;
    this.stateT = 0;
    this.world.emit({ t: "state", fighter: this.slot, state: s });
  }

  /** Marks injuries changed so effects recompute. */
  injuryChanged() {
    this.injVersion++;
  }

  // ---------------------------------------------------------------- input
  setIntent(i: Intent) {
    const prev = this.intent.buttons;
    copyIntent(i, this.intent);
    this.prevButtons = prev;
    this.edges = i.buttons & ~prev;
  }
  held(b: number) {
    return (this.intent.buttons & b) !== 0;
  }
  pressed(b: number) {
    return (this.edges & b) !== 0;
  }

  // ---------------------------------------------------------------- per-tick
  /** Pre-physics: decisions, controller, pose targets, drives. */
  preStep(dt: number) {
    if (this.fxVersion !== this.injVersion) {
      this.fx = computeEffects(this.inj);
      this.fxVersion = this.injVersion;
      this.applyInjuryTone();
    }
    this.stateT += dt;
    this.breath += dt;
    if (this.blendT < 1) this.blendT = Math.min(1, this.blendT + dt / this.blendDur);
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt);
    this.iframes = Math.max(0, this.iframes - dt);
    this.recoveryProtect = Math.max(0, this.recoveryProtect - dt);
    this.grappleImmune = Math.max(0, this.grappleImmune - dt);
    this.grappleEscapeCd = Math.max(0, this.grappleEscapeCd - dt);
    this.cooldownAttack = Math.max(0, this.cooldownAttack - dt);
    this.stunned = Math.max(0, this.stunned - dt);
    this.ext.scaleInPlace(Math.exp(-dt * 7));

    const unconscious = this.inj.unconscious;
    if (unconscious && this.state !== "ragdoll") {
      this.enterRagdoll(this.inj.consciousness === "dead" ? "dead" : this.inj.consciousness === "knockout" ? "ko" : "limp", null);
    }

    switch (this.state) {
      case "ragdoll":
        this.updateRagdoll(dt);
        break;
      case "getup":
        this.updateGetUp(dt);
        break;
      default:
        this.updateUpright(dt);
        break;
    }
    this.applyDrivesAndRoot(dt);
  }

  private applyInjuryTone() {
    const f = this.fx;
    const t = this.rig.injuryTone;
    const arm = (s: "L" | "R", v: number) => {
      t[RIG_INDEX[`upperArm${s}` as RigBody]] = 0.35 + 0.65 * v;
      t[RIG_INDEX[`forearm${s}` as RigBody]] = 0.3 + 0.7 * v;
      t[RIG_INDEX[`hand${s}` as RigBody]] = 0.3 + 0.7 * v;
    };
    arm("L", f.armL);
    arm("R", f.armR);
    const leg = (s: "L" | "R", v: number) => {
      t[RIG_INDEX[`thigh${s}` as RigBody]] = 0.45 + 0.55 * v;
      t[RIG_INDEX[`shin${s}` as RigBody]] = 0.4 + 0.6 * v;
      t[RIG_INDEX[`foot${s}` as RigBody]] = 0.4 + 0.6 * v;
    };
    leg("L", f.legL);
    leg("R", f.legR);
  }

  // ---------------------------------------------------------------- upright logic
  private updateUpright(dt: number) {
    const intent = this.intent;
    const fx = this.fx;
    const inj = this.inj;
    const opp = this.opponent;
    const isHolding = this.heldMain !== null || this.heldOff !== null;

    // hit-stop: freeze animation clock briefly
    const animDt = this.hitStop > 0 ? 0 : dt;
    this.hitStop = Math.max(0, this.hitStop - dt);

    // stagger recovery
    if (this.state === "stagger") {
      this.staggerT -= dt;
      if (this.staggerT <= 0) this.setState("neutral");
    }

    // ---- state transitions from input
    const canAct = !this.stunned && (this.state === "neutral" || this.state === "guard");
    if (this.state === "neutral" || this.state === "guard") {
      this.highlight = this.world.props.findHighlight(this);
    } else this.highlight = null;

    // taunt
    if (this.state === "neutral" && this.pressed(BTN.TAUNT) && !this.stunned && fx.locomotion !== "crawl") {
      this.tauntT = 0;
      this.setState("taunt");
      this.world.emit({ t: "taunt", fighter: this.slot });
    }
    if (this.state === "taunt") {
      this.tauntT += dt;
      if (this.tauntT > 1.6) this.setState("neutral");
    }

    // guard
    const wantGuard = this.held(BTN.GUARD) && fx.locomotion !== "crawl";
    if ((this.state === "neutral" || this.state === "guard") && !this.stunned) {
      if (wantGuard && this.inj.stamina > 0) {
        if (this.state !== "guard") this.setState("guard");
      } else if (this.state === "guard") this.setState("neutral");
    }
    if (this.state === "guard") this.inj.spendStamina(0); // keeps regen delayed? no cost while idle guard
    this.guardW = approach(this.guardW, this.state === "guard" ? 1 : 0, 0.07, dt);

    // dodge
    if ((this.state === "neutral" || this.state === "guard" || this.state === "stagger" || (this.state === "attack" && this.attackInRecovery())) && this.pressed(BTN.DODGE) && this.dodgeCooldown <= 0 && !this.stunned) {
      this.tryDodge();
    }

    // interact: grab / drop / release
    if (this.pressed(BTN.INTERACT) && canAct) this.tryInteract();
    // throw
    if (this.pressed(BTN.THROW) && (this.state === "neutral" || this.state === "guard" || this.state === "grapple") && !this.stunned) this.tryThrow();

    // attacks
    if (canAct || (this.state === "grapple" && !this.move)) this.tryAttackInputs();
    if (this.state === "attack" && this.move) this.updateAttack(dt, animDt);

    // pickup
    if (this.state === "pickup") this.updatePickup(dt);
    if (this.state === "throw") this.updateThrow(dt);
    if (this.state === "dodge") this.updateDodge(dt);
    if (this.state === "grapple") this.updateGrapple(dt, animDt);
    if (this.state === "celebrate") this.celebrateT += dt;

    // ---- locomotion
    this.updateLocomotion(dt);

    // compose
    this.composeTargets(dt, false);
    void isHolding;
    void opp;
  }

  attackInRecovery(): boolean {
    if (!this.move) return false;
    const m = this.move;
    return this.moveT >= (m.windup + m.active) * 1.0 && this.moveT / this.moveScale > m.windup + m.active;
  }

  // ---------------------------------------------------------------- locomotion
  private updateLocomotion(dt: number) {
    const fx = this.fx;
    const intent = this.intent;
    let mx = intent.moveX,
      mz = intent.moveZ;
    const mlen = Math.hypot(mx, mz);
    if (mlen > 1) {
      mx /= mlen;
      mz /= mlen;
    }
    const mag = Math.min(1, mlen);
    let canMove = this.state === "neutral" || this.state === "guard" || this.state === "attack" || this.state === "taunt" || this.state === "pickup" || this.state === "throw" || this.state === "grapple" || this.state === "stagger" || this.state === "celebrate";
    if (this.stunned > 0) canMove = false;

    // facing
    let turnMult = 1;
    if (this.state === "attack" && this.move) turnMult = this.moveT / this.moveScale < this.move.windup ? this.move.turn : 0.1;
    else if (this.state === "stagger") turnMult = 0.2;
    else if (this.state === "dodge") turnMult = 0;
    else if (this.state === "taunt") turnMult = 0.4;
    else if (this.state === "grabbed") turnMult = 0;
    else if (this.state === "celebrate") turnMult = 0.3;
    if (fx.dazed) turnMult *= 0.7;
    const hasAim = intent.aimYaw !== undefined;
    let aim = hasAim ? intent.aimYaw : this.facing;
    if (!hasAim && mag > 0.1) aim = Math.atan2(mx, mz);
    const turnRate = this.def.turnRate * turnMult * (fx.locomotion === "crawl" ? 0.5 : 1);
    this.facing = wrapAngle(this.facing + clamp(wrapAngle(aim - this.facing), -turnRate * dt, turnRate * dt));

    // desired velocity
    let speed = lerp(this.def.walkSpeed, this.def.runSpeed, smoothstep(0.45, 1, mag));
    if (!fx.canRun) speed = Math.min(speed, this.def.walkSpeed * 1.05);
    speed *= fx.speedMult;
    if (this.state === "guard") speed *= 0.55;
    else if (this.state === "attack" && this.move) speed *= this.move.moveMult;
    else if (this.state === "stagger") speed *= 0.4;
    else if (this.state === "taunt") speed *= 0.3;
    else if (this.state === "pickup" || this.state === "throw") speed *= 0.35;
    else if (this.state === "grapple") speed *= 0.55;
    else if (this.state === "celebrate") speed *= 0.5;
    const carry = Math.max(this.heldMain ? this.heldMain.def.hindrance : 0, this.heldOff ? this.heldOff.def.hindrance : 0);
    speed *= 1 - carry * 0.45;
    if (this.state === "dodge") speed = 0;
    if (fx.dazed) speed *= 0.9;

    if (!canMove) {
      mx = 0;
      mz = 0;
    }
    if (mag > 0.05) {
      const fwdx = Math.sin(this.facing),
        fwdz = Math.cos(this.facing);
      const dir = (mx * fwdx + mz * fwdz) / Math.max(0.0001, Math.hypot(mx, mz));
      speed *= lerp(0.74, 1.0, (dir + 1) / 2);
    }
    const dx = mx * speed,
      dz = mz * speed;
    // accelerate
    const acc = this.def.accel * (this.state === "stagger" ? 0.5 : 1) * (mag > 0.05 ? 1 : 1.4);
    let ddx = dx - this.vel.x,
      ddz = dz - this.vel.z;
    const dl = Math.hypot(ddx, ddz);
    const maxd = acc * dt;
    if (dl > maxd) {
      ddx *= maxd / dl;
      ddz *= maxd / dl;
    }
    this.vel.x += ddx;
    this.vel.z += ddz;

    // dodge motion
    let ex = this.ext.x,
      ez = this.ext.z;
    if (this.state === "dodge") {
      const k = 1 - this.dodgeT / 0.5;
      const sp = 5.4 * (0.35 + 0.65 * k);
      ex += this.dodgeDir.x * sp;
      ez += this.dodgeDir.z * sp;
    }
    // attack lunge during active window
    if (this.state === "attack" && this.move) {
      const t = this.moveT / this.moveScale;
      if (t >= this.move.windup * 0.5 && t <= this.move.windup + this.move.active) {
        const fwdx = Math.sin(this.facing),
          fwdz = Math.cos(this.facing);
        ex += fwdx * this.move.lunge * (this.move.kind === "shoulder" ? 1 : 0.8);
        ez += fwdz * this.move.lunge * (this.move.kind === "shoulder" ? 1 : 0.8);
      }
    }

    // controller
    const support = this.cc.checkSupport(dt, DOWN);
    const cv = this.cc.getVelocity();
    _v1.set(this.vel.x + ex, 0, this.vel.z + ez);
    if (support.supportedState !== CharacterSupportedState.SUPPORTED) _v1.y = cv.y + GRAV.y * dt;
    this.cc.setVelocity(_v1);
    this.cc.integrate(dt, support, GRAV);
    const p = this.cc.getPosition();
    this.groundY = p.y - this.spec.capsule.height / 2 - 0.05;
    this.pos.set(p.x, this.groundY, p.z);

    // capsule size per locomotion
    const crawl = fx.locomotion === "crawl";
    if (crawl !== this.capLowered) {
      this.capLowered = crawl;
      const h = crawl ? this.spec.capsule.height * 0.4 : this.spec.capsule.height;
      this.cc.setShapeOptions({ capsuleHeight: h, capsuleRadius: this.spec.capsule.radius }, true);
      this.cc.footOffset = h / 2;
      const s = this.cc.shape as PhysicsShapeCapsule;
      s.filterMembershipMask = capGroup(this.slot);
      s.filterCollideMask = capCollideMask(this.slot);
    }
    this.lastLoco = fx.locomotion;
  }

  // ---------------------------------------------------------------- dodge
  private tryDodge() {
    const fx = this.fx;
    if (!fx.canDodge) return;
    if (this.inj.stamina < 14) return;
    this.inj.spendStamina(18);
    let mx = this.intent.moveX,
      mz = this.intent.moveZ;
    const l = Math.hypot(mx, mz);
    if (l < 0.2) {
      // back-step
      mx = -Math.sin(this.facing);
      mz = -Math.cos(this.facing);
    } else {
      mx /= l;
      mz /= l;
    }
    this.dodgeDir.set(mx, 0, mz);
    this.dodgeT = 0.5;
    this.iframes = 0.2;
    this.dodgeCooldown = 0.75;
    this.move = null;
    this.setState("dodge");
    // a stagger can be recovered by a dodge: restore a chunk of balance
    this.inj.balance = Math.min(100, this.inj.balance + 25);
  }
  private updateDodge(dt: number) {
    this.dodgeT -= dt;
    if (this.dodgeT <= 0) this.setState("neutral");
  }

  // ---------------------------------------------------------------- interact
  private tryInteract() {
    if (this.heldMain || this.heldOff) {
      this.world.props.releaseAll(this, "drop");
      return;
    }
    const h = this.highlight;
    if (!h) return;
    if (h.kind === "prop") {
      const prop = this.world.props.byId.get(h.id);
      if (prop && this.world.props.canPickUp(this, prop)) {
        this.pickupTarget = prop;
        this.pickupT = 0;
        this.setState("pickup");
      }
    } else if (h.kind === "fighter") {
      this.world.grapples.tryStart(this);
    }
  }
  private updatePickup(dt: number) {
    this.pickupT += dt;
    const prop = this.pickupTarget;
    if (!prop || prop.removed || prop.holder) {
      this.pickupTarget = null;
      this.setState("neutral");
      return;
    }
    if (this.pickupT >= 0.22 && !this.heldMain && !this.heldOff) {
      this.world.props.grab(this, prop);
    }
    if (this.pickupT >= 0.4) {
      this.pickupTarget = null;
      this.setState("neutral");
    }
  }
  private tryThrow() {
    if (this.state === "grapple" && this.grappleOther) {
      this.throwKind = "fighter";
      this.throwT = 0;
      this.setState("throw");
      return;
    }
    if (this.heldMain || this.heldOff) {
      this.throwKind = "prop";
      this.throwT = 0;
      this.setState("throw");
    }
  }
  private updateThrow(dt: number) {
    this.throwT += dt;
    const release = this.throwKind === "fighter" ? 0.3 : 0.2;
    if (this.throwT >= release && !this.throwDone) {
      this.throwDone = true;
      if (this.throwKind === "fighter") this.world.grapples.throwHeld(this);
      else this.world.props.throwHeld(this);
    }
    if (this.throwT >= release + 0.28) {
      this.throwDone = false;
      this.setState("neutral");
    }
  }
  throwDone = false;

  // ---------------------------------------------------------------- attacks
  private tryAttackInputs() {
    if (this.cooldownAttack > 0 || this.state === "attack") return;
    if (this.fx.mustCrawl) return;
    const wpn = this.heldMain ?? this.heldOff;
    const wdef = wpn?.def;
    const inGrapple = this.state === "grapple";

    if (inGrapple) {
      if (this.pressed(BTN.LIGHT) || this.pressed(BTN.HEAVY)) this.startMove(this.pressed(BTN.HEAVY) ? "grappleHead" : "grappleKnee", 0);
      return;
    }
    if (this.pressed(BTN.LIGHT)) {
      if (wdef && wdef.swing !== "none") {
        if (wdef.swing === "throwOnly") {
          this.throwKind = "prop";
          this.throwT = 0;
          this.setState("throw");
        } else this.startWeaponMove(false);
        return;
      }
      const chain = this.comboIdx > 0 && this.world.time - this.lastAttackEnd < 0.45;
      const id = chain ? (this.comboIdx === 1 ? "cross" : this.comboIdx === 2 ? "hook" : "jab") : "jab";
      this.comboIdx = chain ? (this.comboIdx >= 3 ? 1 : this.comboIdx + 1) : 1;
      this.startMove(id, 0);
    } else if (this.pressed(BTN.HEAVY)) {
      if (wdef && wdef.swing !== "none" && wdef.swing !== "throwOnly") this.startWeaponMove(true);
      else this.startMove("heavy", 0);
    } else if (this.pressed(BTN.KICK)) {
      const opp = this.opponent;
      const d = Math.hypot(opp.pos.x - this.pos.x, opp.pos.z - this.pos.z);
      const spd = Math.hypot(this.vel.x, this.vel.z);
      if (wdef?.swing === "shield" || (wdef?.guard && wdef.guard.strength > 0.5)) this.startWeaponMove(false, "bashShield");
      else if (spd > this.def.runSpeed * 0.7 && this.fx.canRun) this.startMove("shoulder", 0);
      else if (d < 1.25 && opp.state !== "ragdoll") this.startMove("shove", 0);
      else this.startMove("kick", 0);
    }
  }

  startWeaponMove(heavy: boolean, force?: string) {
    const wpn = this.heldMain ?? this.heldOff!;
    const style = wpn.def.swing;
    let id = force ?? "swingClub";
    if (!force) {
      if (style === "thrust") id = heavy ? "swingOverhead" : "thrust";
      else if (style === "smash") id = "swingOverhead";
      else if (style === "shield") id = "bashShield";
      else id = heavy ? "swingOverhead" : "swingClub";
    }
    this.moveWeapon = wpn;
    this.startMove(id, 0, wpn);
  }

  startMove(id: string, _unused: number, weapon?: Prop) {
    const m = MOVES[id];
    if (!m) return;
    if (this.inj.stamina < 2 && m.stamina > 0) {
      // exhausted: allow a weak attempt but with penalty
    }
    const fx = this.fx;
    // injury gating: need a functioning striker
    const strikeSide = m.strike.endsWith("L") ? "L" : m.strike.endsWith("R") ? "R" : null;
    const mirrored = m.side === "L";
    if (m.strike.startsWith("hand") || m.strike === "weapon") {
      const sideFn = (mirrored ? fx.armL : fx.armR) as number;
      if (sideFn < 0.12 && m.strike !== "weapon") {
        // authored side unusable: swap to the other arm if it works
        const other = mirrored ? fx.armR : fx.armL;
        if (other < 0.12) return;
      }
    }
    void strikeSide;
    this.move = m;
    this.moveT = 0;
    this.moveHeight = this.intent.height;
    this.moveCharge = 0;
    this.moveCharging = !!m.chargeable && this.held(m.id === "heavy" || m.id === "swingOverhead" ? BTN.HEAVY : 0);
    this.moveWeapon = weapon ?? null;
    this.attackId++;
    this.hitThisAttack.clear();
    this.chainQueued = false;
    let scale = m.kind === "heavy" ? this.def.heavyTempo : this.def.lightTempo;
    if (weapon) scale = (scale * 1) / weapon.def.damage.swingTime;
    // exhausted fighters are slower
    if (this.inj.stamina <= 0) scale *= 0.8;
    // weak arm slows swings
    this.moveScale = clamp(scale, 0.45, 1.6);
    const cost = (weapon ? weapon.def.damage.stamina : m.stamina) * (this.def.stamina > 1 ? 0.9 : 1);
    this.inj.spendStamina(cost);
    this.world.emit({ t: "swing", attacker: this.slot, kind: m.kind, heavy: m.kind === "heavy", weaponId: weapon?.def.id ?? null, pos: [this.pos.x, this.pos.y + 1.2, this.pos.z] });
    if (this.state !== "grapple") this.setState("attack");
    this.grappleStrikeQueued = this.state === "grapple";
  }

  private updateAttack(dt: number, animDt: number) {
    const m = this.move!;
    // charging holds the animation at the end of windup
    const total = m.windup + m.active + m.recovery;
    let tEff = this.moveT / this.moveScale;
    if (this.moveCharging && m.chargeable) {
      const holdBtn = m.id === "heavy" || m.id === "swingOverhead" ? BTN.HEAVY : 0;
      if (this.held(holdBtn) && this.moveCharge < 0.9 && tEff >= m.windup * 0.98) {
        this.moveCharge += dt;
        this.inj.spendStamina(dt * 5);
        // hold at end of windup
        this.moveT = m.windup * this.moveScale * 0.985;
        return;
      }
      if (tEff >= m.windup * 0.98) this.moveCharging = false;
    }
    this.moveT += animDt;
    tEff = this.moveT / this.moveScale;
    // chain buffering: pressing light during recovery queues next
    if (m.chain && this.pressed(BTN.LIGHT) && tEff > m.windup) this.chainQueued = true;
    if (tEff >= total) {
      this.endMove();
      return;
    }
    if (m.chain && this.chainQueued && tEff > m.windup + m.active + m.recovery * 0.35) {
      // cut recovery short and chain
      const next = m.chain;
      this.comboIdx = next === "cross" ? 2 : next === "hook" ? 3 : 1;
      this.startMove(next, 0);
    }
  }
  chargeRatio(): number {
    return this.moveCharging || (this.move?.chargeable && this.moveCharge > 0) ? clamp01(this.moveCharge / 0.9) : 0;
  }
  private endMove() {
    const wasGrapple = this.grappleRole === "holder";
    this.move = null;
    this.moveWeapon = null;
    this.lastAttackEnd = this.world.time;
    this.cooldownAttack = 0.06;
    if (wasGrapple && this.grappleOther) this.setState("grapple");
    else this.setState(this.held(BTN.GUARD) ? "guard" : "neutral");
  }
  /** Strike window active this tick? */
  strikeActive(): boolean {
    if (this.state !== "attack" && !(this.state === "grapple" && this.move)) return false;
    const m = this.move;
    if (!m || this.hitStop > 0) return false;
    const t = this.moveT / this.moveScale;
    return t >= m.windup && t <= m.windup + m.active;
  }
  /** True during windup, to telegraph. */
  telegraphing(): boolean {
    const m = this.move;
    return !!m && this.moveT / this.moveScale < m.windup;
  }

  // ---------------------------------------------------------------- grapple (holder side)
  private updateGrapple(dt: number, animDt: number) {
    const other = this.grappleOther;
    if (!other || this.grappleRole !== "holder") {
      this.setState("neutral");
      return;
    }
    // grapple strikes use the shared attack timeline
    if (this.move) this.updateAttack(dt, animDt);
  }

  // ---------------------------------------------------------------- ragdoll
  enterRagdoll(kind: RagKind, impulse: Vector3 | null, thrownByFighter = -1) {
    if (this.state === "ragdoll" && this.ragKind === kind) {
      if (impulse) this.rig.pelvis.setLinearVelocity(this.rig.pelvis.getLinearVelocity().add(impulse));
      return;
    }
    this.releaseGrabsOnRagdoll(kind);
    const wasKinematic = this.rig.isRootKinematic;
    // transfer controller velocity to the dynamic pelvis explicitly
    const cv = this.cc.getVelocity();
    _v1.set(this.vel.x + this.ext.x, Math.max(0, cv.y), this.vel.z + this.ext.z);
    if (impulse) _v1.addInPlace(impulse);
    this.ragKind = kind;
    this.ragT = 0;
    this.settleT = 0;
    this.thrownBy = thrownByFighter;
    this.thrownT = 0;
    this.move = null;
    this.moveWeapon = null;
    this.guardW = 0;
    this.setState("ragdoll");
    this.rig.setRootKinematic(false, _v1);
    if (!wasKinematic) {
      // already dynamic: nothing to hand over
    }
    // park the movement capsule away so it doesn't block anybody
    this.cc.setPosition(new Vector3(this.pos.x, -60, this.pos.z));
    this.cc.setVelocity(Vector3.Zero());
    // seed every limb with the root's linear velocity so the whole body leaves together
    for (let i = 1; i < RIG_COUNT; i++) {
      if (this.rig.attached[i]) this.rig.bodies[i].setLinearVelocity(_v1);
    }
    this.applyRagdollTone();
    if (impulse) {
      // spin a bit for comedy and readability
      const spin = _v2.set(-impulse.z, 0, impulse.x).scaleInPlace(0.35);
      this.rig.pelvis.setAngularVelocity(spin);
    }
    this.vel.setAll(0);
    this.ext.setAll(0);
  }

  private releaseGrabsOnRagdoll(kind: RagKind) {
    // being knocked down drops weapons only for hard states
    if (kind !== "knockdown") this.world.props.releaseAll(this, "knocked out");
    else this.world.props.maybeDropOnKnockdown(this);
    if (this.grappleOther) this.world.grapples.end(this, "ragdoll");
  }

  applyRagdollTone() {
    const k = this.ragKind;
    const t = this.rig.tone;
    if (k === "knockdown" || k === "thrown") {
      for (let i = 0; i < RIG_COUNT; i++) t[i] = this.ragT < 0.35 ? 0.0 : 0.12;
    } else t.fill(0);
  }

  private updateRagdoll(dt: number) {
    this.ragT += dt;
    this.thrownT += dt;
    if (this.ragKind === "knockdown" || this.ragKind === "thrown") {
      // light bracing after the initial tumble
      const bracing = this.ragT > 0.35 ? 0.1 : 0;
      for (let i = 0; i < RIG_COUNT; i++) this.rig.tone[i] = bracing;
    }
    const pv = this.rig.pelvis.getLinearVelocity();
    const settled = pv.length() < 1.0;
    this.settleT = settled ? this.settleT + dt : 0;
    // feed pose targets so bracing has something sensible to chase
    this.pose.clearEuler();
    this.composeRagdollTargets();

    // conscious fighters get up
    if (this.inj.consciousness === "awake" || this.inj.consciousness === "dazed") {
      if ((this.ragKind === "knockdown" || this.ragKind === "thrown" || this.ragKind === "limp") && this.ragT > 0.7 && this.settleT > 0.35) {
        this.beginGetUp();
      }
      // recovering from blackout lands in "limp" kind
    }
    // keep capsule parked below the pelvis for later
    this.pos.set(this.rootPos.x, this.groundY, this.rootPos.z);
  }

  private composeRagdollTargets() {
    // bracing target: arms slightly forward, everything else neutral
    this.cur.copyFrom(this.stance);
    this.cur.setPose(POSES.dazed.j, 0.4);
    this.layerToPose(this.cur, this.rootPos, this.rig.nodes[0].rotationQuaternion!);
    this.rig.computeTargets(this.pose);
  }

  private beginGetUp() {
    const p = this.rootPos;
    const q = this.rig.nodes[0].rotationQuaternion!;
    // classify lying orientation from the chest's front axis and the pelvis
    const chestQ = this.rig.nodes[RIG_INDEX.chest].rotationQuaternion!;
    _v1.set(0, 0, 1).rotateByQuaternionToRef(chestQ, _v1); // chest front
    _v2.set(0, 1, 0).rotateByQuaternionToRef(chestQ, _v2); // chest up
    let kind = "side";
    if (_v1.y < -0.45) kind = "supine"; // front points down?? front down = prone
    // chest front pointing up -> lying on back (supine); down -> prone
    if (_v1.y > 0.45) kind = "supine";
    else if (_v1.y < -0.45) kind = "prone";
    else kind = "side";
    // near furniture/wall?
    if (this.world.nearSolid(p, 0.75)) kind = "furniture";
    if (this.intent.buttons & BTN.DODGE && this.fx.canDodge && this.inj.stamina > 20) {
      kind = "roll";
      this.inj.spendStamina(15);
    }
    if (this.fx.mustCrawl) kind = "roll";
    this.getupKind = kind;
    this.getupT = 0;
    this.getupFrom.copyFrom(p);
    this.getupFromQ.copyFrom(q);
    // face the direction of the current heading projected to the floor
    _v3.set(0, 0, 1).rotateByQuaternionToRef(chestQ, _v3);
    this.getupFromYaw = this.facing;
    this.facing = kind === "supine" || kind === "side" ? this.heading() : this.heading();
    this.setState("getup");
    this.rig.setRootKinematic(true);
    this.rig.tone.fill(0.6);
  }

  /** Approximate heading of a lying body from its pelvis forward axis. */
  private heading(): number {
    _v1.set(0, 0, 1).rotateByQuaternionToRef(this.rig.nodes[0].rotationQuaternion!, _v1);
    _v2.set(0, 1, 0).rotateByQuaternionToRef(this.rig.nodes[0].rotationQuaternion!, _v2);
    // use the horizontal part of forward; if forward is vertical use up axis' horizontal part
    let x = _v1.x,
      z = _v1.z;
    if (Math.hypot(x, z) < 0.3) {
      x = -_v2.x * Math.sign(_v1.y || 1);
      z = -_v2.z * Math.sign(_v1.y || 1);
    }
    if (Math.hypot(x, z) < 0.05) return this.facing;
    return Math.atan2(x, z);
  }

  private updateGetUp(dt: number) {
    const def = GETUPS[this.getupKind] ?? GETUPS.supine;
    this.getupT += dt * (this.fx.locomotion === "limp" ? 0.85 : this.fx.locomotion === "hop" ? 0.7 : 1);
    const t = this.getupT;
    const done = t >= def.duration;
    // sample keys for pose + height
    let i = 0;
    while (i < def.keys.length - 2 && def.keys[i + 1].t <= t) i++;
    const a = def.keys[i],
      b = def.keys[Math.min(i + 1, def.keys.length - 1)];
    const u = easeInOut(clamp01((t - a.t) / Math.max(1e-4, b.t - a.t)));
    const h = lerp(a.h, b.h, u);
    // pose
    this.tmp.copyFrom(this.stance);
    this.cur.copyFrom(this.stance);
    this.cur.setPose(a.j, 1);
    this.tmp.copyFrom(this.stance);
    this.tmp.setPose(b.j, 1);
    this.cur.lerpTo(this.tmp, u);
    const ra = a.r,
      rb = b.r;
    this.cur.root.clear();
    this.cur.root.addKey(ra, 1 - u, false);
    this.cur.root.addKey(rb, u, false);
    this.cur.root.drop = lerp(ra?.drop ?? 0, rb?.drop ?? 0, u);
    // root: interpolate from the lying pelvis transform to a standing target
    const standY = this.groundY + this.spec.pelvisHeight - this.cur.root.drop;
    const lyingY = this.getupFrom.y;
    const y = lerp(lyingY, standY, easeInOut(h));
    // blend rotation: lying quaternion -> upright yaw
    quatUpright(this.facing, this.cur.root.lean * DEG * 0.3, _q1);
    const k = easeInOut(clamp01(h * 1.6));
    Quaternion.SlerpToRef(this.getupFromQ, _q1, k, _q1);
    this.pose.rootPos.set(this.getupFrom.x, y, this.getupFrom.z);
    this.pose.rootQ.copyFrom(_q1);
    // layer -> euler (but root rotation already applied; strip root lean)
    this.layerToPoseEuler(this.cur);
    this.rig.computeTargets(this.pose);
    // drive: kinematic pelvis follows the scripted curve
    this.rig.setRootTarget(this.pose.rootPos, this.rig.target.q[0]);
    // tone ramps up as we rise
    const tone = 0.35 + 0.65 * h;
    for (let j = 0; j < RIG_COUNT; j++) this.rig.tone[j] = tone;
    this.groundY = this.groundYAt(this.getupFrom.x, this.getupFrom.z);
    this.pos.set(this.getupFrom.x, this.groundY, this.getupFrom.z);
    if (done) this.finishGetUp();
  }

  private groundYAt(_x: number, _z: number) {
    return this.world.floorY;
  }

  private finishGetUp() {
    const cap = this.capLowered ? this.spec.capsule.height * 0.4 : this.spec.capsule.height;
    // restore the movement capsule at the pelvis position; control returns to the character controller
    this.cc.setPosition(new Vector3(this.getupFrom.x, this.groundY + cap / 2 + 0.06, this.getupFrom.z));
    this.cc.setVelocity(Vector3.Zero());
    this.pos.set(this.getupFrom.x, this.groundY, this.getupFrom.z);
    this.gait.reset(this.getupFrom.x, this.getupFrom.z, this.facing, this.groundY);
    this.vel.setAll(0);
    this.ext.setAll(0);
    this.recoveryProtect = INJURY.getUpProtectionSeconds;
    this.cur.copyFrom(this.stance);
    this.from.copyFrom(this.stance);
    this.blendT = 1;
    this.rig.setRootKinematic(true);
    this.setState("neutral");
  }

  // ---------------------------------------------------------------- stagger / hit reaction
  enterStagger(duration: number) {
    if (this.state === "ragdoll" || this.state === "getup" || this.dead) return;
    if (this.state === "grapple" || this.state === "grabbed") {
      return;
    }
    this.staggerT = Math.max(this.staggerT, duration);
    this.move = null;
    this.moveWeapon = null;
    this.setState("stagger");
  }

  // ---------------------------------------------------------------- pose composition
  private layerToPoseEuler(layer: Layer) {
    const e = this.pose.euler;
    e.set(layer.e);
    const r = layer.root;
    const leanR = r.lean * DEG,
      twistR = r.twist * DEG,
      sideR = r.side * DEG;
    const iP = RIG_INDEX.pelvis * 3,
      iS = RIG_INDEX.spine * 3,
      iC = RIG_INDEX.chest * 3;
    e[iP] += leanR * 0.3;
    e[iP + 2] += sideR * 0.3;
    e[iS] += leanR * 0.3;
    e[iS + 1] += twistR * 0.4;
    e[iS + 2] += sideR * 0.3;
    e[iC] += leanR * 0.4;
    e[iC + 1] += twistR * 0.6;
    e[iC + 2] += sideR * 0.4;
    // clamp every joint to its rest-frame limits (targets must never fight joint limits)
    for (let i = 1; i < RIG_COUNT; i++) {
      const lim = this.spec.bodies[i].limits;
      const m = 0.03;
      const cl = (v: number, r: readonly [number, number] | undefined) => (r ? clamp(v, r[0] + m, r[1] - m) : 0);
      e[i * 3] = cl(e[i * 3], lim.x);
      e[i * 3 + 1] = cl(e[i * 3 + 1], lim.y);
      e[i * 3 + 2] = cl(e[i * 3 + 2], lim.z);
    }
  }

  private layerToPose(layer: Layer, rootPos: Vector3, rootQ: Quaternion) {
    this.layerToPoseEuler(layer);
    this.pose.rootPos.copyFrom(rootPos);
    this.pose.rootQ.copyFrom(rootQ);
  }

  /** Builds `this.cur` from the current state. */
  private buildStatePose(dt: number) {
    const cur = this.cur;
    const fx = this.fx;
    cur.copyFrom(this.stance);
    const speed = Math.hypot(this.vel.x + this.ext.x, this.vel.z + this.ext.z);
    const gaitSpd = this.gait.speed;

    // --- locomotion overlay (arm swing & bob) for upright movement states
    const swingable = this.state === "neutral" || this.state === "guard" || this.state === "stagger";
    const phase = this.gait.travel * 2.4;
    if (swingable && speed > 0.2) {
      const a = Math.min(1, speed / 3.2);
      const sw = Math.sin(phase) * 0.55 * a;
      cur.add("upperArmR", sw * 0.7, 0, 0);
      cur.add("upperArmL", -sw * 0.7, 0, 0);
      cur.add("forearmR", -Math.max(0, sw) * 0.4, 0, 0);
      cur.add("forearmL", -Math.max(0, -sw) * 0.4, 0, 0);
      cur.add("chest", 0, -Math.sin(phase) * 0.12 * a, 0);
      cur.add("spine", 0, Math.sin(phase) * 0.06 * a, 0);
      cur.root.lean += 5 * a * (this.def.build === "bruiser" ? 0.8 : 1.2);
      cur.root.drop += Math.abs(Math.sin(phase)) * 0.022 * a;
    }
    // idle breathing / bounce
    const bounce = this.def.stance === "bouncy" ? 0.012 : 0.006;
    cur.root.drop += Math.sin(this.breath * (this.def.stance === "bouncy" ? 7 : 2.2)) * bounce * (1 - Math.min(1, speed));
    cur.add("chest", Math.sin(this.breath * 2) * 0.012, 0, 0);

    // --- held prop carry pose
    const main = this.heldMain,
      off = this.heldOff;
    if (main && this.state !== "attack") {
      const twoH = off === main || (main.holders.off === this);
      if (main.def.weight === "medium" && main.def.hands === 2) cur.setPose(POSES.carryHeavy.j, 0.9), cur.root.addKey(POSES.carryHeavy.r, 0.9, false);
      else if (twoH || main.def.hands === 2) cur.setPose(POSES.carry2H.j, 1);
      else cur.setPose(POSES.carry1H.j, 1);
      if (main.def.guard && (main.def.swing === "shield" || main.def.id === "lid")) {
        // shield carried on the left arm for natural look
        cur.setPose(POSES.carry1H.j, 1, true);
        const i = RIG_INDEX.upperArmR * 3;
        void i;
      }
    }

    switch (this.state) {
      case "attack": {
        const m = this.move!;
        const t = this.moveT / this.moveScale;
        // base for inherited joints: stance + carry pose
        this.tmp.copyFrom(cur);
        sampleMove(m, t, this.tmp, cur, 1);
        // height emphasis bumps around the strike
        if (m.heightMod && this.moveHeight !== 0) {
          const w = bump(t, m.windup * 0.5, m.windup + m.active + m.recovery * 0.3) * this.moveHeight;
          cur.addPose(m.heightMod, w, m.side === "L");
          if (m.heightRoot) cur.root.addKey(m.heightRoot, w, m.side === "L");
        } else if (this.moveHeight === -1 && (m.kind === "jab" || m.kind === "cross" || m.kind === "hook" || m.kind === "heavy")) {
          const w = bump(t, m.windup * 0.5, m.windup + m.active + m.recovery * 0.3);
          cur.root.drop += 0.1 * w;
          cur.root.lean += 8 * w;
        }
        // two-handed grip: off arm mirrors the main arm
        if (this.heldMain && this.heldMain.def.hands === 1 && this.heldOff === this.heldMain) this.mirrorArm(cur);
        if (this.heldMain?.holders.off === this) this.mirrorArm(cur);
        if (this.chargeRatio() > 0) {
          const c = this.chargeRatio();
          cur.root.drop += 0.04 * c;
          cur.root.lean -= 4 * c;
          cur.add("upperArmR", -0.1 * c, 0, 0);
        }
        break;
      }
      case "guard": {
        const shield = this.heldMain?.def.guard && this.heldMain.def.swing === "shield";
        const g = shield ? POSES.guardShield : POSES.guardFists;
        this.tmp.copyFrom(cur);
        cur.setPose(g.j, this.guardW);
        cur.root.addKey(g.r, this.guardW, false);
        break;
      }
      case "dodge": {
        const k = 1 - this.dodgeT / 0.5;
        const w = Math.sin(clamp01(k) * Math.PI);
        cur.root.drop += 0.22 * w;
        cur.root.lean += 26 * w;
        // lean into the dodge direction relative to facing
        const fx2 = Math.sin(this.facing),
          fz2 = Math.cos(this.facing);
        const side = this.dodgeDir.x * fz2 - this.dodgeDir.z * fx2;
        cur.root.side += -side * 26 * w;
        cur.setPose(POSES.guardFists.j, 0.6 * w);
        break;
      }
      case "stagger": {
        const w = clamp01(this.staggerT / 0.3 + 0.4);
        cur.setPose(POSES.stagger.j, w);
        cur.root.addKey(POSES.stagger.r, w, false);
        cur.root.twist += Math.sin(this.stateT * 18) * 6 * w;
        break;
      }
      case "pickup": {
        const w = Math.sin(clamp01(this.pickupT / 0.4) * Math.PI);
        cur.setPose(POSES.reachDown.j, w);
        cur.root.addKey(POSES.reachDown.r, w, false);
        break;
      }
      case "throw": {
        const isF = this.throwKind === "fighter";
        const wind = isF ? POSES.throwFighterWind : POSES.throwWind;
        const rel = isF ? POSES.throwFighterRelease : POSES.throwRelease;
        const rt = isF ? 0.3 : 0.2;
        if (this.throwT < rt) {
          const w = easeInOut(this.throwT / rt);
          cur.setPose(wind.j, w);
          cur.root.addKey(wind.r, w, false);
        } else {
          const w = easeInOut(clamp01((this.throwT - rt) / 0.1));
          this.tmp.copyFrom(cur);
          cur.setPose(wind.j, 1);
          this.tmp.setPose(rel.j, 1);
          cur.lerpTo(this.tmp, w);
          cur.root.clear();
          cur.root.addKey(wind.r, 1 - w, false);
          cur.root.addKey(rel.r, w, false);
        }
        break;
      }
      case "grapple": {
        cur.setPose(POSES.holdFighter.j, 1);
        cur.root.addKey(POSES.holdFighter.r, 1, false);
        if (this.move) {
          this.tmp.copyFrom(cur);
          sampleMove(this.move, this.moveT / this.moveScale, this.tmp, cur, 1);
        }
        // strain tremble
        const s = this.grappleStrain;
        cur.add("upperArmR", Math.sin(this.stateT * 40) * 0.03 * s, 0, 0);
        cur.add("upperArmL", Math.sin(this.stateT * 43) * 0.03 * s, 0, 0);
        break;
      }
      case "grabbed": {
        cur.setPose(POSES.grabbed.j, 1);
        cur.root.addKey(POSES.grabbed.r, 1, false);
        cur.add("chest", 0, Math.sin(this.stateT * 22) * 0.08, 0);
        break;
      }
      case "taunt": {
        const poseSrc = this.def.taunt === "flex" ? POSES.tauntFlex : POSES.tauntFlair;
        const w = Math.sin(clamp01(this.tauntT / 1.6) * Math.PI);
        const ww = clamp01(w * 2.5);
        cur.setPose(poseSrc.j, ww);
        cur.root.addKey(poseSrc.r, ww, false);
        cur.root.drop += Math.abs(Math.sin(this.tauntT * 9)) * 0.03 * ww;
        if (this.def.taunt === "flair") cur.add("chest", 0, Math.sin(this.tauntT * 6) * 0.3 * ww, 0);
        break;
      }
      case "celebrate": {
        const p = this.celebrateKind % 2 === 0 ? POSES.celebrateA : POSES.celebrateB;
        const w = clamp01(this.celebrateT / 0.35);
        cur.setPose(p.j, w);
        cur.root.addKey(p.r, w, false);
        cur.root.drop += Math.abs(Math.sin(this.celebrateT * 8)) * 0.05 * w;
        break;
      }
      default:
        break;
    }

    // --- injury overlays (arms, torso, head)
    if (this.state !== "attack" || true) {
      this.injuryOverlay(cur, this.state === "attack" || this.state === "throw" || this.state === "grapple");
    }
    void dt;
    void gaitSpd;
    void fx;
  }

  private mirrorArm(cur: Layer) {
    for (let k = 0; k < 3; k++) {
      const names: [RigBody, RigBody][] = [
        ["upperArmR", "upperArmL"],
        ["forearmR", "forearmL"],
        ["handR", "handL"],
      ];
      for (const [r, l] of names) {
        const ir = RIG_INDEX[r] * 3,
          il = RIG_INDEX[l] * 3;
        cur.e[il + k] = (k === 0 ? 1 : -1) * cur.e[ir + k] * (k === 2 ? 0.8 : 1);
      }
    }
  }

  private injuryOverlay(cur: Layer, acting: boolean) {
    const fx = this.fx,
      inj = this.inj;
    for (const side of ["L", "R"] as const) {
      const fn = side === "L" ? fx.armL : fx.armR;
      const limb = side === "L" ? "armL" : "armR";
      if (!inj.attached[limb]) continue;
      const lvl = inj.limbLevel(limb);
      if (lvl >= 2 && !(acting && fn > 0.5)) {
        const src = lvl >= 3 ? POSES.armHang : POSES.armCradle;
        cur.setPose(src.j, acting ? 0.5 : 0.95, side === "L");
      }
    }
    const torso = Math.max(inj.level("chest"), inj.level("abdomen"));
    if (torso >= 2 && !acting) {
      cur.root.lean += 8;
      cur.root.drop += 0.03;
      cur.setPose(POSES.ribsClutch.j, torso >= 3 ? 0.55 : 0.3);
    }
    if (fx.dazed) {
      cur.add("head", Math.sin(this.breath * 3) * 0.15 + 0.12, 0, Math.sin(this.breath * 2.3) * 0.18);
      cur.root.side += Math.sin(this.breath * 2.1) * 6;
    }
    if (inj.consciousness === "dazed" && !acting) cur.setPose(POSES.dazed.j, 0.3);
    // limp pelvis tilt
    if (fx.limpSide !== 0 && fx.locomotion === "limp") {
      cur.root.side += fx.limpSide * 4;
      cur.root.drop += 0.025;
    }
  }

  /** Compose pose + IK into rig targets. */
  composeTargets(dt: number, snap: boolean) {
    const fx = this.fx;
    if (this.state === "ragdoll" || this.state === "getup") return;
    // state pose
    this.buildStatePose(dt);
    // transition blend
    if (this.blendT < 1) this.cur.lerpTo(this.from, 0), this.blendLayers();
    else this.from.copyFrom(this.cur);
    const cur = this.cur;

    // pelvis target
    const yaw = this.facing + cur.root.yaw * DEG;
    const fwd = cur.root.fwd;
    const drop = cur.root.drop * (fx.locomotion === "crawl" ? 0 : 1);
    let ph = this.spec.pelvisHeight - drop;
    let hopBob = 0;
    if (fx.locomotion === "hop") hopBob = Math.abs(Math.sin(this.gait.travel * 3.4)) * 0.07;
    ph += hopBob;
    if (fx.locomotion === "crawl") ph = this.spec.pelvisHeight * 0.34;
    if (this.state === "dodge") ph = Math.max(ph, this.spec.pelvisHeight * 0.55);
    const px = this.pos.x + Math.sin(yaw) * fwd;
    const pz = this.pos.z + Math.cos(yaw) * fwd;
    this.pose.rootPos.set(px, this.groundY + ph, pz);
    quatUpright(yaw, 0, this.pose.rootQ);
    this.layerToPoseEuler(cur);

    // crawl overrides
    if (fx.locomotion === "crawl") this.applyCrawlPose();

    this.rig.computeTargets(this.pose);

    // ---- legs: IK for planted/stepping, FK for kicks / disabled
    const fkLegs = this.state === "attack" && this.move?.fkLegs ? this.move.fkLegs : null;
    const speedV = Math.hypot(this.vel.x + this.ext.x, this.vel.z + this.ext.z);
    const gaitFrozen = this.state === "attack" || this.state === "throw" || this.state === "pickup" ? speedV < 0.4 : false;
    const hopping = fx.locomotion === "hop";
    const badSide: 0 | 1 | -1 = fx.legL < fx.legR ? 0 : 1;
    const enabled: [boolean, boolean] = [this.inj.attached.legL, this.inj.attached.legR];
    if (hopping) enabled[badSide] = false;
    if (fkLegs === "L" || fkLegs === "both") enabled[0] = false;
    if (fkLegs === "R" || fkLegs === "both") enabled[1] = false;
    const bothEnabled = enabled[0] && enabled[1];
    const stagger = this.def.stance === "bouncy" ? 0.16 : 0.1;
    this.gait.update({
      vx: this.vel.x + this.ext.x,
      vz: this.vel.z + this.ext.z,
      yaw: this.facing,
      rootX: this.pos.x,
      rootZ: this.pos.z,
      groundY: this.groundY,
      stance: (this.def.stance === "heavy" ? 1.28 : 1.0) * (this.state === "guard" ? 1.1 : 1) * (this.state === "attack" ? 1.15 : 1),
      stagger: this.state === "attack" || this.state === "guard" ? stagger * 2 : stagger,
      enabled,
      stepScale: fx.locomotion === "limp" ? 0.8 : 1,
      dt: Math.max(dt, 1e-4),
      freeze: gaitFrozen,
    });
    if (fx.locomotion !== "crawl") this.solveLegs(enabled, fkLegs, hopping ? badSide : -1);
    void bothEnabled;
    void snap;
  }

  private blendLayers() {
    // cur currently holds the new pose; blend from -> cur by blendT (smoothstep)
    const t = easeInOut(this.blendT);
    this.tmp.copyFrom(this.from);
    this.tmp.lerpTo(this.cur, t);
    this.cur.copyFrom(this.tmp);
  }

  private applyCrawlPose() {
    // hands-and-knees: override arms/legs with FK crawl cycle
    const e = this.pose.euler;
    const set = (b: RigBody, rx: number, ry = 0, rz = 0) => {
      const i = RIG_INDEX[b] * 3;
      e[i] = rx;
      e[i + 1] = ry;
      e[i + 2] = rz;
    };
    const ph = this.gait.travel * 5;
    const mv = Math.min(1, Math.hypot(this.vel.x, this.vel.z) / 0.6);
    set("pelvis", 1.2, 0, 0);
    set("spine", -0.2, 0, 0);
    set("chest", -0.2, 0, 0);
    set("head", -0.5, 0, 0);
    set("upperArmR", -1.45 + Math.sin(ph) * 0.35 * mv, 0.1, 0.18);
    set("upperArmL", -1.45 - Math.sin(ph) * 0.35 * mv, -0.1, -0.18);
    set("forearmR", -0.3, 0, 0);
    set("forearmL", -0.3, 0, 0);
    set("thighR", -1.1 - Math.sin(ph) * 0.25 * mv, 0, 0.1);
    set("thighL", -1.1 + Math.sin(ph) * 0.25 * mv, 0, -0.1);
    set("shinR", 1.9, 0, 0);
    set("shinL", 1.9, 0, 0);
    set("footR", 0.6, 0, 0);
    set("footL", 0.6, 0, 0);
    // detached/broken legs simply drag
    if (!this.inj.attached.legR) set("thighR", 0.2);
    if (!this.inj.attached.legL) set("thighL", 0.2);
  }

  private solveLegs(enabled: [boolean, boolean], fkLegs: "R" | "L" | "both" | null, hopBad: number) {
    const rig = this.rig;
    const pq = rig.target.q[0];
    const pp = rig.target.p[0];
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? "L" : "R";
      const thighIdx = RIG_INDEX[`thigh${side}` as RigBody];
      const shinIdx = RIG_INDEX[`shin${side}` as RigBody];
      const footIdx = RIG_INDEX[`foot${side}` as RigBody];
      const bs = this.spec.byName[`thigh${side}` as RigBody];
      if (!this.inj.attached[s === 0 ? "legL" : "legR"]) continue;
      if (hopBad === s) {
        // lifted bad leg: bent, dangling
        const e = this.pose.euler;
        const set = (b: RigBody, rx: number) => {
          e[RIG_INDEX[b] * 3] = rx;
        };
        set(`thigh${side}` as RigBody, -0.35);
        set(`shin${side}` as RigBody, 1.3);
        set(`foot${side}` as RigBody, 0.5);
        rig.computeTargets(this.pose);
        continue;
      }
      if ((fkLegs === "L" && s === 0) || (fkLegs === "R" && s === 1) || fkLegs === "both") continue;
      if (!enabled[s]) continue;
      const foot = this.gait.feet[s];
      this.hipW.set(bs.pivotParent[0], bs.pivotParent[1], bs.pivotParent[2]).rotateByQuaternionToRef(pq, this.hipW).addInPlace(pp);
      this.ankleW.set(foot.pos.x, foot.pos.y + this.ankleH, foot.pos.z);
      // pole: knee points along foot heading, slightly outward
      const hy = this.facing + (s === 0 ? -0.1 : 0.1);
      _v1.set(Math.sin(hy), 0, Math.cos(hy));
      const out = this.legOut[s];
      solveLegIK(this.l1, this.l2, this.hipW, this.ankleW, _v1, out);
      rig.target.q[thighIdx].copyFrom(out.thighQ);
      rig.target.q[shinIdx].copyFrom(out.shinQ);
      // foot orientation: heading yaw + pitch
      Quaternion.RotationYawPitchRollToRef(foot.yaw, foot.pitch, 0, this.footQ[s]);
      rig.target.q[footIdx].copyFrom(this.footQ[s]);
    }
  }

  // ---------------------------------------------------------------- drive application
  private applyDrivesAndRoot(dt: number) {
    const rig = this.rig;
    if (this.state === "ragdoll") {
      rig.applyDrives(dt);
      return;
    }
    if (this.state === "getup") {
      rig.applyDrives(dt);
      return;
    }
    // upright: kinematic pelvis follows the composed target
    rig.setRootKinematic(true);
    rig.setRootTarget(this.pose.rootPos, rig.target.q[0]);
    // tones
    const unsteady = this.fx.dazed ? 0.85 : 1;
    for (let i = 0; i < RIG_COUNT; i++) rig.tone[i] = unsteady;
    if (this.state === "stagger") for (let i = 4; i < 10; i++) rig.tone[i] = 0.75;
    rig.applyDrives(dt);
  }


  recordPreVel() {
    if (this.rig.attached[0]) this.rig.pelvis.getLinearVelocityToRef(this.preVel);
  }

  /** After the physics step: injuries tick, consciousness transitions, regen. */
  postStep(dt: number) {
    const w = this.world;
    const exerting = this.state === "attack" || this.state === "guard" || this.state === "dodge" || this.state === "grapple" || this.heldMain !== null;
    this.inj.tickRegen(dt, exerting);
    const notes = this.inj.tickConsciousness(dt, w.time);
    if (notes.length) {
      w.combat.emitNotes(this, notes, this.inj.lastCause);
      this.injuryChanged();
    }
    if (this.state === "ragdoll" && this.inj.consciousness === "dazed" && false) this.applyRagdollTone();
    // recovery from a blackout: the limp body wakes up and tries to stand
    if (this.state === "ragdoll" && this.ragKind === "limp" && this.inj.consciousness !== "blackout" && this.inj.alive) {
      this.ragKind = "knockdown";
    }
    // anything hanging on to an arm that no longer works lets go
    if ((this.heldMain || this.heldOff) && Math.max(this.fx.gripL, this.fx.gripR) <= 0.05) w.props.releaseAll(this, "no grip");
  }

  /** Emergency / round-reset placement that also rebuilds any severed limbs. */
  restoreAndPlace(p: readonly [number, number, number], yaw: number) {
    this.world.restoreFighterRig(this);
    this.placeAt(p, yaw);
  }

  // ---------------------------------------------------------------- queries used by combat/grab
  /** World position of a body-local point. */
  bodyPoint(b: RigBody, local: readonly [number, number, number], out: Vector3): Vector3 {
    const i = RIG_INDEX[b];
    out.set(local[0], local[1], local[2]).rotateByQuaternionToRef(this.rig.nodes[i].rotationQuaternion!, out).addInPlace(this.rig.nodes[i].position);
    return out;
  }
  /** Linear velocity of a body-local point (includes angular contribution). */
  pointVelocity(b: RigBody, worldPoint: Vector3, out: Vector3): Vector3 {
    const body = this.rig.bodies[RIG_INDEX[b]];
    body.getLinearVelocityToRef(out);
    body.getAngularVelocityToRef(_v3);
    _v2.copyFrom(worldPoint).subtractInPlace(this.rig.nodes[RIG_INDEX[b]].position);
    Vector3.CrossToRef(_v3, _v2, _v2);
    return out.addInPlace(_v2);
  }
  centerOfMass(out: Vector3): Vector3 {
    return out.copyFrom(this.rig.nodes[RIG_INDEX.chest].position);
  }
}

export function quatUpright(yaw: number, pitch: number, out: Quaternion): Quaternion {
  return Quaternion.RotationYawPitchRollToRef(yaw, pitch, 0, out);
}

void TAU;
void BONE_REGION_IDS;
void angleLerp;
void moveToward;
void ARM_L;
void ARM_R;
void compileMove;
void sampleKeys;
void G;
void lerp;
void PROPS;
void RIG_BODIES;
export type { PropDef };

/**
 * Props: physical bodies with real gameplay properties, grips (bounded 6-DoF constraints), throws,
 * durability and breakage. All structural changes (break, release, spawn) happen at safe boundaries
 * (outside the physics step) through world.defer().
 */
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import type { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import type { PhysicsShape } from "@babylonjs/core/Physics/v2/physicsShape.js";
import { Physics6DoFConstraint } from "@babylonjs/core/Physics/v2/physicsConstraint.js";
import { PhysicsConstraintAxis as A, PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import { PROPS, type GripDef, type PropDef } from "../data/props.js";
import { RIG_INDEX } from "../data/regions.js";
import type { V3 } from "../data/rigspec.js";
import { clamp, easeOut } from "../math.js";
import { gripFunction } from "./injury.js";
import { G, PROP_COLLIDE_MASK, ragGroup } from "./groups.js";
import { basisToQuat } from "./gait.js";
import type { Fighter, Highlight } from "./fighter.js";
import type { SimWorld } from "./world.js";

const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _q1 = Quaternion.Identity();
const _q2 = Quaternion.Identity();
const _q3 = Quaternion.Identity();

export class Prop {
  readonly id: string;
  readonly def: PropDef;
  node!: TransformNode;
  body!: PhysicsBody;
  shape!: PhysicsShape;
  holder: Fighter | null = null;
  holders: { main: Fighter | null; off: Fighter | null } = { main: null, off: null };
  grips: { main: Physics6DoFConstraint | null; off: Physics6DoFConstraint | null } = { main: null, off: null };
  drag = false;
  durability: number;
  removed = false;
  thrownBy = -1;
  thrownT = 99;
  /** Recently released: keep holder collision off briefly so it doesn't pop. */
  graceT = 0;
  anchored = false;
  anchorThreshold = 0;
  dented = 0;
  hitRecent = new Map<string, number>();
  prevPos = new Vector3();
  prevQ = Quaternion.Identity();
  curPos = new Vector3();
  curQ = Quaternion.Identity();
  lastSpeed = 0;
  lastVel = new Vector3();
  createdAt = 0;
  /** True for the pieces/limbs spawned after a break. */
  piece = false;
  /** For limbs: which limb. */
  limb: string | null = null;
  limbOwner = -1;
  constructor(id: string, def: PropDef) {
    this.id = id;
    this.def = def;
    this.durability = def.brk.durability;
  }
  get speed(): number {
    return this.lastSpeed;
  }
  pos(): Vector3 {
    return this.node.position;
  }
}

export class PropSystem {
  readonly byId = new Map<string, Prop>();
  readonly list: Prop[] = [];
  private seq = 0;
  /** Cap on simultaneously simulated pieces of loose junk. */
  maxActive = 40;

  constructor(private world: SimWorld) {}

  nextId(prefix: string): string {
    return `${prefix}${++this.seq}`;
  }

  spawn(defId: string, pos: V3 | Vector3, opts: { yaw?: number; pitch?: number; roll?: number; vel?: Vector3; angVel?: Vector3; anchored?: number; id?: string; piece?: boolean; def?: PropDef; quat?: Quaternion } = {}): Prop {
    const def = opts.def ?? PROPS[defId];
    const id = opts.id ?? this.nextId(defId + "#");
    const prop = new Prop(id, def);
    const w = this.world;
    const p = pos instanceof Vector3 ? pos : new Vector3(pos[0], pos[1], pos[2]);
    const q = opts.quat ? opts.quat.clone() : Quaternion.RotationYawPitchRoll(opts.yaw ?? 0, opts.pitch ?? 0, opts.roll ?? 0);
    prop.node = w.phys.makeNode(id, p, q);
    prop.shape = w.phys.partsShape(def.parts, G.PROP, PROP_COLLIDE_MASK, { friction: 0.55, restitution: defId === "mug" ? 0.12 : 0.18 });
    const ext = (w.phys.constructor as unknown as { partsExtents(p: typeof def.parts): V3 }).partsExtents(def.parts);
    prop.body = w.phys.dynamicBody(prop.node, prop.shape, def.mass, ext, 0.08, def.weight === "light" ? 0.25 : 0.4);
    w.phys.enableContactEvents(prop.body);
    w.phys.register(prop.body, { kind: "prop", id });
    prop.piece = !!opts.piece;
    prop.createdAt = w.time;
    if (opts.vel) prop.body.setLinearVelocity(opts.vel);
    if (opts.angVel) prop.body.setAngularVelocity(opts.angVel);
    if (opts.anchored && opts.anchored > 0) {
      prop.anchored = true;
      prop.anchorThreshold = opts.anchored;
      prop.body.setMotionType(PhysicsMotionType.STATIC);
    }
    prop.prevPos.copyFrom(p);
    prop.curPos.copyFrom(p);
    prop.prevQ.copyFrom(q);
    prop.curQ.copyFrom(q);
    this.byId.set(id, prop);
    this.list.push(prop);
    return prop;
  }

  remove(prop: Prop) {
    if (prop.removed) return;
    prop.removed = true;
    this.releaseProp(prop, "removed");
    this.world.phys.disposeBody(prop.body, prop.shape, prop.node);
    this.byId.delete(prop.id);
    const i = this.list.indexOf(prop);
    if (i >= 0) this.list.splice(i, 1);
  }

  // ------------------------------------------------------------ highlight / pickup rules
  findHighlight(f: Fighter): Highlight | null {
    if (f.dead || f.unconscious) return null;
    let best: Highlight | null = null;
    let bestScore = 1e9;
    const fx = Math.sin(f.facing),
      fz = Math.cos(f.facing);
    const holding = f.heldMain || f.heldOff;
    if (!holding) {
      for (const p of this.list) {
        if (p.holder || p.removed) continue;
        if (p.def.weight === "fixture") continue;
        const pp = p.node.position;
        const dx = pp.x - f.pos.x,
          dz = pp.z - f.pos.z;
        const dy = pp.y - f.pos.y;
        const d = Math.hypot(dx, dz);
        if (d > 1.7 || dy > 1.6 || dy < -0.3) continue;
        const dot = d > 0.001 ? (dx * fx + dz * fz) / d : 1;
        if (dot < 0.15 && d > 0.55) continue; // behind us
        const score = d - dot * 0.35 - p.def.botValue * 0.1;
        if (score < bestScore) {
          bestScore = score;
          best = { kind: "prop", id: p.id, dist: d };
        }
      }
    }
    // grapple target
    const o = f.opponent;
    if (!holding && o && !o.dead && o.state !== "ragdoll" && o.state !== "getup" && o.state !== "grabbed" && f.grappleImmune <= 0 && o.grappleImmune <= 0) {
      const dx = o.pos.x - f.pos.x,
        dz = o.pos.z - f.pos.z;
      const d = Math.hypot(dx, dz);
      const dot = d > 0.001 ? (dx * fx + dz * fz) / d : 1;
      if (d < 1.4 && dot > 0.5) {
        const score = d - 0.4 - dot * 0.2;
        if (score < bestScore) {
          bestScore = score;
          best = { kind: "fighter", id: String(o.slot), dist: d };
        }
      }
    }
    return best;
  }

  canPickUp(f: Fighter, p: Prop): boolean {
    if (p.holder || p.removed) return false;
    if (p.def.weight === "fixture") return false;
    const fx = f.fx;
    if (p.def.weight === "heavy") return Math.max(fx.gripL, fx.gripR) > 0.3; // drag
    if (p.def.hands === 2) return fx.canTwoHand && fx.liftLimit >= p.def.mass;
    if (Math.max(fx.gripL, fx.gripR) <= 0.12) return false;
    return fx.liftLimit >= p.def.mass * 0.8;
  }

  // ------------------------------------------------------------ grabbing
  grab(f: Fighter, p: Prop) {
    if (!this.canPickUp(f, p) || p.holder || f.heldMain || f.heldOff) return;
    const fx = f.fx;
    if (p.def.weight === "heavy") {
      p.holder = f;
      p.drag = true;
      p.holders.main = f;
      f.heldMain = p;
      this.setHolderMask(p, f);
      this.world.emit({ t: "grab", fighter: f.slot, hand: "both", targetKind: "prop", targetId: p.id });
      this.world.emit({ t: "ownership", propId: p.id, owner: f.slot, hand: "both" });
      return;
    }
    // choose hand(s)
    const wantTwo = p.def.hands === 2 || (p.def.damage.heft > 0.5 && p.def.tags.includes("twoHandOk") && fx.canTwoHand && false);
    let mainHandSide: "R" | "L" = fx.gripR >= fx.gripL ? "R" : "L";
    if (p.def.weight === "medium" && p.def.hands === 1 && fx.gripR > 0.2) mainHandSide = "R";
    const mainGrip = p.def.grips.find((g) => g.role === "main")!;
    const offGrip = p.def.grips.find((g) => g.role === "off");
    // place the prop at the hand
    this.attachGrip(f, p, mainGrip, mainHandSide, "main");
    if (wantTwo && offGrip) {
      const other = mainHandSide === "R" ? "L" : "R";
      this.attachGrip(f, p, offGrip, other, "off");
    }
    p.holder = f;
    p.holders.main = f;
    if (wantTwo) p.holders.off = f;
    if (mainHandSide === "R") {
      f.heldMain = p;
      if (wantTwo) f.heldOff = p;
    } else {
      f.heldOff = p;
      if (wantTwo) f.heldMain = p;
      // single left-hand holds still reported through heldMain for pose/attack simplicity
      if (!wantTwo) {
        f.heldMain = p;
        f.heldOff = null;
      }
    }
    this.setHolderMask(p, f);
    p.thrownBy = -1;
    this.world.emit({ t: "grab", fighter: f.slot, hand: wantTwo ? "both" : mainHandSide, targetKind: p.limb ? "limb" : "prop", targetId: p.id });
    this.world.emit({ t: "ownership", propId: p.id, owner: f.slot, hand: wantTwo ? "both" : mainHandSide });
  }

  private setHolderMask(p: Prop, f: Fighter) {
    // held props must not collide with their own holder's ragdoll bodies
    p.shape.filterCollideMask = PROP_COLLIDE_MASK & ~ragGroup(f.slot) & ~G.CAP_A & ~G.CAP_B;
  }

  private attachGrip(f: Fighter, p: Prop, grip: GripDef, side: "R" | "L", role: "main" | "off") {
    const handIdx = RIG_INDEX[side === "R" ? "handR" : "handL"];
    const handNode = f.rig.nodes[handIdx];
    const handBody = f.rig.bodies[handIdx];
    const anchor = f.spec.gripAnchor;
    // frames: hand (axis +Z, perp +X); prop (axis = grip.axis or +Y, perp)
    const axisB = new Vector3(...(grip.axis ?? [0, 1, 0])).normalize();
    const perpB = Math.abs(axisB.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
    perpB.subtractInPlace(axisB.scale(Vector3.Dot(perpB, axisB))).normalize();
    // hand side mirrors: for the left hand flip X so the thumb faces the same way
    const xA = new Vector3(side === "R" ? 1 : -1, 0, 0);
    const zA = new Vector3(0, 0, 1);
    const yA = Vector3.Cross(zA, xA);
    const yB = Vector3.Cross(axisB, perpB);
    basisToQuat(xA, yA, zA, _q1); // hand frame
    basisToQuat(perpB, yB, axisB, _q2); // prop frame
    // R_prop = R_hand * Qh * Qp^-1
    Quaternion.InverseToRef(_q2, _q3);
    handNode.rotationQuaternion!.multiplyToRef(_q1, _q1);
    _q1.multiplyToRef(_q3, _q1);
    // position
    _v1.set(anchor[0], anchor[1], anchor[2]).rotateByQuaternionToRef(handNode.rotationQuaternion!, _v1).addInPlace(handNode.position);
    _v2.set(grip.pos[0], grip.pos[1], grip.pos[2]).rotateByQuaternionToRef(_q1, _v2);
    _v3.copyFrom(_v1).subtractInPlace(_v2);
    // teleport the prop onto the hand (only for the first grip)
    if (role === "main") {
      this.world.phys.teleport(p.body, _v3, _q1);
      p.body.setLinearVelocity(handBody.getLinearVelocity());
      p.body.setAngularVelocity(Vector3.ZeroReadOnly);
    }
    const lim = (axis: number, lo: number, hi: number) => ({ axis, minLimit: lo, maxLimit: hi });
    const wrist = role === "main" ? 0.35 : 0.22;
    const con = new Physics6DoFConstraint(
      {
        pivotA: new Vector3(anchor[0], anchor[1], anchor[2]),
        pivotB: new Vector3(grip.pos[0], grip.pos[1], grip.pos[2]),
        axisA: new Vector3(0, 0, 1),
        axisB: axisB.clone(),
        perpAxisA: new Vector3(side === "R" ? 1 : -1, 0, 0),
        perpAxisB: perpB.clone(),
        collision: false,
      },
      [lim(A.LINEAR_X, 0, 0), lim(A.LINEAR_Y, 0, 0), lim(A.LINEAR_Z, 0, 0), lim(A.ANGULAR_X, -wrist, wrist), lim(A.ANGULAR_Y, -wrist, wrist), lim(A.ANGULAR_Z, -wrist, wrist)],
      this.world.scene,
    );
    handBody.addConstraint(p.body, con);
    p.grips[role] = con;
    // second grip on a body that was not teleported: align by letting the constraint solve (small error)
  }

  /** Drop everything the fighter holds. */
  releaseAll(f: Fighter, reason: string) {
    const seen = new Set<Prop>();
    for (const p of [f.heldMain, f.heldOff]) {
      if (p && !seen.has(p)) {
        seen.add(p);
        this.releaseProp(p, reason);
      }
    }
    f.heldMain = null;
    f.heldOff = null;
  }

  /** Release a prop from whoever holds it; cleans constraints exactly once. */
  releaseProp(p: Prop, reason: string) {
    const f = p.holder;
    if (p.grips.main) {
      p.grips.main.dispose();
      p.grips.main = null;
    }
    if (p.grips.off) {
      p.grips.off.dispose();
      p.grips.off = null;
    }
    p.drag = false;
    if (f) {
      if (f.heldMain === p) f.heldMain = null;
      if (f.heldOff === p) f.heldOff = null;
      p.holder = null;
      p.holders.main = null;
      p.holders.off = null;
      p.graceT = 0.35;
      p.shape.filterCollideMask = PROP_COLLIDE_MASK & ~ragGroup(f.slot);
      this.world.emit({ t: "release", fighter: f.slot, targetId: p.id, reason });
      this.world.emit({ t: "ownership", propId: p.id, owner: -1, hand: "none" });
    }
  }

  maybeDropOnKnockdown(f: Fighter) {
    for (const p of [f.heldMain, f.heldOff]) {
      if (p) {
        const g = Math.max(f.fx.gripL, f.fx.gripR);
        if (g < 0.8 || p.def.mass > 3) {
          this.releaseAll(f, "knocked down");
          return;
        }
      }
    }
  }

  /** A limb or arm was lost: drop what that arm held. */
  onArmLost(f: Fighter, side: "L" | "R") {
    const rightHeld = f.heldMain;
    // single-handed holds depend on which hand: both references point at the same prop for 2H
    const p = side === "R" ? rightHeld : f.heldOff ?? f.heldMain;
    if (!p) return;
    // find which constraint belongs to which hand by body pair
    const handBody = f.rig.bodies[RIG_INDEX[side === "R" ? "handR" : "handL"]];
    let lostAny = false;
    for (const role of ["main", "off"] as const) {
      const con = p.grips[role];
      if (!con) continue;
      const pairs = con.getBodiesUsingConstraint();
      if (pairs.some((pr) => pr.parentBody === handBody)) {
        con.dispose();
        p.grips[role] = null;
        lostAny = true;
      }
    }
    if (lostAny) {
      if (!p.grips.main && !p.grips.off) this.releaseProp(p, "arm lost");
      else {
        // one-handed grip left on a two-handed object: keep holding if the remaining grip is strong enough
        const g = Math.max(f.fx.gripL, f.fx.gripR);
        if (p.def.hands === 2 || g < 0.3) this.releaseProp(p, "arm lost");
        else {
          this.world.emit({ t: "ownership", propId: p.id, owner: f.slot, hand: side === "R" ? "L" : "R" });
        }
      }
    }
  }

  // ------------------------------------------------------------ throwing
  throwHeld(f: Fighter) {
    const p = f.heldMain ?? f.heldOff;
    if (!p) return;
    const dir = _v1.set(Math.sin(f.intent.aimYaw ?? f.facing), 0.0, Math.cos(f.intent.aimYaw ?? f.facing));
    const weak = clamp(0.45 + 0.55 * Math.max(f.fx.gripL, f.fx.gripR) * (f.fx.canTwoHand ? 1 : 0.9), 0.4, 1);
    let speed = p.def.throwSpeed * weak * (f.def.grip > 1 ? 1.05 : 1) * (f.inj.stamina <= 0 ? 0.8 : 1);
    this.releaseProp(p, "thrown");
    f.heldMain = null;
    f.heldOff = null;
    if (p.drag) speed = 0;
    const v = _v2.set(dir.x * speed, 2.2 + speed * 0.12, dir.z * speed);
    // keep the shape un-masked from the thrower briefly (graceT handles) so it doesn't hit them on the way out
    this.world.phys.teleport(p.body, p.node.position, p.node.rotationQuaternion!);
    p.body.setLinearVelocity(v);
    // spin about the prop's own long axis for a convincing tumble
    p.body.setAngularVelocity(new Vector3(-dir.z, 0, dir.x).scale(p.def.throwSpin * 0.6).add(new Vector3(0, p.def.throwSpin * 0.3, 0)));
    p.thrownBy = f.slot;
    p.thrownT = 0;
    this.world.emit({ t: "throw", fighter: f.slot, targetKind: p.limb ? "limb" : "prop", targetId: p.id, speed });
    f.inj.spendStamina(p.def.mass > 4 ? 8 : 3);
  }

  // ------------------------------------------------------------ per tick
  preStep(dt: number) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      if (p.removed) continue;
      p.thrownT += dt;
      p.hitRecent.forEach((t, k) => {
        if (this.world.time - t > 0.5) p.hitRecent.delete(k);
      });
      if (p.graceT > 0) {
        p.graceT -= dt;
        if (p.graceT <= 0 && !p.holder) p.shape.filterCollideMask = PROP_COLLIDE_MASK;
      }
      p.body.getLinearVelocityToRef(p.lastVel);
      p.lastSpeed = p.lastVel.length();
      if (p.holder) this.updateHeld(p, dt);
      // runaway guards
      if (!Number.isFinite(p.node.position.x + p.node.position.y + p.node.position.z) || p.node.position.y < -30) {
        this.world.defer(() => this.remove(p));
      }
    }
  }

  private updateHeld(p: Prop, dt: number) {
    const f = p.holder!;
    const fx = f.fx;
    if (f.state === "ragdoll" && f.ragKind !== "knockdown") {
      this.world.defer(() => this.releaseProp(p, "knocked out"));
      return;
    }
    const grip = Math.max(fx.gripL, fx.gripR);
    if (grip <= 0.08) {
      this.world.defer(() => this.releaseProp(p, "grip lost"));
      return;
    }
    // grip strain: separation between the hand anchor and the prop grip, plus carried load
    let gap = 0;
    for (const role of ["main", "off"] as const) {
      const con = p.grips[role];
      if (!con) continue;
      const pr = con.getBodiesUsingConstraint()[0];
      if (!pr) continue;
      const hand = pr.parentBody;
      const g = p.def.grips.find((x) => x.role === role)!;
      const anchor = f.spec.gripAnchor;
      _v1.set(anchor[0], anchor[1], anchor[2]).rotateByQuaternionToRef(hand.transformNode.rotationQuaternion!, _v1).addInPlace(hand.transformNode.position);
      _v2.set(g.pos[0], g.pos[1], g.pos[2]).rotateByQuaternionToRef(p.node.rotationQuaternion!, _v2).addInPlace(p.node.position);
      gap = Math.max(gap, Vector3.Distance(_v1, _v2));
    }
    const load = p.def.mass * (0.35 + p.lastSpeed * 0.06);
    const capacity = (6 + 34 * grip) * (f.def.grip > 1 ? 1.15 : 1) * (0.5 + 0.5 * clamp(f.inj.stamina / 40, 0.2, 1));
    const strain = clamp(load / capacity + gap / 0.2, 0, 2);
    // heavy things drain stamina
    f.inj.stamina = Math.max(0, f.inj.stamina - p.def.hindrance * 1.2 * dt);
    if (gap > 0.18 || (strain > 1.35 && p.def.mass > 3)) this.world.defer(() => this.releaseProp(p, "slipped"));
    if (p.drag) this.updateDrag(p, f, dt, grip);
  }

  private updateDrag(p: Prop, f: Fighter, dt: number, grip: number) {
    // pull toward a point in front of the fighter, bounded by grip strength
    const fx = Math.sin(f.facing),
      fz = Math.cos(f.facing);
    const target = _v1.set(f.pos.x + fx * 0.95, p.node.position.y, f.pos.z + fz * 0.95);
    const to = _v2.copyFrom(target).subtractInPlace(p.node.position);
    to.y = 0;
    const d = to.length();
    if (d > 2.2) {
      this.world.defer(() => this.releaseProp(p, "too far"));
      return;
    }
    const maxF = (60 + 120 * grip) * p.def.mass * 0.12;
    const mag = Math.min(maxF, d * 80 * p.def.mass * 0.1);
    if (d > 0.02) {
      to.scaleInPlace(mag / d * dt);
      p.body.applyImpulse(to, p.node.position);
    }
    // damp sliding so it doesn't skate
    const v = p.lastVel;
    p.body.setLinearVelocity(_v3.set(v.x * 0.92, v.y, v.z * 0.92));
  }

  postStep() {
    for (const p of this.list) {
      if (p.removed) continue;
      p.prevPos.copyFrom(p.curPos);
      p.prevQ.copyFrom(p.curQ);
      p.curPos.copyFrom(p.node.position);
      p.curQ.copyFrom(p.node.rotationQuaternion!);
    }
  }

  /** Apply an impact to a prop: durability drain, breakage scheduling. Returns true if it will break. */
  damage(p: Prop, impulse: number, by: number): boolean {
    if (p.removed) return false;
    const b = p.def.brk;
    if (impulse < b.threshold) return false;
    p.durability -= impulse - b.threshold * 0.5;
    p.dented += 1;
    if (p.durability <= 0 && !b.dentOnly) {
      this.world.defer(() => this.breakProp(p, by));
      return true;
    }
    return false;
  }

  breakProp(p: Prop, by: number) {
    if (p.removed) return;
    const w = this.world;
    const def = p.def;
    const pos = p.node.position.clone();
    const q = p.node.rotationQuaternion!.clone();
    const vel = p.lastVel.clone();
    const pieces: string[] = [];
    const holderSlot = p.holder?.slot ?? -1;
    this.remove(p);
    for (const pc of def.brk.pieces) {
      const off = _v1.set(pc.offset[0], pc.offset[1], pc.offset[2]).rotateByQuaternionToRef(q, _v1).clone();
      const spawnPos = pos.add(off);
      const scatter = new Vector3((w.rng.next() - 0.5) * 2.4, w.rng.next() * 1.6, (w.rng.next() - 0.5) * 2.4);
      const np = this.spawn(pc.id, spawnPos, { vel: vel.scale(0.6).add(scatter), angVel: new Vector3(w.rng.range(-8, 8), w.rng.range(-8, 8), w.rng.range(-8, 8)), piece: true });
      np.body.getAngularVelocityToRef(_v2);
      pieces.push(np.id);
      // The chair leg stays in the hand of the attacker when it breaks mid-swing: "technically still armed"
      if (holderSlot >= 0 && pc.id === "chairLeg" && pieces.length === 1) {
        const holder = w.fighters[holderSlot];
        if (holder && !holder.heldMain && !holder.heldOff && holder.state !== "ragdoll") {
          const keep = np;
          w.defer(() => {
            if (!keep.removed && !keep.holder && holder.state !== "ragdoll") this.grab(holder, keep);
          });
        }
      }
    }
    w.emit({ t: "propBreak", propId: p.id, kind: def.id, pieces, pos: [pos.x, pos.y, pos.z], by });
    if (by >= 0) w.fighters[by].stats.propsBroken++;
    w.enforcePropBudget();
  }

  clearAll() {
    for (const p of [...this.list]) this.remove(p);
  }
}

void easeOut;
void PROPS;

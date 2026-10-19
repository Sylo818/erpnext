/**
 * Combat resolution.
 *  - Strikes: fists/feet/shoulders/weapons are swept (sphere shape casts) from last tick's position to
 *    this tick's, against the defender's ragdoll bodies, props and architecture. The nearest thing on the
 *    path decides; geometry in between blocks the hit (no tunnelling through thin obstacles, no hits
 *    through walls). One damaging hit per attack per target (deduplicated by attack id).
 *  - Thrown props / ragdoll slams: processed from physics collision events using pre-step velocities.
 */
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import { INJURY } from "../data/injuries.js";
import type { MoveDef } from "../data/moves.js";
import { RIG_BODIES, RIG_BODY_TO_REGION, RIG_INDEX, type BodyRegion, type FaceRegion, type RigBody } from "../data/regions.js";
import { clamp, clamp01 } from "../math.js";
import type { Fighter } from "./fighter.js";
import { BLOCKER_MASK, G, ragCollideMask, ragGroup } from "./groups.js";
import type { Prop } from "./props.js";
import type { MoveKind } from "./events.js";
import type { HitOutcome, InjuryNote } from "./injury.js";
import type { SimWorld } from "./world.js";

export interface HitSource {
  attacker: number;
  kind: MoveKind;
  impulse: number;
  heft: number;
  material: string;
  weaponId: string | null;
  cause: string;
  environmental?: boolean;
  balanceDmg: number;
  knockback: number;
  /** Unit direction from the source to the target (horizontal component drives knockback). */
  dir: Vector3;
  point: Vector3;
  normal: Vector3;
  heavy?: boolean;
  ignoreIframes?: boolean;
}

export interface CollisionRec {
  a: PhysicsBody;
  b: PhysicsBody;
  impulse: number;
  point: Vector3;
  normal: Vector3;
}

const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _v4 = new Vector3();
const _q = Quaternion.Identity();

const ARM_REGIONS = new Set<RigBody>(["upperArmL", "upperArmR", "forearmL", "forearmR", "handL", "handR"]);

export class CombatSystem {
  private prev: Vector3[][] = [[], []];
  private prevAttack = [-1, -1];
  readonly collisions: CollisionRec[] = [];
  private pool: CollisionRec[] = [];
  private poolN = 0;
  private slamLast = [-9, -9];
  private samples: { p: Vector3; r: number }[] = [];
  private ignoreSelf: PhysicsBody | undefined;

  constructor(private world: SimWorld) {
    for (let i = 0; i < 6; i++) this.samples.push({ p: new Vector3(), r: 0.08 });
  }

  /** Called from the physics observer during the step. Copies data out of the engine's reused objects. */
  record(a: PhysicsBody, b: PhysicsBody, impulse: number, point: Vector3 | null, normal: Vector3 | null) {
    if (this.collisions.length > 200) return;
    let rec = this.pool[this.poolN];
    if (!rec) {
      rec = { a, b, impulse: 0, point: new Vector3(), normal: new Vector3() };
      this.pool[this.poolN] = rec;
    }
    this.poolN++;
    rec.a = a;
    rec.b = b;
    rec.impulse = impulse;
    if (point) rec.point.copyFrom(point);
    else rec.point.setAll(0);
    if (normal) rec.normal.copyFrom(normal);
    else rec.normal.set(0, 1, 0);
    this.collisions.push(rec);
  }
  clearCollisions() {
    this.collisions.length = 0;
    this.poolN = 0;
  }

  // ------------------------------------------------------------------ strike sweeps
  step(dt: number) {
    for (const f of this.world.fighters) this.strikes(f, dt);
    this.processCollisions();
  }

  private collectSamples(f: Fighter, m: MoveDef): number {
    let n = 0;
    const put = (p: Vector3, r: number) => {
      const s = this.samples[n++];
      s.p.copyFrom(p);
      s.r = r;
    };
    const spec = f.spec;
    const r = m.radius * f.spec.height;
    switch (m.strike) {
      case "handR":
        put(f.bodyPoint("handR", spec.strikePoint, _v1), r);
        break;
      case "handL":
        put(f.bodyPoint("handL", spec.strikePoint, _v1), r);
        break;
      case "footR":
        put(f.bodyPoint("footR", [0, -0.05 * spec.height, 0.1 * spec.height], _v1), r);
        break;
      case "footL":
        put(f.bodyPoint("footL", [0, -0.05 * spec.height, 0.1 * spec.height], _v1), r);
        break;
      case "shoulderR":
        put(f.bodyPoint("chest", [0.22 * spec.height, 0.1, 0.1], _v1), r);
        break;
      case "shoulderL":
        put(f.bodyPoint("chest", [-0.22 * spec.height, 0.1, 0.1], _v1), r);
        break;
      case "head":
        put(f.bodyPoint("head", [0, 0.05, 0.1 * spec.height], _v1), r);
        break;
      case "both":
        put(f.bodyPoint("handR", spec.strikePoint, _v1), r);
        put(f.bodyPoint("handL", spec.strikePoint, _v1), r);
        break;
      case "weapon": {
        const w = f.moveWeapon ?? f.heldMain ?? f.heldOff;
        if (w) {
          for (const sp of w.def.strike) {
            _v1.set(sp[0], sp[1], sp[2]).rotateByQuaternionToRef(w.node.rotationQuaternion!, _v1).addInPlace(w.node.position);
            put(_v1, Math.max(r, 0.05));
          }
        } else put(f.bodyPoint("handR", spec.strikePoint, _v1), r);
        break;
      }
    }
    return n;
  }

  private strikes(f: Fighter, dt: number) {
    const m = f.move;
    const prev = this.prev[f.slot];
    if (!m || f.dead) {
      prev.length = 0;
      this.prevAttack[f.slot] = -1;
      return;
    }
    const n = this.collectSamples(f, m);
    const fresh = this.prevAttack[f.slot] !== f.attackId || prev.length !== n;
    if (fresh) {
      prev.length = 0;
      for (let i = 0; i < n; i++) prev.push(this.samples[i].p.clone());
      this.prevAttack[f.slot] = f.attackId;
    }
    const active = f.strikeActive();
    if (active) this.resolveStrike(f, m, n, dt);
    for (let i = 0; i < n; i++) prev[i].copyFrom(this.samples[i].p);
    // heavy miss -> follow-through: punishable recovery
    if (!active && f.moveT / f.moveScale > m.windup + m.active && !f.hitThisAttack.has("done")) {
      f.hitThisAttack.add("done");
      if (!f.hitThisAttack.has("hit")) {
        f.stats.whiffs++;
        const heavy = m.kind === "heavy" || (m.kind === "weapon" && m.power > 1.2);
        this.world.emit({ t: "whiff", attacker: f.slot, kind: m.kind, heavy });
        if (heavy) {
          f.cooldownAttack += 0.3;
          f.inj.balance = Math.max(0, f.inj.balance - 14);
          f.ext.x += Math.sin(f.facing) * 1.6;
          f.ext.z += Math.cos(f.facing) * 1.6;
        }
      }
    }
  }

  private resolveStrike(f: Fighter, m: MoveDef, n: number, dt: number) {
    const w = this.world;
    const prev = this.prev[f.slot];
    const target = f.opponent;
    let best: { hit: NonNullable<ReturnType<typeof w.phys.sweepSphere>>; i: number; dist: number } | null = null;
    const member = ragGroup(f.slot);
    const collide = ragCollideMask(f.slot);
    for (let i = 0; i < n; i++) {
      const s = this.samples[i];
      const a = prev[i];
      const hit = w.phys.sweepSphere(a, s.p, s.r, member, collide);
      if (!hit) continue;
      const d = Vector3.Distance(a, s.p) * hit.fraction;
      if (!best || d < best.dist) best = { hit, i, dist: d };
    }
    if (!best) return;
    const { hit, i } = best;
    const owner = w.phys.ownerOf(hit.body);
    if (!owner) return;
    // line of sight from the attacker's torso: reject hits behind geometry
    const torso = f.rig.nodes[RIG_INDEX.chest].position;
    _v1.copyFrom(hit.point);
    const rr = w.phys.raycast(torso, _v1, G.SWEEP_ONLY, BLOCKER_MASK);
    if (rr.hasHit) {
      const dd = rr.hitDistance;
      const full = Vector3.Distance(torso, _v1);
      if (dd < full - 0.12) {
        this.strikeBlockedByGeometry(f, hit.point, hit.normal);
        return;
      }
    }
    switch (owner.kind) {
      case "rig": {
        if (owner.slot === f.slot) return;
        const key = `${f.attackId}:f${owner.slot}`;
        if (f.hitThisAttack.has(key)) return;
        f.hitThisAttack.add(key);
        const bodyIdx = owner.index!;
        const vel = _v2.copyFrom(this.samples[i].p).subtractInPlace(prev[i]).scaleInPlace(1 / Math.max(dt, 1e-4));
        const tv = _v3;
        target.pointVelocity(RIG_BODIES[bodyIdx], hit.point, tv);
        vel.subtractInPlace(tv);
        const dir = _v4.copyFrom(target.rig.nodes[bodyIdx].position).subtractInPlace(f.rig.nodes[RIG_INDEX.chest].position);
        dir.y *= 0.3;
        if (dir.lengthSquared() < 1e-6) dir.set(Math.sin(f.facing), 0, Math.cos(f.facing));
        dir.normalize();
        const J = this.strikeImpulse(f, m, vel, dir);
        const src: HitSource = {
          attacker: f.slot,
          kind: m.kind,
          impulse: J,
          heft: f.moveWeapon ? f.moveWeapon.def.damage.heft : m.kind === "kick" || m.kind === "shoulder" ? 0.2 : 0.15,
          material: f.moveWeapon ? f.moveWeapon.def.damage.material : "fist",
          weaponId: f.moveWeapon?.def.id ?? null,
          cause: f.moveWeapon ? `a ${f.moveWeapon.def.name.toLowerCase()}` : m.kind === "kick" ? "a boot to the body" : m.kind === "shoulder" ? "a running shoulder" : "a fist",
          balanceDmg: m.balanceDmg * (f.moveWeapon ? f.moveWeapon.def.damage.stagger : 1),
          knockback: m.knockback,
          dir: dir.clone(),
          point: hit.point.clone(),
          normal: hit.normal.clone(),
          heavy: m.kind === "heavy" || (m.kind === "weapon" && m.power > 1.2),
        };
        const rep = this.hitFighter(target, bodyIdx, src);
        f.hitThisAttack.add("hit");
        if (rep.landed) {
          f.stats.hits++;
          f.stats.damageDealt += rep.vitalityLoss;
          f.hitStop = rep.guarded ? 0.03 : 0.06;
          if (f.moveWeapon) w.props.damage(f.moveWeapon, J * 0.5, f.slot);
        }
        break;
      }
      case "prop": {
        const p = w.props.byId.get(owner.id);
        if (!p) return;
        const key = `${f.attackId}:p${p.id}`;
        if (f.hitThisAttack.has(key) || p === f.moveWeapon || p.holder === f) return;
        f.hitThisAttack.add(key);
        f.hitThisAttack.add("hit");
        const vel = _v2.copyFrom(this.samples[i].p).subtractInPlace(prev[i]).scaleInPlace(1 / Math.max(dt, 1e-4));
        const J = this.strikeImpulse(f, m, vel, _v4.set(Math.sin(f.facing), 0, Math.cos(f.facing)));
        this.strikeProp(f, p, J, hit.point, m);
        break;
      }
      case "wall":
      case "door":
      case "static":
      case "chunk": {
        this.strikeBlockedByGeometry(f, hit.point, hit.normal);
        break;
      }
      default:
        break;
    }
  }

  private strikeBlockedByGeometry(f: Fighter, point: Vector3, normal: Vector3) {
    const key = `${f.attackId}:geo`;
    if (f.hitThisAttack.has(key)) return;
    f.hitThisAttack.add(key);
    f.hitThisAttack.add("hit");
    const m = f.move!;
    const strong = m.power > 1.0 || f.moveWeapon !== null;
    if (strong) {
      f.hitStop = 0.07;
      // clang recoil: the swing bounces off and the attacker is briefly off balance
      f.inj.balance = Math.max(0, f.inj.balance - (m.kind === "heavy" ? 18 : 8));
      if (m.kind === "heavy" || f.moveWeapon) f.cooldownAttack += 0.15;
    }
    this.world.emit({
      t: "impact",
      material: f.moveWeapon ? f.moveWeapon.def.damage.material : "fist",
      pos: [point.x, point.y, point.z],
      strength: strong ? 0.7 : 0.35,
      a: f.moveWeapon ? f.moveWeapon.def.damage.sound : "fist",
      b: "wall",
    });
    void normal;
  }

  private strikeImpulse(f: Fighter, m: MoveDef, relVel: Vector3, dir: Vector3): number {
    const measured = Math.max(0, Vector3.Dot(relVel, dir));
    const w = f.moveWeapon;
    const fx = f.fx;
    const side = m.strike.endsWith("L") ? "L" : "R";
    let mult = f.def.damage;
    if (m.strike.startsWith("hand") || m.strike === "weapon" || m.strike === "both") {
      const mir = m.side === "L";
      const s = m.strike === "weapon" ? Math.max(fx.strikeMultL, fx.strikeMultR) : mir ? fx.strikeMultL : fx.strikeMultR;
      mult *= m.strike === "both" ? Math.min(fx.strikeMultL, fx.strikeMultR) * 0.5 + 0.5 : s;
    } else if (m.strike.startsWith("foot")) mult *= side === "L" ? fx.kickMultL : fx.kickMultR;
    if (f.inj.stamina <= 0) mult *= 0.6;
    if (m.chargeable) mult *= 1 + 0.5 * clamp01(f.moveCharge / 0.9);
    // sprint boost for the lunge
    let effMass: number;
    let nominal = m.speed;
    if (w) {
      effMass = w.def.damage.effMass * (0.65 + 0.35 * Math.max(fx.gripL, fx.gripR));
      mult *= w.def.damage.impulseMult;
    } else effMass = m.massFrac * 80 * Math.sqrt(f.def.mass / 80);
    const speed = Math.max(measured * 0.9, nominal * 0.62);
    return effMass * speed * m.power * mult * (f.recoveryProtect > 0 ? 1 : 1);
  }

  // ------------------------------------------------------------------ prop struck by melee
  private strikeProp(f: Fighter, p: Prop, J: number, point: Vector3, m: MoveDef) {
    const w = this.world;
    // a shield / pan held by the opponent: "block"
    if (p.holder && p.holder !== f && p.def.guard) {
      const d = p.holder;
      const faces = this.facing(d, f.pos);
      if (faces) {
        this.world.emit({ t: "block", defender: d.slot, with: p.def.id, pos: [point.x, point.y, point.z], strength: p.def.guard.strength });
        d.stats.blocks++;
        d.inj.spendStamina(J * 0.1);
        f.hitStop = 0.07;
        if (f.moveWeapon) w.props.damage(f.moveWeapon, J * 0.3, f.slot);
        w.props.damage(p, J * 0.4, f.slot);
        if (m.power > 1.2 || J > 90) f.enterStagger(0.25);
        w.emit({ t: "impact", material: p.def.damage.material, pos: [point.x, point.y, point.z], strength: clamp01(J / 120), a: f.moveWeapon?.def.damage.sound ?? "fist", b: p.def.damage.sound });
        return;
      }
    }
    // knock it around
    const dir = _v1.set(Math.sin(f.facing), 0.15, Math.cos(f.facing));
    p.body.applyImpulse(dir.scale(Math.min(J * 0.6, p.def.mass * 7)), point);
    const broke = w.props.damage(p, J, f.slot);
    w.emit({ t: "impact", material: p.def.damage.material, pos: [point.x, point.y, point.z], strength: clamp01(J / 120), a: f.moveWeapon?.def.damage.sound ?? "fist", b: p.def.damage.sound });
    if (p.holder && p.holder !== f && J > 55) {
      // heavy blows loosen grips
      p.holder.inj.stamina = Math.max(0, p.holder.inj.stamina - J * 0.1);
      if (J > 80 && p.holder.fx.gripR < 1.1) w.props.releaseProp(p, "knocked from hands");
    }
    void broke;
  }

  private facing(d: Fighter, from: Vector3): boolean {
    const dx = from.x - d.pos.x,
      dz = from.z - d.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    return (dx * Math.sin(d.facing) + dz * Math.cos(d.facing)) / l > Math.cos((95 * Math.PI) / 180);
  }

  // ------------------------------------------------------------------ the damage pipeline
  hitFighter(target: Fighter, bodyIdx: number, src: HitSource): { landed: boolean; guarded: boolean; vitalityLoss: number; knockdown: boolean; outcome: HitOutcome | null } {
    const w = this.world;
    const none = { landed: false, guarded: false, vitalityLoss: 0, knockdown: false, outcome: null };
    if (target.dead) return none;
    const attacker = src.attacker >= 0 ? w.fighters[src.attacker] : null;
    // dodge i-frames protect from everything except the environment
    if (target.iframes > 0 && !src.environmental && !src.ignoreIframes) {
      w.emit({ t: "impact", material: "cloth", pos: [src.point.x, src.point.y, src.point.z], strength: 0.15, a: "whoosh", b: "dodge" });
      return none;
    }
    let J = src.impulse;
    const body = RIG_BODIES[bodyIdx];
    let guarded = false;
    // guard: depends on facing and on the limb that actually intercepted the strike
    if (!src.environmental && target.state === "guard" && target.guardW > 0.55 && attacker) {
      if (this.facing(target, attacker.pos) && this.facing(target, src.point)) {
        if (ARM_REGIONS.has(body)) {
          J *= 0.28;
          guarded = true;
        } else if (body === "head" || body === "chest") {
          J *= 0.7;
          guarded = true;
        }
      }
    }
    // recovery protection after getting up
    if (target.recoveryProtect > 0 && !src.environmental) J *= 0.45;
    // grabbed fighters are easier targets; the holder is interruptible
    if (target.grappleRole === "holder" && J > 40) w.grapples.end(target, "interrupted");
    // resilience
    const resist = target.def.resist;
    const region: BodyRegion = this.regionFor(target, bodyIdx, src.point);
    const face = body === "head" ? this.faceFor(target, src.point) : null;
    const jEff = J / Math.pow(resist, 0.5);
    const out = target.inj.applyHit(
      {
        region,
        face,
        impulse: jEff,
        heft: src.heft,
        cause: src.cause,
        environmental: src.environmental,
        time: w.time,
        boneMult: guarded ? 0.5 : 1,
      },
      w.matchSettings.blackoutSeconds,
    );
    target.injuryChanged();
    target.stats.damageTaken += out.vitalityLoss;
    // events
    w.emit({
      t: "hit",
      attacker: src.attacker,
      target: target.slot,
      region: face ?? region,
      body,
      impulse: jEff,
      damage: out.vitalityLoss,
      kind: src.kind,
      pos: [src.point.x, src.point.y, src.point.z],
      nrm: [src.normal.x, src.normal.y, src.normal.z],
      guarded,
      weaponId: src.weaponId,
      material: src.material,
    });
    if (guarded && attacker) {
      w.emit({ t: "block", defender: target.slot, with: ARM_REGIONS.has(body) ? "arms" : "guard", pos: [src.point.x, src.point.y, src.point.z], strength: clamp01(J / 100) });
      target.stats.blocks++;
      target.inj.spendStamina(J * 0.12);
      if (target.inj.stamina <= 0) {
        // guard break
        target.enterStagger(0.55);
      }
    }
    this.emitNotes(target, out.notes, src.cause);
    // physical reaction on the hit body (any state)
    const imp = _v1.copyFrom(src.dir).scaleInPlace(Math.min(jEff * 0.45, target.rig.spec.bodies[bodyIdx].mass * 5.5));
    imp.y += jEff * 0.03;
    target.rig.bodies[bodyIdx].applyImpulse(imp, src.point);
    // limb loss
    if (out.detach) w.queueDetach(target, out.detach, src.dir, jEff);
    // state consequences
    let knockdown = false;
    if (target.state === "ragdoll") {
      // already down: shove the pelvis a bit
      target.rig.pelvis.applyImpulse(_v2.copyFrom(src.dir).scaleInPlace(jEff * 0.2), target.rig.nodes[0].position);
    } else if (!target.dead) {
      const kdThresh = 150 * resist;
      const bal = target.inj.balance - src.balanceDmg * clamp(jEff / Math.max(1, src.impulse), 0.4, 1.2) * target.fx.balanceLossMult * (guarded ? 0.4 : 1) * (target.recoveryProtect > 0 ? 0.4 : 1);
      target.inj.balance = Math.max(0, bal);
      const unconscious = target.inj.unconscious;
      let kdOk = true;
      if (!unconscious && (J >= kdThresh || target.inj.balance <= 0) && !guarded && target.recoveryProtect <= 0) {
        const chance = target.inj.recordKnockdown();
        kdOk = w.rng.next() < chance;
        if (kdOk || J > kdThresh * 1.8) {
          knockdown = true;
          const v = _v3.copyFrom(src.dir).scaleInPlace(clamp((J / target.mass) * 1.5 + src.knockback, 1.5, 9));
          v.y = 1.2 + J / 120;
          target.enterRagdoll("knockdown", v);
          target.inj.balance = 60;
        }
      }
      if (!knockdown && !unconscious) {
        // knockback + stagger
        const kb = clamp((src.knockback * (jEff / 60)) / resist, 0, 6);
        target.ext.x += src.dir.x * kb * (guarded ? 0.4 : 1);
        target.ext.z += src.dir.z * kb * (guarded ? 0.4 : 1);
        if (!guarded && (target.inj.balance < 35 || J > 70) && target.recoveryProtect <= 0 && target.state !== "stagger") {
          target.enterStagger(clamp(0.16 + J / 420, 0.16, 0.55));
          if (target.inj.balance < 20) target.inj.balance = 45; // brief re-balance so stagger doesn't chain forever
        }
      }
      if (out.blackout || out.knockout || out.fatal) {
        const v = _v3.copyFrom(src.dir).scaleInPlace(clamp(J / target.mass + 1.5, 1.5, 7));
        v.y = 1.5;
        target.enterRagdoll(out.fatal ? "dead" : out.knockout ? "ko" : "limp", v);
      }
    }
    if (out.blackout || out.knockout || out.fatal) {
      // knock held items free
      w.props.releaseAll(target, "unconscious");
    }
    return { landed: true, guarded, vitalityLoss: out.vitalityLoss, knockdown, outcome: out };
  }

  emitNotes(target: Fighter, notes: InjuryNote[], cause: string) {
    const w = this.world;
    for (const n of notes) {
      if (n.kind === "injury") {
        w.emit({ t: "injury", fighter: target.slot, region: n.region, level: n.level, kind: n.ik, label: n.label, cause });
        if (n.level >= 2) target.stats.majorInjuries.push(n.label);
        // arms dropped by breaking
        if (n.region === "forearmL" || n.region === "handL" || n.region === "upperArmL") {
          if (n.level >= 3 && target.heldMain && target.fx.gripL < 0.3) w.props.releaseAll(target, "arm shattered");
        }
        if ((n.region === "forearmR" || n.region === "handR" || n.region === "upperArmR") && n.level >= 3 && target.fx.gripR < 0.3) w.props.releaseAll(target, "arm shattered");
      } else {
        w.emit({ t: "consciousness", fighter: target.slot, state: n.state, cause: n.cause });
      }
    }
  }

  private regionFor(target: Fighter, bodyIdx: number, point: Vector3): BodyRegion {
    const body = RIG_BODIES[bodyIdx];
    if (body === "head") {
      const q = target.rig.nodes[bodyIdx].rotationQuaternion!;
      Quaternion.InverseToRef(q, _q);
      _v4.copyFrom(point).subtractInPlace(target.rig.nodes[bodyIdx].position).rotateByQuaternionToRef(_q, _v4);
      if (_v4.y < -0.045 * target.spec.height) return "neck";
    }
    return RIG_BODY_TO_REGION[body];
  }

  private faceFor(target: Fighter, point: Vector3): FaceRegion | null {
    const idx = RIG_INDEX.head;
    const q = target.rig.nodes[idx].rotationQuaternion!;
    Quaternion.InverseToRef(q, _q);
    const l = _v4.copyFrom(point).subtractInPlace(target.rig.nodes[idx].position).rotateByQuaternionToRef(_q, _v4);
    const f = target.spec.face;
    const slack = INJURY.faceHitRadiusBonus + 0.035;
    const test = (c: readonly [number, number, number], r: number) => Math.hypot(l.x - c[0], l.y - c[1], l.z - c[2]) < r + slack;
    if (test(f.eyeL.c, f.eyeL.r)) return "eyeL";
    if (test(f.eyeR.c, f.eyeR.r)) return "eyeR";
    if (test(f.nose.c, f.nose.r)) return "nose";
    return null;
  }

  // ------------------------------------------------------------------ collision-driven impacts
  private processCollisions() {
    const w = this.world;
    const slam: Map<number, { J: number; idx: number; point: Vector3; normal: Vector3; other: string; dir: Vector3 }> = new Map();
    for (const c of this.collisions) {
      const oa = w.phys.ownerOf(c.a);
      const ob = w.phys.ownerOf(c.b);
      if (!oa || !ob) continue;
      this.handlePair(oa, ob, c, c.a, c.b, slam);
      this.handlePair(ob, oa, c, c.b, c.a, slam);
    }
    for (const [slot, s] of slam) {
      const f = w.fighters[slot];
      if (w.time - this.slamLast[slot] < 0.22 || f.dead) continue;
      this.slamLast[slot] = w.time;
      const src: HitSource = {
        attacker: f.thrownBy >= 0 && f.thrownBy !== slot && f.thrownT < 3 ? f.thrownBy : -1,
        kind: "environment",
        impulse: s.J,
        heft: 0.4,
        material: s.other === "wall" || s.other === "static" ? "concrete" : "wood",
        weaponId: null,
        cause: s.other === "wall" ? "a wall" : s.other === "prop" ? "aggressive office furniture" : "the floor",
        environmental: true,
        balanceDmg: 20,
        knockback: 0,
        dir: s.dir.clone(),
        point: s.point.clone(),
        normal: s.normal.clone(),
      };
      this.hitFighter(f, s.idx, src);
      w.emit({ t: "impact", material: src.material, pos: [s.point.x, s.point.y, s.point.z], strength: clamp01(s.J / 180), a: "body", b: s.other });
    }
    this.clearCollisions();
  }

  private handlePair(me: { kind: string; id: string; slot?: number; index?: number }, other: { kind: string; id: string; slot?: number; index?: number }, c: CollisionRec, meBody: PhysicsBody, otherBody: PhysicsBody, slam: Map<number, { J: number; idx: number; point: Vector3; normal: Vector3; other: string; dir: Vector3 }>) {
    const w = this.world;
    if (me.kind === "rig") {
      const f = w.fighters[me.slot!];
      if (f.state !== "ragdoll" && f.state !== "getup") return;
      const v = f.preVel;
      const speed = v.length();
      if (speed < 3.6) return;
      let relSpeed = speed;
      if (other.kind === "rig") {
        const of = w.fighters[other.slot!];
        if (of === f) return;
        relSpeed = _v1.copyFrom(v).subtractInPlace(of.preVel).length();
        // thrown body hits the other fighter: both are hurt, the other by a smaller amount
        if (of.state !== "ragdoll" && relSpeed > 4 && f.thrownBy >= 0) {
          const J = f.mass * 0.14 * relSpeed;
          this.hitFighter(of, other.index!, {
            attacker: f.slot,
            kind: "thrown",
            impulse: J,
            heft: 0.3,
            material: "flesh",
            weaponId: null,
            cause: "a flying fighter",
            balanceDmg: 40,
            knockback: 3,
            dir: v.clone().normalize(),
            point: c.point.clone(),
            normal: c.normal.clone(),
          });
        }
      } else if (other.kind === "prop") {
        const p = w.props.byId.get(other.id);
        if (p) {
          relSpeed = _v1.copyFrom(v).subtractInPlace(p.lastVel).length();
          if (relSpeed > 5.5 && p.def.mass > 4) w.props.damage(p, f.mass * 0.18 * relSpeed, f.slot);
          if (p.anchored && relSpeed * f.mass * 0.5 >= p.anchorThreshold) w.releaseAnchor(p);
        }
      } else if (other.kind === "chunk") return;
      const J = f.mass * 0.2 * relSpeed;
      const prev = slam.get(f.slot);
      if (!prev || prev.J < J) {
        slam.set(f.slot, { J, idx: me.index!, point: c.point.clone(), normal: c.normal.clone(), other: other.kind, dir: v.clone().normalize() });
      }
      return;
    }
    if (me.kind === "prop") {
      const p = w.props.byId.get(me.id);
      if (!p || p.holder) return;
      const speed = p.lastSpeed;
      if (other.kind === "rig") {
        const f = w.fighters[other.slot!];
        if (speed < 4.2 || f.dead) return;
        if (p.thrownBy === f.slot && p.thrownT < 0.45) return;
        const key = `${f.slot}`;
        const lastT = p.hitRecent.get(key);
        if (lastT !== undefined && w.time - lastT < 0.45) return;
        p.hitRecent.set(key, w.time);
        f.pointVelocity(RIG_BODIES[other.index!], c.point, _v2);
        const rel = _v1.copyFrom(p.lastVel).subtractInPlace(_v2);
        const relSpeed = rel.length();
        if (relSpeed < 3.5) return;
        const J = p.def.mass * relSpeed * p.def.throwDamageMult * (p.def.id === "limb" ? 1.2 : 1);
        const src: HitSource = {
          attacker: p.thrownBy,
          kind: "thrown",
          impulse: J,
          heft: p.def.damage.heft,
          material: p.def.damage.material,
          weaponId: p.def.id,
          cause: `a thrown ${p.def.name.toLowerCase()}`,
          balanceDmg: 16 * p.def.damage.stagger,
          knockback: 1.5,
          dir: rel.clone().normalize(),
          point: c.point.clone(),
          normal: c.normal.clone(),
        };
        const rep = this.hitFighter(f, other.index!, src);
        if (rep.landed && p.thrownBy >= 0) w.fighters[p.thrownBy].stats.hits++;
        w.props.damage(p, J * 1.1, p.thrownBy);
        w.emit({ t: "impact", material: p.def.damage.material, pos: [c.point.x, c.point.y, c.point.z], strength: clamp01(J / 120), a: p.def.damage.sound, b: "flesh" });
      } else if (other.kind === "wall" || other.kind === "static" || other.kind === "door") {
        if (speed > 5) {
          w.props.damage(p, p.def.mass * speed * 1.0, p.thrownBy);
          w.emit({ t: "impact", material: p.def.damage.material, pos: [c.point.x, c.point.y, c.point.z], strength: clamp01(p.def.mass * speed / 60), a: p.def.damage.sound, b: "wall" });
        }
      } else if (other.kind === "prop") {
        const q = w.props.byId.get(other.id);
        if (q && speed > 5) {
          w.props.damage(q, p.def.mass * speed * 0.7, p.thrownBy);
          w.props.damage(p, p.def.mass * speed * 0.4, p.thrownBy);
          w.emit({ t: "impact", material: p.def.damage.material, pos: [c.point.x, c.point.y, c.point.z], strength: clamp01(p.def.mass * speed / 60), a: p.def.damage.sound, b: q.def.damage.sound });
          if (q.anchored && p.def.mass * speed >= q.anchorThreshold) w.releaseAnchor(q);
        }
      }
    }
  }
}

void BLOCKER_MASK;

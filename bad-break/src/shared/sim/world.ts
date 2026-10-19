/**
 * The authoritative simulation world. Runs identically offline (browser) and on the match server (Node):
 * only Babylon scene/physics objects (TransformNodes, bodies, constraints) - no rendering.
 *
 * Fixed step: SIM.hz ticks per second, each tick = `substeps` Havok steps. All structural changes
 * (breaking, detaching, spawning, releasing grips) are queued with defer() and run after the physics
 * step - a safe boundary.
 */
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { Scene } from "@babylonjs/core/scene.js";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent.js";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import type { PhysicsEngine } from "@babylonjs/core/Physics/v2/physicsEngine.js";
import { DEFAULT_MATCH, SIM, type MatchSettings } from "../config.js";
import { ARENAS, type ArenaDef } from "../data/arenas.js";
import { PROPS, type PropDef, type PropShapePart } from "../data/props.js";
import { LIMB_BRANCHES, RIG_BODIES, RIG_INDEX, type LimbId, type RigBody } from "../data/regions.js";
import type { V3 } from "../data/rigspec.js";
import { Rng, isFiniteVec } from "../math.js";
import { CombatSystem } from "./combat.js";
import { DestructionSystem } from "./destruction.js";
import type { SimEvent, SimEventInput } from "./events.js";
import { Fighter } from "./fighter.js";
import { GrappleSystem } from "./grapple.js";
import { emptyIntent, type Intent } from "./input.js";
import type { InjuryNote } from "./injury.js";
import { MatchSystem } from "./match.js";
import { PhysHelper } from "./phys.js";
import { Prop, PropSystem } from "./props.js";

export interface WorldOptions {
  scene: Scene;
  havok: unknown;
  arenaId?: string;
  fighters: [string, string];
  seed?: number;
  match?: Partial<MatchSettings>;
  substeps?: number;
  /** Practice mode: no match flow, fighters never lose. */
  practice?: boolean;
}

export interface LimbSegment {
  body: RigBody;
  pos: V3;
  q: readonly [number, number, number, number];
}
declare module "./props.js" {
  interface Prop {
    limbSegments?: LimbSegment[];
  }
}

export class SimWorld {
  readonly scene: Scene;
  readonly pe: PhysicsEngine;
  readonly plugin: HavokPlugin;
  readonly phys: PhysHelper;
  readonly rng: Rng;
  readonly arena: ArenaDef;
  readonly fighters: Fighter[] = [];
  readonly props: PropSystem;
  readonly grapples: GrappleSystem;
  readonly combat: CombatSystem;
  readonly destruction: DestructionSystem;
  readonly match: MatchSystem;
  readonly matchSettings: MatchSettings;
  readonly substeps: number;
  readonly practice: boolean;
  readonly floorY = 0;
  time = 0;
  tick = 0;
  events: SimEvent[] = [];
  rev = 0;
  perf = { physics: 0, logic: 0, total: 0, bodies: 0 };
  corrections = 0;
  private deferred: (() => void)[] = [];
  private seed: number;
  private disposed = false;

  constructor(opts: WorldOptions) {
    this.scene = opts.scene;
    this.substeps = opts.substeps ?? 2;
    this.practice = !!opts.practice;
    this.seed = opts.seed ?? 1337;
    this.rng = new Rng(this.seed);
    this.matchSettings = { ...DEFAULT_MATCH, ...(opts.match ?? {}) };
    // physics: fixed Havok step, scene's own auto-stepping disabled
    const plugin = new HavokPlugin(false, opts.havok);
    this.scene.enablePhysics(new Vector3(0, SIM.gravity, 0), plugin);
    this.scene.physicsEnabled = false;
    plugin.setTimeStep(SIM.dt / this.substeps);
    plugin.setVelocityLimits(SIM.maxLinearSpeed, SIM.maxAngularSpeed);
    this.plugin = plugin;
    this.pe = this.scene.getPhysicsEngine()! as unknown as PhysicsEngine;
    this.phys = new PhysHelper(this.scene);
    this.arena = ARENAS[opts.arenaId ?? "breakRoom"];
    this.props = new PropSystem(this);
    this.grapples = new GrappleSystem(this);
    this.combat = new CombatSystem(this);
    this.destruction = new DestructionSystem(this);
    this.match = new MatchSystem(this, opts.match);
    plugin.onCollisionObservable.add((ev) => {
      this.combat.record(ev.collider, ev.collidedAgainst, ev.impulse, ev.point, ev.normal);
    });
    this.destruction.build(this.arena);
    this.spawnArenaProps();
    for (let s = 0; s < 2; s++) {
      const f = new Fighter(this, s, opts.fighters[s], this.arena.spawns[s]);
      this.fighters.push(f);
      this.registerRig(f);
    }
    // let everything settle on the floor before the round begins
    this.match.begin();
  }

  private registerRig(f: Fighter) {
    const reg = (i: number, body: unknown) => {
      this.phys.register(body as never, { kind: "rig", id: `f${f.slot}.${RIG_BODIES[i]}`, slot: f.slot, index: i });
    };
    for (let i = 0; i < f.rig.bodies.length; i++) if (f.rig.attached[i]) reg(i, f.rig.bodies[i]);
    f.rig.onBodyCreated = (i, body) => reg(i, body);
    f.rig.onBodyRemoved = (_i, body) => this.phys.unregister(body);
  }

  private spawnArenaProps() {
    const a = this.arena;
    for (const f of a.furniture) {
      this.props.spawn(f.prop, f.pos, { yaw: f.yaw, anchored: f.anchoredUntil, id: f.id });
    }
    for (const p of a.props) {
      this.props.spawn(p.prop, p.pos, { yaw: p.yaw, pitch: p.pitch, roll: p.roll });
    }
  }

  // ------------------------------------------------------------------ events / deferral
  emit(ev: SimEventInput) {
    const e = { ...ev, rev: ++this.rev } as SimEvent;
    this.events.push(e);
  }
  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }
  /** Run at the next safe boundary (after the physics step). */
  defer(fn: () => void) {
    this.deferred.push(fn);
  }
  private flushDeferred() {
    let guard = 0;
    while (this.deferred.length && guard++ < 8) {
      const list = this.deferred;
      this.deferred = [];
      for (const fn of list) {
        try {
          fn();
        } catch (e) {
          console.error("[sim] deferred op failed", e);
        }
      }
    }
  }

  // ------------------------------------------------------------------ the fixed step
  step(intents: readonly [Intent, Intent]) {
    const t0 = performance.now();
    const dt = SIM.dt;
    this.tick++;
    this.time += dt;
    // 1. inputs (gated by match phase)
    for (let s = 0; s < 2; s++) {
      const f = this.fighters[s];
      const gated = this.match.gate(intents[s] ?? emptyIntent(), s);
      f.setIntent(gated);
    }
    // 2. grapples steer held fighters, then fighters decide & drive
    this.grapples.step(dt);
    for (const f of this.fighters) f.preStep(dt);
    this.props.preStep(dt);
    for (const f of this.fighters) f.recordPreVel();
    this.flushDeferred();
    // 3. physics (substeps), kinematic roots eased across substeps
    const t1 = performance.now();
    const h = dt / this.substeps;
    for (let k = 1; k <= this.substeps; k++) {
      for (const f of this.fighters) f.rig.applyRootSub(k, this.substeps);
      this.pe._step(h);
    }
    const t2 = performance.now();
    // 4. post-step: snapshots, combat, destruction, injuries
    for (const f of this.fighters) f.rig.snapshotRender();
    this.props.postStep();
    this.combat.step(dt);
    this.destruction.step(dt);
    for (const f of this.fighters) f.postStep(dt);
    this.flushDeferred();
    this.match.step(dt);
    this.sanity();
    const t3 = performance.now();
    this.perf.physics = t2 - t1;
    this.perf.logic = t3 - t0 - (t2 - t1);
    this.perf.total = t3 - t0;
  }

  /** Detects invalid transforms and runaway bodies, repairs them and counts the correction. */
  private sanity() {
    for (const f of this.fighters) {
      const p = f.rig.nodes[0].position;
      if (!isFiniteVec(p) || p.y < -25 || Math.abs(p.x) > 60 || Math.abs(p.z) > 60) {
        this.corrections++;
        const sp = this.arena.spawns[f.slot];
        f.inj.vitality = f.inj.vitality; // unchanged: this is a safety net, not gameplay
        f.releaseEverything("safety");
        f.restoreAndPlace(sp.pos, sp.yaw);
      }
    }
    for (const p of [...this.props.list]) {
      if (!isFiniteVec(p.node.position) || p.node.position.y < -25) {
        this.corrections++;
        this.props.remove(p);
      }
    }
  }

  // ------------------------------------------------------------------ queries
  nearSolid(p: Vector3, r: number): boolean {
    for (const s of this.arena.solids) {
      if (s.kind === "floor" || s.kind === "ceiling") continue;
      const dx = Math.max(0, Math.abs(p.x - s.c[0]) - s.half[0]);
      const dz = Math.max(0, Math.abs(p.z - s.c[2]) - s.half[2]);
      if (Math.hypot(dx, dz) < r && p.y < s.c[1] + s.half[1] + 0.3) return true;
    }
    for (const pr of this.props.list) {
      if (pr.def.weight === "heavy" || pr.def.weight === "fixture") {
        if (Math.hypot(pr.node.position.x - p.x, pr.node.position.z - p.z) < r + 0.4) return true;
      }
    }
    return false;
  }

  releaseAnchor(p: Prop) {
    if (!p.anchored) return;
    p.anchored = false;
    this.defer(() => {
      p.body.setMotionType(2 /* DYNAMIC */);
      this.emit({ t: "furnitureBreak", id: p.id, kind: p.def.id, pos: [p.node.position.x, p.node.position.y, p.node.position.z] });
    });
  }

  enforcePropBudget() {
    const list = this.props.list;
    if (list.length <= this.props.maxActive) return;
    const extras = list.filter((p) => p.piece && !p.holder).sort((a, b) => a.createdAt - b.createdAt);
    while (list.length > this.props.maxActive && extras.length) this.props.remove(extras.shift()!);
  }

  // ------------------------------------------------------------------ dismemberment
  queueDetach(target: Fighter, limb: LimbId, dir: Vector3, impulse: number) {
    const d = dir.clone();
    this.defer(() => this.detachLimb(target, limb, d, impulse));
  }

  /** Commit once, remove the joint, release grips, hand the branch to a free limb object, emit one event. */
  detachLimb(f: Fighter, limb: LimbId, dir: Vector3, impulse: number) {
    if (!f.inj.attached[limb]) return; // never twice
    const notes: InjuryNote[] = [];
    if (!f.inj.commitDetach(limb, notes)) return;
    f.injuryChanged();
    const side = limb.endsWith("L") ? "L" : "R";
    if (limb.startsWith("arm")) {
      this.props.onArmLost(f, side);
    }
    if (f.grappleOther) this.grapples.end(f, "limb lost");
    const rootName = LIMB_BRANCHES[limb][0];
    const sev = f.rig.severJoint(rootName);
    if (sev.length === 0) return;
    const prop = this.makeLimbProp(f, limb, sev, dir, impulse);
    this.combat.emitNotes(f, notes, f.inj.lastCause);
    this.emit({ t: "limbDetached", fighter: f.slot, limb, objectId: prop.id, pos: [prop.node.position.x, prop.node.position.y, prop.node.position.z] });
    // a leg loss unbalances an upright fighter
    if (limb.startsWith("leg") && f.state !== "ragdoll") {
      f.inj.balance = Math.min(f.inj.balance, 10);
      f.enterRagdoll("knockdown", dir.scale(2));
    } else if (f.state !== "ragdoll") f.enterStagger(0.5);
  }

  private makeLimbProp(f: Fighter, limb: LimbId, sev: ReturnType<typeof f.rig.severJoint>, dir: Vector3, impulse: number): Prop {
    const root = sev[0];
    const rootSpec = f.spec.bodies[root.index];
    const invQ = Quaternion.Inverse(root.q);
    const parts: PropShapePart[] = [];
    const segs: LimbSegment[] = [];
    let mass = 0;
    const tmp = new Vector3();
    for (const s of sev) {
      const bs = f.spec.bodies[s.index];
      mass += bs.mass;
      // relative transform of this segment in the root's frame
      const rel = s.pos.subtract(root.pos).rotateByQuaternionToRef(invQ, new Vector3());
      const relQ = invQ.multiply(s.q);
      segs.push({ body: bs.name, pos: [rel.x, rel.y, rel.z], q: [relQ.x, relQ.y, relQ.z, relQ.w] });
      const tr = (v: V3): V3 => {
        tmp.set(v[0], v[1], v[2]).rotateByQuaternionToRef(relQ, tmp).addInPlace(rel);
        return [tmp.x, tmp.y, tmp.z];
      };
      const sh = bs.shape;
      if (sh.kind === "capsule") parts.push({ kind: "capsule", a: tr(sh.a), b: tr(sh.b), r: sh.r });
      else if (sh.kind === "box") parts.push({ kind: "box", c: tr(sh.c), half: sh.half, rot: [relQ.x, relQ.y, relQ.z, relQ.w] });
      else parts.push({ kind: "sphere", c: tr(sh.c), r: sh.r });
    }
    const last = sev[sev.length - 1];
    const lastSpec = f.spec.bodies[last.index];
    const lastRel = last.pos.subtract(root.pos).rotateByQuaternionToRef(invQ, new Vector3());
    const gripPos: V3 = [rootSpec.pivotSelf[0], rootSpec.pivotSelf[1] - Math.sign(rootSpec.pivotSelf[1]) * 0.1, rootSpec.pivotSelf[2]];
    const def: PropDef = {
      ...PROPS.limb,
      id: "limb",
      name: `${limb.endsWith("L") ? "Left" : "Right"} ${limb.startsWith("arm") ? "Arm" : "Leg"}`,
      mass,
      parts,
      grips: [{ pos: gripPos, role: "main" }],
      strike: [[lastRel.x, lastRel.y - lastSpec.length * 0.4, lastRel.z], [0, 0, 0]],
      reach: lastRel.length() + 0.15,
    };
    const vel = sev[0].lin.add(dir.scale(Math.min(impulse * 0.04, 7))).add(new Vector3(0, 2.4, 0));
    const prop = this.props.spawn("limb", root.pos, { def, quat: root.q, vel, angVel: new Vector3(this.rng.range(-6, 6), this.rng.range(-6, 6), this.rng.range(-6, 6)), id: `limb.${f.slot}.${limb}.${this.tick}`, piece: true });
    prop.limb = limb;
    prop.limbOwner = f.slot;
    prop.limbSegments = segs;
    // keep it from colliding with its former owner for a moment
    prop.graceT = 0.5;
    return prop;
  }

  /** Restore severed limbs for a new round. */
  restoreFighterRig(f: Fighter) {
    f.rig.restoreAll(f.rig.target);
  }

  // ------------------------------------------------------------------ round reset
  resetRound() {
    // physics + topology + effects reset together
    for (const f of this.fighters) f.releaseEverything("round reset");
    this.props.clearAll();
    this.destruction.reset(this.arena);
    this.spawnArenaProps();
    this.grapplesReset();
    this.combat.clearCollisions();
    this.events.length = 0;
    this.deferred.length = 0;
    for (let s = 0; s < 2; s++) this.fighters[s].resetForRound(this.arena.spawns[s]);
  }
  private grapplesReset() {
    for (const f of this.fighters) {
      f.grappleRole = "none";
      f.grappleOther = null;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.props.clearAll();
    this.destruction.dispose();
    for (const f of this.fighters) {
      f.cc.dispose();
      f.rig.dispose();
    }
    this.plugin.onCollisionObservable.clear();
    this.scene.physicsEnabled = false;
  }
}

void RIG_INDEX;

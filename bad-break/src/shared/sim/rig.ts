/**
 * Active-ragdoll rig: 16 simplified physical bodies per fighter joined by limited 6-DoF constraints.
 *
 * Drivers (who writes each body's motion), see docs/ENGINEERING_NOTES.md "Bone drivers":
 *   UPRIGHT  : pelvis = kinematic target from the movement controller; every other body = bounded PD drive
 *              toward the hidden animation-target pose (tone 0..1).
 *   RAGDOLL  : pelvis = dynamic; all bodies free with low residual tone (bracing) or zero tone (limp).
 *   GETUP    : pelvis = kinematic target from the get-up script; others PD toward get-up pose.
 *   DETACHED : the detached branch is removed from this rig and owned by a free LimbObject.
 */
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import { PhysicsShape, PhysicsShapeBox, PhysicsShapeCapsule, PhysicsShapeSphere } from "@babylonjs/core/Physics/v2/physicsShape.js";
import { Physics6DoFConstraint } from "@babylonjs/core/Physics/v2/physicsConstraint.js";
import { PhysicsConstraintAxis as A, PhysicsMotionType, PhysicsPrestepType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import type { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import { RIG_BODIES, RIG_COUNT, RIG_INDEX, RIG_PARENT, type RigBody } from "../data/regions.js";
import type { BodySpec, JointLimits, RigSpec, V3 } from "../data/rigspec.js";
import { clamp, rotationErrorToRef } from "../math.js";
import { FkResult, Pose, computeFK } from "./fk.js";
import { ragCollideMask, ragGroup } from "./groups.js";

const PD_RESPONSE = 0.65; // fraction of the deadbeat correction applied each tick (smoothness)

interface FrameDef {
  main: V3;
  perp: V3;
}
/** Constraint frame per body: arms/legs/hands/feet use X as main (flexion is the big range), torso/head use Y. */
function frameFor(name: RigBody): FrameDef {
  switch (name) {
    case "spine":
    case "chest":
    case "head":
      return { main: [0, 1, 0], perp: [1, 0, 0] };
    default:
      return { main: [1, 0, 0], perp: [0, 0, 1] };
  }
}
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
interface AxisLimit {
  axis: number;
  minLimit: number;
  maxLimit: number;
}
/** Map rest-frame (x,y,z) rotation limits to Havok angular axes for the chosen frame. */
function angularLimits(frame: FrameDef, lim: JointLimits): AxisLimit[] {
  const t = cross(frame.main, frame.perp);
  const frameVecs: [number, V3][] = [
    [A.ANGULAR_X, frame.main],
    [A.ANGULAR_Y, frame.perp],
    [A.ANGULAR_Z, t],
  ];
  const out: AxisLimit[] = [];
  for (const [axis, v] of frameVecs) {
    let world: "x" | "y" | "z" = "x";
    let sign = 1;
    if (Math.abs(v[0]) > 0.5) {
      world = "x";
      sign = Math.sign(v[0]);
    } else if (Math.abs(v[1]) > 0.5) {
      world = "y";
      sign = Math.sign(v[1]);
    } else {
      world = "z";
      sign = Math.sign(v[2]);
    }
    const r = lim[world];
    if (!r) out.push({ axis, minLimit: 0, maxLimit: 0 });
    else if (sign > 0) out.push({ axis, minLimit: r[0], maxLimit: r[1] });
    else out.push({ axis, minLimit: -r[1], maxLimit: -r[0] });
  }
  return out;
}

export interface RigOptions {
  scene: Scene;
  spec: RigSpec;
  slot: number; // 0 or 1 - selects collision group
  name: string;
}

const _tmpA = new Vector3();
const _tmpB = new Vector3();
const _tmpC = new Vector3();
const _tmpD = new Vector3();
const _qa = Quaternion.Identity();

export interface SeveredBody {
  index: number;
  pos: Vector3;
  q: Quaternion;
  lin: Vector3;
  ang: Vector3;
}

export class Rig {
  readonly scene: Scene;
  readonly spec: RigSpec;
  readonly slot: number;
  readonly name: string;
  readonly nodes: TransformNode[] = [];
  readonly bodies: PhysicsBody[] = [];
  readonly shapes: PhysicsShape[] = [];
  readonly constraints: (Physics6DoFConstraint | null)[] = [];
  /** attached[i] false once a branch has been severed; those entries are disposed. */
  readonly attached: boolean[] = [];
  readonly fk = new FkResult();
  readonly target = new FkResult();
  /** Drive strength per body, 0 (limp) .. 1 (full). Written by the fighter state machine. */
  readonly tone = new Float32Array(RIG_COUNT);
  /** Extra strength multiplier from injuries (broken limb -> weak), 0..1. */
  readonly injuryTone = new Float32Array(RIG_COUNT).fill(1);
  /** Previous/current transforms for render interpolation, updated by the sim after each step. */
  readonly prevPos: Vector3[] = [];
  readonly prevQ: Quaternion[] = [];
  readonly curPos: Vector3[] = [];
  readonly curQ: Quaternion[] = [];
  private rootKinematic = false;
  private lastDamping = new Float32Array(RIG_COUNT).fill(-1);
  private plugin: HavokPlugin;
  private _lastFlags = 0;

  constructor(opts: RigOptions) {
    this.scene = opts.scene;
    this.spec = opts.spec;
    this.slot = opts.slot;
    this.name = opts.name;
    this.plugin = opts.scene.getPhysicsEngine()!.getPhysicsPlugin() as HavokPlugin;
    const membership = ragGroup(opts.slot);
    const collide = ragCollideMask(opts.slot);
    this.fkRest();
    for (let i = 0; i < RIG_COUNT; i++) {
      const bs = this.spec.bodies[i];
      const node = new TransformNode(`${opts.name}.${bs.name}`, opts.scene);
      node.rotationQuaternion = Quaternion.Identity();
      node.position.set(bs.restCenter[0], bs.restCenter[1], bs.restCenter[2]);
      this.nodes.push(node);
      this.bodies.push(null as unknown as PhysicsBody);
      this.shapes.push(null as unknown as PhysicsShape);
      this.constraints.push(null);
      this.attached.push(false);
      this.prevPos.push(node.position.clone());
      this.curPos.push(node.position.clone());
      this.prevQ.push(Quaternion.Identity());
      this.curQ.push(Quaternion.Identity());
      this.createBody(i);
    }
    for (let i = 1; i < RIG_COUNT; i++) this.createJoint(i);
    this.tone.fill(1);
  }

  /** (Re)creates the physics body + shape for rig body i on its existing node. */
  private createBody(i: number) {
    const bs = this.spec.bodies[i];
    const node = this.nodes[i];
    const body = new PhysicsBody(node, PhysicsMotionType.DYNAMIC, false, this.scene);
    const shape = this.makeShape(bs);
    shape.filterMembershipMask = ragGroup(this.slot);
    shape.filterCollideMask = ragCollideMask(this.slot);
    shape.material = { friction: bs.name.startsWith("foot") ? 0.9 : 0.6, restitution: 0.02 };
    body.shape = shape;
    body.setMassProperties({
      mass: bs.mass,
      centerOfMass: Vector3.Zero(),
      inertia: new Vector3(bs.inertia[0], bs.inertia[1], bs.inertia[2]),
      inertiaOrientation: Quaternion.Identity(),
    });
    body.setLinearDamping(0.05);
    body.setAngularDamping(bs.drive.damping);
    body.disablePreStep = true;
    this.plugin.setEventMask(body, (this.plugin as unknown as { _hknp: { EventType: { COLLISION_STARTED: { value: number } } } })._hknp.EventType.COLLISION_STARTED.value);
    this.bodies[i] = body;
    this.shapes[i] = shape;
    this.attached[i] = true;
    this.lastDamping[i] = -1;
    this.onBodyCreated?.(i, body);
  }

  private createJoint(i: number) {
    const name = RIG_BODIES[i];
    const bs = this.spec.bodies[i];
    const parentIdx = RIG_INDEX[RIG_PARENT[name as Exclude<RigBody, "pelvis">]];
    const frame = frameFor(name);
    const limits: { axis: number; minLimit?: number; maxLimit?: number }[] = [
      { axis: A.LINEAR_X, minLimit: 0, maxLimit: 0 },
      { axis: A.LINEAR_Y, minLimit: 0, maxLimit: 0 },
      { axis: A.LINEAR_Z, minLimit: 0, maxLimit: 0 },
      ...angularLimits(frame, bs.limits),
    ];
    const c = new Physics6DoFConstraint(
      {
        pivotA: new Vector3(bs.pivotParent[0], bs.pivotParent[1], bs.pivotParent[2]),
        pivotB: new Vector3(bs.pivotSelf[0], bs.pivotSelf[1], bs.pivotSelf[2]),
        axisA: new Vector3(frame.main[0], frame.main[1], frame.main[2]),
        axisB: new Vector3(frame.main[0], frame.main[1], frame.main[2]),
        perpAxisA: new Vector3(frame.perp[0], frame.perp[1], frame.perp[2]),
        perpAxisB: new Vector3(frame.perp[0], frame.perp[1], frame.perp[2]),
        collision: false,
      },
      limits,
      this.scene,
    );
    this.bodies[parentIdx].addConstraint(this.bodies[i], c);
    this.constraints[i] = c;
  }

  /** Called whenever a body is (re)created so the owner can register it for lookups. */
  onBodyCreated: ((i: number, body: PhysicsBody) => void) | null = null;

  /** Rebuild every severed branch at the given FK pose (round reset). Nodes keep their identity. */
  restoreAll(fk: FkResult) {
    const missing: number[] = [];
    for (let i = 0; i < RIG_COUNT; i++) if (!this.attached[i]) missing.push(i);
    for (const i of missing) {
      this.nodes[i].position.copyFrom(fk.p[i]);
      this.nodes[i].rotationQuaternion!.copyFrom(fk.q[i]);
      this.createBody(i);
    }
    for (const i of missing) {
      this.createJoint(i);
      this.teleportBody(i, fk.p[i], fk.q[i]);
    }
  }

  private fkRest() {
    const pose = new Pose();
    pose.rootPos.set(0, this.spec.pelvisHeight, 0);
    computeFK(this.spec, pose, this.fk);
  }

  private makeShape(bs: BodySpec): PhysicsShape {
    const s = bs.shape;
    switch (s.kind) {
      case "capsule":
        return new PhysicsShapeCapsule(new Vector3(...s.a), new Vector3(...s.b), s.r, this.scene);
      case "box":
        return new PhysicsShapeBox(new Vector3(...s.c), Quaternion.Identity(), new Vector3(s.half[0] * 2, s.half[1] * 2, s.half[2] * 2), this.scene);
      case "sphere":
        return new PhysicsShapeSphere(new Vector3(...s.c), s.r, this.scene);
    }
  }

  get pelvis(): PhysicsBody {
    return this.bodies[0];
  }

  /** Teleport the whole rig to a pose (FK world transforms) and zero velocities. */
  teleportToFk(fk: FkResult) {
    for (let i = 0; i < RIG_COUNT; i++) {
      if (!this.attached[i]) continue;
      this.teleportBody(i, fk.p[i], fk.q[i]);
    }
    this.snapshotRender(true);
  }

  teleportBody(i: number, p: Vector3, q: Quaternion) {
    const node = this.nodes[i];
    node.position.copyFrom(p);
    node.rotationQuaternion!.copyFrom(q);
    const body = this.bodies[i];
    const prev = body.getPrestepType();
    body.setPrestepType(PhysicsPrestepType.TELEPORT);
    this.plugin.setPhysicsBodyTransformation(body, node);
    body.setPrestepType(prev);
    body.setLinearVelocity(Vector3.ZeroReadOnly);
    body.setAngularVelocity(Vector3.ZeroReadOnly);
  }

  /** Switch the pelvis between kinematic (controller/script owned) and dynamic (ragdoll owned). */
  setRootKinematic(kinematic: boolean, inheritLinear?: Vector3) {
    if (kinematic === this.rootKinematic) return;
    const b = this.pelvis;
    if (kinematic) {
      b.setMotionType(PhysicsMotionType.ANIMATED);
      b.setLinearVelocity(Vector3.ZeroReadOnly);
      b.setAngularVelocity(Vector3.ZeroReadOnly);
    } else {
      b.setMotionType(PhysicsMotionType.DYNAMIC);
      if (inheritLinear) b.setLinearVelocity(inheritLinear);
    }
    this.rootKinematic = kinematic;
    this.rootInit = false;
  }
  get isRootKinematic(): boolean {
    return this.rootKinematic;
  }
  private rootFromP = new Vector3();
  private rootFromQ = Quaternion.Identity();
  private rootToP = new Vector3();
  private rootToQ = Quaternion.Identity();
  private rootInit = false;
  /** Set the pelvis target for this tick; applied progressively across physics substeps by applyRootSub. */
  setRootTarget(p: Vector3, q: Quaternion) {
    if (!this.rootInit) {
      this.rootFromP.copyFrom(this.nodes[0].position);
      this.rootFromQ.copyFrom(this.nodes[0].rotationQuaternion!);
      this.rootInit = true;
    } else {
      this.rootFromP.copyFrom(this.rootToP);
      this.rootFromQ.copyFrom(this.rootToQ);
    }
    this.rootToP.copyFrom(p);
    this.rootToQ.copyFrom(q);
  }
  /** Substep k of n (1-based): drive the kinematic pelvis part of the way to this tick's target. */
  applyRootSub(k: number, n: number) {
    if (!this.rootKinematic || !this.rootInit) return;
    const t = k / n;
    _tmpA.copyFrom(this.rootFromP).scaleInPlace(1 - t).addInPlace(_tmpB.copyFrom(this.rootToP).scaleInPlace(t));
    Quaternion.SlerpToRef(this.rootFromQ, this.rootToQ, t, _qa);
    this.pelvis.setTargetTransform(_tmpA, _qa);
  }
  /** Forget interpolation history (after teleports / mode switches). */
  resetRootHistory() {
    this.rootInit = false;
  }

  /** Computes world-space targets for the current pose. */
  computeTargets(pose: Pose) {
    computeFK(this.spec, pose, this.target);
  }

  /**
   * Bounded PD drive of every attached non-kinematic body toward `this.target`.
   * Every quantity is clamped: desired angular speed, commanded angular acceleration (-> torque bound),
   * and the impulse magnitude. Reaction impulses are applied to the parent for momentum conservation.
   */
  applyDrives(dt: number): void {
    for (let i = 0; i < RIG_COUNT; i++) {
      if (!this.attached[i]) continue;
      if (i === 0 && this.rootKinematic) continue;
      const tone = this.tone[i] * this.injuryTone[i];
      const bs = this.spec.bodies[i];
      // dynamic damping blend: limp bodies get ragdoll damping, driven bodies lighter
      const dmp = bs.drive.damping * (0.6 + 0.4 * (1 - tone)) + (1 - tone) * 1.2;
      if (Math.abs(dmp - this.lastDamping[i]) > 0.05) {
        this.bodies[i].setAngularDamping(dmp);
        this.lastDamping[i] = dmp;
      }
      if (tone < 0.01) continue;
      const body = this.bodies[i];
      const q = this.nodes[i].rotationQuaternion!;
      rotationErrorToRef(q, this.target.q[i], _tmpA); // world-space axis*angle
      // desired angular velocity
      const d = bs.drive;
      _tmpA.scaleInPlace(d.gain);
      const sp = _tmpA.length();
      if (sp > d.maxSpeed) _tmpA.scaleInPlace(d.maxSpeed / sp);
      body.getAngularVelocityToRef(_tmpB);
      _tmpA.subtractInPlace(_tmpB); // delta omega
      // bound angular acceleration
      const maxDw = d.maxAccel * dt * tone;
      const dw = _tmpA.length();
      if (dw > maxDw) _tmpA.scaleInPlace(maxDw / dw);
      _tmpA.scaleInPlace(PD_RESPONSE);
      // impulse = R * (I o (R^T * dw))
      Quaternion.InverseToRef(q, _qa);
      _tmpA.rotateByQuaternionToRef(_qa, _tmpC);
      _tmpC.set(_tmpC.x * bs.inertia[0], _tmpC.y * bs.inertia[1], _tmpC.z * bs.inertia[2]);
      _tmpC.rotateByQuaternionToRef(q, _tmpD);
      if (!Number.isFinite(_tmpD.x + _tmpD.y + _tmpD.z)) continue;
      body.applyAngularImpulse(_tmpD);
      if (i > 0) {
        const pi = RIG_INDEX[RIG_PARENT[RIG_BODIES[i] as Exclude<RigBody, "pelvis">]];
        if (this.attached[pi] && !(pi === 0 && this.rootKinematic)) {
          _tmpD.scaleInPlace(-0.5);
          this.bodies[pi].applyAngularImpulse(_tmpD);
        }
      }
    }
  }

  /** Capture current body transforms for render interpolation (call after every physics step). */
  snapshotRender(reset = false) {
    for (let i = 0; i < RIG_COUNT; i++) {
      if (!this.attached[i]) continue;
      if (reset) {
        this.curPos[i].copyFrom(this.nodes[i].position);
        this.curQ[i].copyFrom(this.nodes[i].rotationQuaternion!);
        this.prevPos[i].copyFrom(this.curPos[i]);
        this.prevQ[i].copyFrom(this.curQ[i]);
      } else {
        this.prevPos[i].copyFrom(this.curPos[i]);
        this.prevQ[i].copyFrom(this.curQ[i]);
        this.curPos[i].copyFrom(this.nodes[i].position);
        this.curQ[i].copyFrom(this.nodes[i].rotationQuaternion!);
      }
    }
  }

  /** Worst gap between a joint's parent-side and child-side anchors (metres). Diagnostic + stretch guard. */
  maxJointGap(): number {
    let worst = 0;
    for (let i = 1; i < RIG_COUNT; i++) {
      if (!this.attached[i]) continue;
      const pi = RIG_INDEX[RIG_PARENT[RIG_BODIES[i] as Exclude<RigBody, "pelvis">]];
      const bs = this.spec.bodies[i];
      _tmpA.set(bs.pivotParent[0], bs.pivotParent[1], bs.pivotParent[2]).rotateByQuaternionToRef(this.nodes[pi].rotationQuaternion!, _tmpA).addInPlace(this.nodes[pi].position);
      _tmpB.set(bs.pivotSelf[0], bs.pivotSelf[1], bs.pivotSelf[2]).rotateByQuaternionToRef(this.nodes[i].rotationQuaternion!, _tmpB).addInPlace(this.nodes[i].position);
      worst = Math.max(worst, Vector3.Distance(_tmpA, _tmpB));
    }
    return worst;
  }

  /**
   * Sever the joint above `root` (and with it every descendant). Captures each removed body's state, then
   * disposes constraints, bodies and shapes (the TransformNodes are kept so the rig can be restored).
   * Must be called outside the physics step.
   */
  severJoint(root: RigBody): SeveredBody[] {
    const removed: number[] = [];
    const ri = RIG_INDEX[root];
    if (!this.attached[ri]) return [];
    const stack = [ri];
    while (stack.length) {
      const i = stack.pop()!;
      if (!this.attached[i] || removed.includes(i)) continue;
      removed.push(i);
      for (let c = 1; c < RIG_COUNT; c++) {
        if (this.attached[c] && RIG_INDEX[RIG_PARENT[RIG_BODIES[c] as Exclude<RigBody, "pelvis">]] === i) stack.push(c);
      }
    }
    const out: SeveredBody[] = [];
    for (const i of removed) {
      out.push({
        index: i,
        pos: this.nodes[i].position.clone(),
        q: this.nodes[i].rotationQuaternion!.clone(),
        lin: this.bodies[i].getLinearVelocity().clone(),
        ang: this.bodies[i].getAngularVelocity().clone(),
      });
    }
    for (const i of removed) {
      this.constraints[i]?.dispose();
      this.constraints[i] = null;
    }
    for (const i of removed) {
      this.onBodyRemoved?.(i, this.bodies[i]);
      this.bodies[i].dispose();
      this.shapes[i].dispose();
      this.attached[i] = false;
      this.tone[i] = 0;
    }
    return out;
  }
  onBodyRemoved: ((i: number, body: PhysicsBody) => void) | null = null;

  dispose() {
    for (let i = 0; i < RIG_COUNT; i++) {
      this.constraints[i]?.dispose();
      this.constraints[i] = null;
    }
    for (let i = 0; i < RIG_COUNT; i++) {
      if (this.attached[i]) {
        this.onBodyRemoved?.(i, this.bodies[i]);
        this.bodies[i].dispose();
        this.shapes[i].dispose();
      }
      this.nodes[i].dispose();
    }
  }
}

export { clamp };

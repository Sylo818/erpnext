import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import { PhysicsShape, PhysicsShapeBox, PhysicsShapeCapsule, PhysicsShapeContainer, PhysicsShapeCylinder, PhysicsShapeSphere } from "@babylonjs/core/Physics/v2/physicsShape.js";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import type { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import { PhysicsRaycastResult } from "@babylonjs/core/Physics/physicsRaycastResult.js";
import { ShapeCastResult } from "@babylonjs/core/Physics/shapeCastResult.js";
import type { PropShapePart } from "../data/props.js";
import type { V3 } from "../data/rigspec.js";

export interface EntityRef {
  kind: "rig" | "prop" | "wall" | "door" | "chunk" | "static" | "limb" | "capsule";
  /** Owner fighter slot for rig/capsule; prop id for prop; panel key for wall... */
  id: string;
  slot?: number;
  index?: number;
}

export class PhysHelper {
  readonly plugin: HavokPlugin;
  private owners = new Map<PhysicsBody, EntityRef>();
  private rayResult = new PhysicsRaycastResult();
  private castIn = new ShapeCastResult();
  private castHit = new ShapeCastResult();
  /** Shared query shapes by radius bucket and group (created lazily, reused every tick). */
  private sweepShapes = new Map<string, PhysicsShape>();

  constructor(readonly scene: Scene) {
    this.plugin = scene.getPhysicsEngine()!.getPhysicsPlugin() as HavokPlugin;
  }

  /** Only report new contacts (not every resting contact every step). */
  enableContactEvents(body: PhysicsBody) {
    const hk = (this.plugin as unknown as { _hknp: { EventType: { COLLISION_STARTED: { value: number } } } })._hknp;
    this.plugin.setEventMask(body, hk.EventType.COLLISION_STARTED.value);
  }

  register(body: PhysicsBody, ref: EntityRef) {
    this.owners.set(body, ref);
  }
  unregister(body: PhysicsBody) {
    this.owners.delete(body);
  }
  ownerOf(body: PhysicsBody | undefined | null): EntityRef | undefined {
    return body ? this.owners.get(body) : undefined;
  }

  makeNode(name: string, p: V3 | Vector3, q?: Quaternion): TransformNode {
    const n = new TransformNode(name, this.scene);
    n.position.set(p instanceof Vector3 ? p.x : p[0], p instanceof Vector3 ? p.y : p[1], p instanceof Vector3 ? p.z : p[2]);
    n.rotationQuaternion = q ? q.clone() : Quaternion.Identity();
    return n;
  }

  boxShape(c: V3, half: V3, membership: number, collide: number, rotY = 0): PhysicsShapeBox {
    const s = new PhysicsShapeBox(new Vector3(c[0], c[1], c[2]), rotY ? Quaternion.RotationAxis(Vector3.Up(), rotY) : Quaternion.Identity(), new Vector3(half[0] * 2, half[1] * 2, half[2] * 2), this.scene);
    s.filterMembershipMask = membership;
    s.filterCollideMask = collide;
    return s;
  }

  /** Build a (possibly compound) shape from prop parts. */
  partsShape(parts: readonly PropShapePart[], membership: number, collide: number, material = { friction: 0.6, restitution: 0.15 }): PhysicsShape {
    const mk = (p: PropShapePart): PhysicsShape => {
      let s: PhysicsShape;
      switch (p.kind) {
        case "box":
          s = new PhysicsShapeBox(new Vector3(...p.c), p.rot ? new Quaternion(p.rot[0], p.rot[1], p.rot[2], p.rot[3]) : p.rotY ? Quaternion.RotationAxis(Vector3.Up(), p.rotY) : Quaternion.Identity(), new Vector3(p.half[0] * 2, p.half[1] * 2, p.half[2] * 2), this.scene);
          break;
        case "capsule":
          s = new PhysicsShapeCapsule(new Vector3(...p.a), new Vector3(...p.b), p.r, this.scene);
          break;
        case "cylinder":
          s = new PhysicsShapeCylinder(new Vector3(...p.a), new Vector3(...p.b), p.r, this.scene);
          break;
        case "sphere":
          s = new PhysicsShapeSphere(new Vector3(...p.c), p.r, this.scene);
          break;
      }
      return s;
    };
    let shape: PhysicsShape;
    if (parts.length === 1) shape = mk(parts[0]);
    else {
      const cont = new PhysicsShapeContainer(this.scene);
      for (const p of parts) {
        const child = mk(p);
        cont.addChild(child);
      }
      shape = cont;
    }
    shape.filterMembershipMask = membership;
    shape.filterCollideMask = collide;
    shape.material = material;
    return shape;
  }

  /** Axis-aligned half extents (local) of prop parts, for inertia. */
  static partsExtents(parts: readonly PropShapePart[]): V3 {
    let hx = 0.02,
      hy = 0.02,
      hz = 0.02;
    for (const p of parts) {
      if (p.kind === "box") {
        hx = Math.max(hx, Math.abs(p.c[0]) + p.half[0]);
        hy = Math.max(hy, Math.abs(p.c[1]) + p.half[1]);
        hz = Math.max(hz, Math.abs(p.c[2]) + p.half[2]);
      } else if (p.kind === "sphere") {
        hx = Math.max(hx, Math.abs(p.c[0]) + p.r);
        hy = Math.max(hy, Math.abs(p.c[1]) + p.r);
        hz = Math.max(hz, Math.abs(p.c[2]) + p.r);
      } else {
        const a = p.a,
          b = p.b;
        hx = Math.max(hx, Math.abs(a[0]) + p.r, Math.abs(b[0]) + p.r);
        hy = Math.max(hy, Math.abs(a[1]) + p.r, Math.abs(b[1]) + p.r);
        hz = Math.max(hz, Math.abs(a[2]) + p.r, Math.abs(b[2]) + p.r);
      }
    }
    return [hx, hy, hz];
  }

  dynamicBody(node: TransformNode, shape: PhysicsShape, mass: number, ext: V3, linDamp = 0.08, angDamp = 0.3): PhysicsBody {
    const body = new PhysicsBody(node, PhysicsMotionType.DYNAMIC, false, this.scene);
    body.shape = shape;
    const m = mass;
    const ix = (m / 3) * (ext[1] * ext[1] + ext[2] * ext[2]);
    const iy = (m / 3) * (ext[0] * ext[0] + ext[2] * ext[2]);
    const iz = (m / 3) * (ext[0] * ext[0] + ext[1] * ext[1]);
    body.setMassProperties({ mass: m, centerOfMass: Vector3.Zero(), inertia: new Vector3(ix, iy, iz), inertiaOrientation: Quaternion.Identity() });
    body.setLinearDamping(linDamp);
    body.setAngularDamping(angDamp);
    body.disablePreStep = true;
    return body;
  }

  staticBody(node: TransformNode, shape: PhysicsShape): PhysicsBody {
    const body = new PhysicsBody(node, PhysicsMotionType.STATIC, false, this.scene);
    body.shape = shape;
    body.disablePreStep = true;
    return body;
  }

  teleport(body: PhysicsBody, p: Vector3, q: Quaternion) {
    const node = body.transformNode;
    node.position.copyFrom(p);
    node.rotationQuaternion!.copyFrom(q);
    const pre = body.getPrestepType();
    body.setPrestepType(1 /* TELEPORT */);
    this.plugin.setPhysicsBodyTransformation(body, node);
    body.setPrestepType(pre);
  }

  raycast(from: Vector3, to: Vector3, membership: number, collideWith: number, ignore?: PhysicsBody): PhysicsRaycastResult {
    this.plugin.raycast(from, to, this.rayResult, { membership, collideWith, ignoreBody: ignore });
    return this.rayResult;
  }

  /** Cached sphere sweep shape posing as `membership` and colliding with `collide`. */
  sweepShape(radius: number, membership: number, collide: number): PhysicsShape {
    const key = `${Math.round(radius * 1000)}:${membership}:${collide}`;
    let s = this.sweepShapes.get(key);
    if (!s) {
      s = new PhysicsShapeSphere(Vector3.Zero(), radius, this.scene);
      s.filterMembershipMask = membership;
      s.filterCollideMask = collide;
      this.sweepShapes.set(key, s);
    }
    return s;
  }

  private _q = Quaternion.Identity();
  /** Sweeps a sphere from a to b. Returns the nearest hit or null. */
  sweepSphere(a: Vector3, b: Vector3, radius: number, membership: number, collide: number, ignore?: PhysicsBody): { body: PhysicsBody; point: Vector3; normal: Vector3; fraction: number } | null {
    const shape = this.sweepShape(radius, membership, collide);
    this.plugin.shapeCast({ shape, rotation: this._q, startPosition: a, endPosition: b, shouldHitTriggers: false, ignoreBody: ignore }, this.castIn, this.castHit);
    if (!this.castHit.hasHit || !this.castHit.body) return null;
    return { body: this.castHit.body, point: this.castHit.hitPoint, normal: this.castHit.hitNormal, fraction: this.castHit.hitFraction };
  }
  /** Sweep with an arbitrary existing shape (e.g. a thrown prop's own shape). */
  sweepShapeCast(shape: PhysicsShape, rot: Quaternion, a: Vector3, b: Vector3, ignore?: PhysicsBody) {
    this.plugin.shapeCast({ shape, rotation: rot, startPosition: a, endPosition: b, shouldHitTriggers: false, ignoreBody: ignore }, this.castIn, this.castHit);
    if (!this.castHit.hasHit || !this.castHit.body) return null;
    return { body: this.castHit.body, point: this.castHit.hitPoint, normal: this.castHit.hitNormal, fraction: this.castHit.hitFraction };
  }

  disposeBody(body: PhysicsBody, shape?: PhysicsShape, node?: TransformNode) {
    this.owners.delete(body);
    body.dispose();
    shape?.dispose();
    node?.dispose();
  }
}

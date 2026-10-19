import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector.js";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import { PhysicsShapeCapsule } from "@babylonjs/core/Physics/v2/physicsShape.js";
import { Physics6DoFConstraint } from "@babylonjs/core/Physics/v2/physicsConstraint.js";
import { PhysicsConstraintAxis as A, PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import { makeEnv } from "./_env.js";

const env = await makeEnv();
const { scene } = env;
env.pe.setGravity(new Vector3(0, 0, 0));
function mk(name: string, y: number, motion: PhysicsMotionType) {
  const n = new TransformNode(name, scene);
  n.position.set(0, y, 0);
  n.rotationQuaternion = Quaternion.Identity();
  const b = new PhysicsBody(n, motion, false, scene);
  b.shape = new PhysicsShapeCapsule(new Vector3(0, 0.15, 0), new Vector3(0, -0.15, 0), 0.05, scene);
  b.setMassProperties({ mass: 1, centerOfMass: Vector3.Zero(), inertia: new Vector3(0.02, 0.02, 0.02) });
  return { n, b };
}
const lim = (axis: number, lo?: number, hi?: number) => ({ axis, minLimit: lo, maxLimit: hi });
function rig(limits: any[], label: string) {
  const p = mk("p" + label, 2, PhysicsMotionType.STATIC);
  const c = mk("c" + label, 1.7, PhysicsMotionType.DYNAMIC);
  const con = new Physics6DoFConstraint({ pivotA: new Vector3(0, 0, 0), pivotB: new Vector3(0, 0.3, 0), axisA: new Vector3(0, 1, 0), axisB: new Vector3(0, 1, 0), perpAxisA: new Vector3(1, 0, 0), perpAxisB: new Vector3(1, 0, 0), collision: false }, limits, scene);
  p.b.addConstraint(c.b, con);
  return { p, c };
}
const LOCK = [lim(A.LINEAR_X, 0, 0), lim(A.LINEAR_Y, 0, 0), lim(A.LINEAR_Z, 0, 0)];
// bone direction (child's -Y axis in world) tells us where a hanging limb points
function boneDir(c: TransformNode) { return new Vector3(0, -1, 0).applyRotationQuaternion(c.rotationQuaternion!); }
function f(v: Vector3) { return `(${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)})`; }

// 1) sign tests: limit axis [0, 1.0]; spin + and - ; see where bone points
const cases: [string, number, Vector3][] = [
  ["ANG_Y +spinX", A.ANGULAR_Y, new Vector3(2, 0, 0)],
  ["ANG_Y -spinX", A.ANGULAR_Y, new Vector3(-2, 0, 0)],
  ["ANG_Z +spinZ", A.ANGULAR_Z, new Vector3(0, 0, 2)],
  ["ANG_Z -spinZ", A.ANGULAR_Z, new Vector3(0, 0, -2)],
  ["ANG_X +spinY", A.ANGULAR_X, new Vector3(0, 2, 0)],
  ["ANG_X -spinY", A.ANGULAR_X, new Vector3(0, -2, 0)],
];
for (const [label, axis, spin] of cases) {
  const limits = [...LOCK, lim(A.ANGULAR_X, axis === A.ANGULAR_X ? 0 : -0.01, axis === A.ANGULAR_X ? 1.0 : 0.01), lim(A.ANGULAR_Y, axis === A.ANGULAR_Y ? 0 : -0.01, axis === A.ANGULAR_Y ? 1.0 : 0.01), lim(A.ANGULAR_Z, axis === A.ANGULAR_Z ? 0 : -0.01, axis === A.ANGULAR_Z ? 1.0 : 0.01)];
  const { p, c } = rig(limits, label);
  for (let i = 0; i < 90; i++) { c.b.setAngularVelocity(spin); env.step(); }
  const e = c.n.rotationQuaternion!.toEulerAngles();
  console.log(label.padEnd(14), "boneDir", f(boneDir(c.n)), "euler", f(e));
  p.b.dispose(); c.b.dispose();
}
// 2) full shoulder-like: twist ±1.2, pitch(Y axis) -2.8..1.6, roll(Z) -0.4..2.4. Swing child by drive about X then about Z and print
console.log("--- shoulder-like joint, all 3 limited");
const sh = [...LOCK, lim(A.ANGULAR_X, -1.2, 1.2), lim(A.ANGULAR_Y, -2.8, 1.6), lim(A.ANGULAR_Z, -0.4, 2.4)];
for (const [label, spin] of [["spin -X (forward raise)", new Vector3(-2, 0, 0)], ["spin +X (back)", new Vector3(2, 0, 0)], ["spin +Z", new Vector3(0, 0, 2)], ["spin -Z", new Vector3(0, 0, -2)]] as [string, Vector3][]) {
  const { p, c } = rig(sh, label);
  for (let i = 0; i < 120; i++) { c.b.setAngularVelocity(spin); env.step(); }
  console.log(label.padEnd(26), "boneDir", f(boneDir(c.n)));
  p.b.dispose(); c.b.dispose();
}
process.exit(0);

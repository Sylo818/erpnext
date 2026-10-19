import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector.js";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import { PhysicsShapeBox, PhysicsShapeCapsule } from "@babylonjs/core/Physics/v2/physicsShape.js";
import { Physics6DoFConstraint } from "@babylonjs/core/Physics/v2/physicsConstraint.js";
import { PhysicsConstraintAxis, PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import { makeEnv } from "./_env.js";

const env = await makeEnv();
const { scene } = env;
const A = PhysicsConstraintAxis;

function mk(name: string, y: number, motion: PhysicsMotionType) {
  const n = new TransformNode(name, scene);
  n.position.set(0, y, 0);
  n.rotationQuaternion = Quaternion.Identity();
  const b = new PhysicsBody(n, motion, false, scene);
  b.shape = new PhysicsShapeCapsule(new Vector3(0, 0.15, 0), new Vector3(0, -0.15, 0), 0.05, scene);
  b.setMassProperties({ mass: 1, centerOfMass: Vector3.Zero(), inertia: new Vector3(0.02, 0.02, 0.02) });
  return { n, b };
}
// Report relative euler of child vs parent (parent identity): use quaternion -> axis angle
function rel(c: TransformNode) {
  const q = c.rotationQuaternion!;
  const e = q.toEulerAngles();
  return `euler(x=${e.x.toFixed(2)}, y=${e.y.toFixed(2)}, z=${e.z.toFixed(2)})`;
}
async function trial(limitAxis: number, label: string, spin: Vector3) {
  const p = mk("p" + label, 2, PhysicsMotionType.STATIC);
  const c = mk("c" + label, 1.7, PhysicsMotionType.DYNAMIC);
  const lim = (axis: number, lo?: number, hi?: number) => ({ axis, minLimit: lo, maxLimit: hi });
  const limits = [
    lim(A.LINEAR_X, 0, 0), lim(A.LINEAR_Y, 0, 0), lim(A.LINEAR_Z, 0, 0),
    lim(A.ANGULAR_X, limitAxis === 3 ? -0.3 : undefined, limitAxis === 3 ? 0.3 : undefined),
    lim(A.ANGULAR_Y, limitAxis === 4 ? -0.3 : undefined, limitAxis === 4 ? 0.3 : undefined),
    lim(A.ANGULAR_Z, limitAxis === 5 ? -0.3 : undefined, limitAxis === 5 ? 0.3 : undefined),
  ];
  const con = new Physics6DoFConstraint({ pivotA: new Vector3(0, -0.0, 0), pivotB: new Vector3(0, 0.3, 0), axisA: new Vector3(0, 1, 0), axisB: new Vector3(0, 1, 0), perpAxisA: new Vector3(1, 0, 0), perpAxisB: new Vector3(1, 0, 0), collision: false }, limits, scene);
  p.b.addConstraint(c.b, con);
  console.log(`[${label}] modes X/Y/Z angular:`, [3, 4, 5].map((a) => con.getAxisMode(a)));
  for (let i = 0; i < 90; i++) {
    c.b.setAngularVelocity(spin);
    env.step();
  }
  console.log(`[${label}] limitAxis=${limitAxis} spin=${spin.toString()} -> ${rel(c.n)}`);
  p.b.dispose(); c.b.dispose();
}
env.scene.getPhysicsEngine()!.setGravity(new Vector3(0, 0, 0));
for (const [ax, name] of [[3, "ANG_X"], [4, "ANG_Y"], [5, "ANG_Z"]] as const) {
  for (const [spin, sname] of [[new Vector3(0, 2, 0), "spinY(bone twist)"], [new Vector3(2, 0, 0), "spinX"], [new Vector3(0, 0, 2), "spinZ"]] as const) {
    await trial(ax, `${name}|${sname}`, spin);
  }
}
process.exit(0);

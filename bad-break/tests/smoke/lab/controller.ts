import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector.js";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import { PhysicsShapeBox, PhysicsShapeCapsule } from "@babylonjs/core/Physics/v2/physicsShape.js";
import { PhysicsCharacterController, CharacterSupportedState } from "@babylonjs/core/Physics/v2/characterController.js";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import { makeEnv } from "./_env.js";

const env = await makeEnv();
const { scene } = env;
const dt = 1 / 60;
function staticBox(name: string, c: Vector3, half: Vector3, mem = 1, col = 0xffff) {
  const n = new TransformNode(name, scene); n.position.copyFrom(c); n.rotationQuaternion = Quaternion.Identity();
  const b = new PhysicsBody(n, PhysicsMotionType.STATIC, false, scene);
  const s = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), half.scale(2), scene);
  s.filterMembershipMask = mem; s.filterCollideMask = col; b.shape = s;
  return b;
}
staticBox("floor", new Vector3(0, -0.5, 0), new Vector3(20, 0.5, 20));
staticBox("wall", new Vector3(5, 1.5, 0), new Vector3(0.2, 1.5, 5));

function makeCC(x: number, z: number, mem: number, col: number) {
  const shape = new PhysicsShapeCapsule(new Vector3(0, 0.45, 0), new Vector3(0, -0.45, 0), 0.3, scene);
  shape.filterMembershipMask = mem; shape.filterCollideMask = col;
  const cc = new PhysicsCharacterController(new Vector3(x, 0.8, z), { shape }, scene);
  cc.footOffset = 0.75; // capsule total height = 0.9+0.6 = 1.5 -> half = .75
  cc.maxSlopeCosine = Math.cos(50 * Math.PI / 180);
  cc.maxCastIterations = 10;
  cc.keepDistance = 0.03; cc.keepContactTolerance = 0.06;
  return cc;
}
const down = new Vector3(0, -1, 0);
const up = new Vector3(0, 1, 0);
const g = new Vector3(0, -9.81, 0);
function tick(cc: PhysicsCharacterController, desired: Vector3) {
  const support = cc.checkSupport(dt, down);
  const v = cc.getVelocity().clone();
  if (support.supportedState === CharacterSupportedState.SUPPORTED) {
    v.copyFrom(desired); v.y = 0;
  } else {
    v.x = desired.x; v.z = desired.z; v.y += g.y * dt;
  }
  cc.setVelocity(v);
  cc.integrate(dt, support, g);
  return support;
}
// 1. fall + stand + walk to wall
{
  const cc = makeCC(0, 0, 1 << 5, 1 | (1 << 6));
  for (let i = 0; i < 60; i++) { tick(cc, Vector3.Zero()); env.step(); }
  console.log("standing y (expect ~0.75+skin):", cc.getPosition().y.toFixed(3));
  for (let i = 0; i < 240; i++) { tick(cc, new Vector3(3, 0, 0)); env.step(); }
  console.log("after walking +x 4s at 3 m/s into wall (x should stop ~4.5):", cc.getPosition().x.toFixed(3), "y", cc.getPosition().y.toFixed(3));
  cc.dispose();
}
// 2. two controllers with opposing groups
{
  const A = makeCC(-1, 8, 1 << 5, 1 | (1 << 6));
  const B = makeCC(1, 8, 1 << 6, 1 | (1 << 5));
  for (let i = 0; i < 40; i++) { tick(A, Vector3.Zero()); tick(B, Vector3.Zero()); env.step(); }
  for (let i = 0; i < 180; i++) { tick(A, new Vector3(2, 0, 0)); tick(B, Vector3.Zero()); env.step(); }
  console.log("A pushing into B: A.x", A.getPosition().x.toFixed(3), "B.x", B.getPosition().x.toFixed(3), "(A should stop ~0.4 before B: gap>=0.6)");
  A.dispose(); B.dispose();
}
// 3. two controllers where A ignores B's group
{
  const A = makeCC(-1, -8, 1 << 5, 1);
  const B = makeCC(1, -8, 1 << 6, 1 | (1 << 5));
  for (let i = 0; i < 40; i++) { tick(A, Vector3.Zero()); tick(B, Vector3.Zero()); env.step(); }
  for (let i = 0; i < 180; i++) { tick(A, new Vector3(2, 0, 0)); tick(B, Vector3.Zero()); env.step(); }
  console.log("A ignoring B (should pass through, A.x > B.x):", A.getPosition().x.toFixed(3), B.getPosition().x.toFixed(3));
  A.dispose(); B.dispose();
}
// 4. push a dynamic prop
{
  const n = new TransformNode("crate", scene); n.position.set(-10, 0.4, 5); n.rotationQuaternion = Quaternion.Identity();
  const b = new PhysicsBody(n, PhysicsMotionType.DYNAMIC, false, scene);
  const s = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(0.8, 0.8, 0.8), scene);
  s.filterMembershipMask = 2; s.filterCollideMask = 0xffff; b.shape = s;
  b.setMassProperties({ mass: 15 });
  const cc = makeCC(-12, 5, 1 << 5, 1 | 2);
  cc.characterMass = 80; cc.characterStrength = 100;
  for (let i = 0; i < 40; i++) { tick(cc, Vector3.Zero()); env.step(); }
  for (let i = 0; i < 120; i++) { tick(cc, new Vector3(2, 0, 0)); env.step(); }
  console.log("pushed crate x (started -10):", n.position.x.toFixed(3), "char x", cc.getPosition().x.toFixed(3));
  cc.dispose();
}
// 5. stepping cost with 2 controllers
{
  const A = makeCC(-1, 12, 1 << 5, 1 | (1 << 6));
  const B = makeCC(1, 12, 1 << 6, 1 | (1 << 5));
  for (let i = 0; i < 30; i++) { tick(A, Vector3.Zero()); tick(B, Vector3.Zero()); env.step(); }
  const t0 = performance.now();
  for (let i = 0; i < 600; i++) { tick(A, new Vector3(Math.sin(i / 20), 0, Math.cos(i / 17)).scale(2)); tick(B, new Vector3(Math.cos(i / 20), 0, Math.sin(i / 17)).scale(2)); env.step(); }
  console.log("ms per tick (2 controllers):", ((performance.now() - t0) / 600).toFixed(3));
}
process.exit(0);

import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector.js";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import { PhysicsShapeBox } from "@babylonjs/core/Physics/v2/physicsShape.js";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import { makeEnv } from "./_env.js";
import { buildRigSpec } from "../../../src/shared/data/rigspec.js";
import { Rig } from "../../../src/shared/sim/rig.js";
import { Pose, computeFK } from "../../../src/shared/sim/fk.js";
import { RIG_BODIES, RIG_COUNT } from "../../../src/shared/data/regions.js";
import { G } from "../../../src/shared/sim/groups.js";

const env = await makeEnv();
const { scene } = env;
env.plugin.setVelocityLimits(40, 40);
{
  const n = new TransformNode("floor", scene); n.position.set(0, -0.5, 0); n.rotationQuaternion = Quaternion.Identity();
  const b = new PhysicsBody(n, PhysicsMotionType.STATIC, false, scene);
  const s = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(40, 1, 40), scene);
  s.filterMembershipMask = G.STATIC; s.filterCollideMask = 0xffff; b.shape = s;
}
const spec = buildRigSpec(1, 1, 80);
const dt = 1 / 60;
function fmt(n: number) { return n.toFixed(3); }

function newRig(slot = 0, x = 0) {
  const rig = new Rig({ scene, spec, slot, name: "t" + slot });
  const pose = new Pose();
  pose.rootPos.set(x, spec.pelvisHeight, 0);
  rig.computeTargets(pose);
  rig.teleportToFk(rig.target);
  return { rig, pose };
}

// ---- 1. stand-hold with kinematic pelvis
{
  const { rig, pose } = newRig();
  rig.setRootKinematic(true);
  rig.tone.fill(1);
  let maxDev = 0, maxGap = 0, maxSpeed = 0;
  const t0 = performance.now();
  for (let t = 0; t < 300; t++) {
    rig.computeTargets(pose);
    rig.setRootTarget(pose.rootPos, pose.rootQ);
    rig.applyDrives(dt);
    env.step();
    for (let i = 0; i < RIG_COUNT; i++) {
      const d = Vector3.Distance(rig.nodes[i].position, rig.target.p[i]);
      if (t > 60) maxDev = Math.max(maxDev, d);
      maxSpeed = Math.max(maxSpeed, rig.bodies[i].getLinearVelocity().length());
    }
    maxGap = Math.max(maxGap, rig.maxJointGap());
  }
  console.log(`[stand-hold] maxDev=${fmt(maxDev)}m maxJointGap=${fmt(maxGap)}m maxSpeed=${fmt(maxSpeed)} ms/tick=${((performance.now() - t0) / 300).toFixed(3)}`);
  rig.dispose();
}
// ---- 2. pelvis kinematic -> dynamic collapse, limp
{
  const { rig, pose } = newRig();
  rig.setRootKinematic(true);
  for (let t = 0; t < 30; t++) { rig.computeTargets(pose); rig.setRootTarget(pose.rootPos, pose.rootQ); rig.applyDrives(dt); env.step(); }
  rig.setRootKinematic(false, new Vector3(1.5, 0, 0));
  rig.tone.fill(0);
  let maxGap = 0, maxSpeed = 0, maxAng = 0;
  for (let t = 0; t < 360; t++) {
    rig.computeTargets(pose); rig.applyDrives(dt); env.step();
    maxGap = Math.max(maxGap, rig.maxJointGap());
    for (let i = 0; i < RIG_COUNT; i++) { maxSpeed = Math.max(maxSpeed, rig.bodies[i].getLinearVelocity().length()); maxAng = Math.max(maxAng, rig.bodies[i].getAngularVelocity().length()); }
  }
  const ys = rig.nodes.map((n) => n.position.y);
  const pv = rig.pelvis.getLinearVelocity().length();
  console.log(`[collapse] maxJointGap=${fmt(maxGap)} maxLin=${fmt(maxSpeed)} maxAng=${fmt(maxAng)} finalPelvisY=${fmt(rig.nodes[0].position.y)} minY=${fmt(Math.min(...ys))} pelvisSpeed=${fmt(pv)} massAfterToggle=${rig.pelvis.getMassProperties().mass}`);
  rig.dispose();
}
// ---- 3. limit fuzz: random big impulses on a limp ragdoll; measure relative angles vs spec limits
{
  const { rig, pose } = newRig();
  rig.setRootKinematic(false);
  rig.tone.fill(0);
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const viol: Record<string, number> = {};
  let samples = 0, maxGap = 0, maxViol = 0;
  for (let t = 0; t < 600; t++) {
    if (t % 25 === 0) {
      const i = Math.floor(rnd() * RIG_COUNT);
      const imp = new Vector3((rnd() - 0.5) * 200, (rnd() - 0.2) * 150, (rnd() - 0.5) * 200);
      rig.bodies[i].applyImpulse(imp, rig.nodes[i].position);
    }
    env.step();
    maxGap = Math.max(maxGap, rig.maxJointGap());
    if (t > 20) {
      samples++;
      for (let i = 1; i < RIG_COUNT; i++) {
        const name = RIG_BODIES[i];
        const bs = spec.bodies[i];
        // relative rotation parent^-1 * child as YXZ euler -> compare with limits
        const pi = RIG_BODIES.indexOf(bs.parent!);
        const rel = Quaternion.Inverse(rig.nodes[pi].rotationQuaternion!).multiply(rig.nodes[i].rotationQuaternion!);
        const e = rel.toEulerAngles(); // x=pitch(rx), y=yaw(ry), z=roll(rz)
        const chk = (v: number, r: readonly [number, number] | undefined) => (r ? Math.max(0, r[0] - v, v - r[1]) : Math.abs(v));
        const v = Math.max(chk(e.x, bs.limits.x), chk(e.y, bs.limits.y), chk(e.z, bs.limits.z));
        if (v > 0.35) viol[name] = (viol[name] ?? 0) + 1;
        maxViol = Math.max(maxViol, v);
      }
    }
  }
  console.log(`[fuzz] samples=${samples} maxJointGap=${fmt(maxGap)} maxEulerViolation=${fmt(maxViol)}rad`, "violations>0.35rad:", JSON.stringify(viol));
  rig.dispose();
}
process.exit(0);

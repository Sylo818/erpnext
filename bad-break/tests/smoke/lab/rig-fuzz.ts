import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector.js";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import { PhysicsShapeBox } from "@babylonjs/core/Physics/v2/physicsShape.js";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import { makeEnv } from "./_env.js";
import { buildRigSpec } from "../../../src/shared/data/rigspec.js";
import { Rig } from "../../../src/shared/sim/rig.js";
import { Pose } from "../../../src/shared/sim/fk.js";
import { RIG_BODIES, RIG_COUNT } from "../../../src/shared/data/regions.js";
import { G } from "../../../src/shared/sim/groups.js";

const SUB = Number(process.env.SUB ?? 1), IMP = Number(process.env.IMP ?? 120);
const env = await makeEnv();
if (SUB > 1) env.plugin.setTimeStep(1 / (60 * SUB));
const { scene } = env;
env.plugin.setVelocityLimits(40, 40);
{
  const n = new TransformNode("floor", scene); n.position.set(0, -0.5, 0); n.rotationQuaternion = Quaternion.Identity();
  const b = new PhysicsBody(n, PhysicsMotionType.STATIC, false, scene);
  const s = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(40, 1, 40), scene);
  s.filterMembershipMask = G.STATIC; s.filterCollideMask = 0xffff; b.shape = s;
}
const spec = buildRigSpec(1, 1, 80);
const rig = new Rig({ scene, spec, slot: 0, name: "f" });
const pose = new Pose(); pose.rootPos.set(0, spec.pelvisHeight, 0);
rig.computeTargets(pose); rig.teleportToFk(rig.target);
rig.setRootKinematic(false); rig.tone.fill(0);

// swing-twist of rel about axis (unit)
function twistAbout(rel: Quaternion, ax: Vector3) {
  const d = rel.x * ax.x + rel.y * ax.y + rel.z * ax.z;
  const t = new Quaternion(ax.x * d, ax.y * d, ax.z * d, rel.w);
  const l = Math.hypot(t.x, t.y, t.z, t.w) || 1;
  t.scaleInPlace(1 / l);
  let ang = 2 * Math.atan2(d, rel.w); // signed about ax
  if (ang > Math.PI) ang -= 2 * Math.PI; if (ang < -Math.PI) ang += 2 * Math.PI;
  return ang;
}
const hinges = ["forearmL", "forearmR", "shinL", "shinR"] as const;
let seed = 11; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const stats: Record<string, { min: number; max: number; misalign: number }> = {};
for (const h of hinges) stats[h] = { min: 9, max: -9, misalign: 0 };
let maxGap = 0, maxLin = 0, maxAng = 0, nan = false;
const X = new Vector3(1, 0, 0);
for (let t = 0; t < 900; t++) {
  if (t % 20 === 0) {
    const i = Math.floor(rnd() * RIG_COUNT);
    const imp = new Vector3((rnd() - 0.5) * IMP, (rnd() - 0.2) * IMP * 0.8, (rnd() - 0.5) * IMP);
    rig.bodies[i].applyImpulse(imp, rig.nodes[i].position);
  }
  for (let k = 0; k < SUB; k++) env.pe._step(1 / (60 * SUB));
  maxGap = Math.max(maxGap, rig.maxJointGap());
  for (let i = 0; i < RIG_COUNT; i++) {
    const v = rig.bodies[i].getLinearVelocity(); const w = rig.bodies[i].getAngularVelocity();
    if (!Number.isFinite(v.x + v.y + v.z + w.x + w.y + w.z)) nan = true;
    maxLin = Math.max(maxLin, v.length()); maxAng = Math.max(maxAng, w.length());
  }
  if (t > 5) for (const h of hinges) {
    const i = RIG_BODIES.indexOf(h); const bs = spec.bodies[i]; const pi = RIG_BODIES.indexOf(bs.parent!);
    const rel = Quaternion.Inverse(rig.nodes[pi].rotationQuaternion!).multiply(rig.nodes[i].rotationQuaternion!);
    const flex = twistAbout(rel, X);
    // misalignment: angle between child's X axis (in parent frame) and X
    const cx = X.applyRotationQuaternion(rel);
    const mis = Math.acos(Math.min(1, Math.max(-1, cx.x)));
    const s = stats[h]; s.min = Math.min(s.min, flex); s.max = Math.max(s.max, flex); s.misalign = Math.max(s.misalign, mis);
  }
}
console.log(`SUB=${SUB} IMP=${IMP} fuzz: maxJointGap=${maxGap.toFixed(3)}m maxLin=${maxLin.toFixed(1)}m/s maxAng=${maxAng.toFixed(1)}rad/s nan=${nan}`);
for (const h of hinges) {
  const lim = spec.byName[h].limits.x!;
  console.log(h.padEnd(9), `flex range seen [${stats[h].min.toFixed(2)}, ${stats[h].max.toFixed(2)}] spec [${lim[0]}, ${lim[1]}] misalign=${stats[h].misalign.toFixed(2)}rad`);
}
process.exit(0);

import { createHeadlessWorld } from "../../../src/server/headless.js";
import { emptyIntent, BTN, type Intent } from "../../../src/shared/sim/input.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { RIG_INDEX } from "../../../src/shared/data/regions.js";

const h = await createHeadlessWorld({ fighters: ["gary", "ricky"], seed: 7 });
const w = h.world; let seq = 0;
const I = [emptyIntent(), emptyIntent()] as [Intent, Intent];
function tick(n = 1) { for (let i = 0; i < n; i++) { I[0].seq = I[1].seq = ++seq; w.step(I); } }
tick(240); w.drainEvents();
for (const gap of [0.8, 0.95, 1.1, 1.25]) {
  w.fighters[0].placeAt([-3 - gap / 2, 0, 0.9], Math.PI / 2);
  w.fighters[1].placeAt([-3 + gap / 2, 0, 0.9], -Math.PI / 2);
  I[0].aimYaw = Math.PI / 2; I[1].aimYaw = -Math.PI / 2;
  tick(40); w.drainEvents();
  const g = w.fighters[0], r = w.fighters[1];
  let minD = 9, minDChest = 9, maxFwd = -9;
  I[0].buttons = BTN.LIGHT; tick(2); I[0].buttons = 0;
  for (let t = 0; t < 40; t++) {
    tick(1);
    const fist = g.bodyPoint("handR", g.spec.strikePoint, new Vector3());
    const chest = r.rig.nodes[RIG_INDEX.chest].position;
    minDChest = Math.min(minDChest, Vector3.Distance(fist, chest));
    maxFwd = Math.max(maxFwd, fist.x - g.pos.x);
    minD = Math.min(minD, Math.abs(r.pos.x - g.pos.x));
  }
  const evs = w.drainEvents();
  console.log(`gap=${gap}: fist reach fwd=${maxFwd.toFixed(2)}m  minFist-chest=${minDChest.toFixed(2)}  minCapsuleGap=${minD.toFixed(2)}  hits=${evs.filter((e) => e.t === "hit").length}  whiffs=${evs.filter((e) => e.t === "whiff").length} swing=${evs.filter((e) => e.t === "swing").length}`);
}
h.dispose(); process.exit(0);

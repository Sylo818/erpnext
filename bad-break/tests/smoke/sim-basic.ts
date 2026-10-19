import { createHeadlessWorld } from "../../src/server/headless.js";
import { emptyIntent, BTN, type Intent } from "../../src/shared/sim/input.js";
import { RIG_COUNT } from "../../src/shared/data/regions.js";

const h = await createHeadlessWorld({ fighters: ["gary", "ricky"], seed: 7 });
const w = h.world;
const idle = [emptyIntent(), emptyIntent()] as [Intent, Intent];
let maxMs = 0, sumMs = 0, n = 0;
function run(ticks: number, intents: () => [Intent, Intent] = () => idle) {
  for (let i = 0; i < ticks; i++) {
    w.step(intents());
    maxMs = Math.max(maxMs, w.perf.total); sumMs += w.perf.total; n++;
  }
}
function report(label: string) {
  const f = w.fighters;
  const gaps = f.map((x) => x.rig.maxJointGap().toFixed(3)).join("/");
  const maxV = Math.max(...f.flatMap((x) => x.rig.bodies.filter((_, i) => x.rig.attached[i]).map((b) => b.getLinearVelocity().length())));
  console.log(`[${label}] t=${w.time.toFixed(2)} phase=${w.match.phase} f0=${f[0].state} f1=${f[1].state} pos0=(${f[0].pos.x.toFixed(2)},${f[0].pos.z.toFixed(2)}) pos1=(${f[1].pos.x.toFixed(2)},${f[1].pos.z.toFixed(2)}) jointGap=${gaps} maxLinVel=${maxV.toFixed(2)} props=${w.props.list.length} corrections=${w.corrections}`);
}
run(60); report("settle");
run(150); report("intro->fight");
// walk fighter 0 toward fighter 1 for 2s
let seq = 0;
const walk = (): [Intent, Intent] => {
  const a = emptyIntent(); a.seq = ++seq; a.moveX = 1; a.aimYaw = Math.PI / 2;
  return [a, emptyIntent()];
};
run(120, walk); report("walk 2s");
// punch repeatedly
let t = 0;
const punch = (): [Intent, Intent] => {
  const a = emptyIntent(); a.seq = ++seq; a.aimYaw = Math.PI / 2;
  a.buttons = (t++ % 30 === 0) ? BTN.LIGHT : 0;
  return [a, emptyIntent()];
};
run(180, punch); report("punching");
const evs = w.drainEvents();
const hits = evs.filter((e) => e.t === "hit");
console.log("events:", evs.length, "hits:", hits.length, "first hits:", JSON.stringify(hits.slice(0, 3).map((e: any) => ({ region: e.region, impulse: +e.impulse.toFixed(1), dmg: +e.damage.toFixed(2), kind: e.kind, guarded: e.guarded }))));
console.log("f1 vitality", w.fighters[1].inj.vitality.toFixed(1), "stamina f0", w.fighters[0].inj.stamina.toFixed(1));
console.log(`step cost avg=${(sumMs / n).toFixed(3)}ms max=${maxMs.toFixed(3)}ms (physics last=${w.perf.physics.toFixed(3)}ms) bodies=${w.pe.getBodies().length}`);
h.dispose();
process.exit(0);

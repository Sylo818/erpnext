import { createHeadlessWorld } from "../../src/server/headless.js";
import { emptyIntent, BTN, type Intent } from "../../src/shared/sim/input.js";

const h = await createHeadlessWorld({ fighters: ["gary", "ricky"], seed: 7 });
const w = h.world;
let seq = 0;
const I = [emptyIntent(), emptyIntent()] as [Intent, Intent];
function tick(n = 1) { for (let i = 0; i < n; i++) { I[0].seq = I[1].seq = ++seq; w.step(I); } }
function duel(gap = 1.2) {
  w.fighters[0].placeAt([-3 - gap / 2, 0, 0.9], Math.PI / 2);
  w.fighters[1].placeAt([-3 + gap / 2, 0, 0.9], -Math.PI / 2);
  for (const i of I) { i.buttons = 0; i.moveX = 0; i.moveZ = 0; }
  I[0].aimYaw = Math.PI / 2; I[1].aimYaw = -Math.PI / 2;
}
function press(slot: number, btn: number, hold = 2) { I[slot].buttons = btn; tick(hold); I[slot].buttons = 0; }
function hits() { return w.drainEvents().filter((e) => e.t === "hit") as any[]; }
function fmt(hs: any[]) { return hs.map((e) => `${e.kind}->${e.region}${e.guarded ? "(G)" : ""} J=${e.impulse.toFixed(0)} dmg=${e.damage.toFixed(1)}`).join(" | ") || "none"; }

tick(240); w.drainEvents();
duel(1.15);
tick(30); w.drainEvents();
console.log("== jab/cross/hook chain (Gary -> Ricky)");
for (let n = 0; n < 3; n++) { press(0, BTN.LIGHT); tick(22); }
tick(30);
console.log(fmt(hits()), "| ricky vit", w.fighters[1].inj.vitality.toFixed(1), "state", w.fighters[1].state, "bal", w.fighters[1].inj.balance.toFixed(0));

duel(1.3); tick(40); w.drainEvents();
console.log("== kick");
press(0, BTN.KICK); tick(45);
console.log(fmt(hits()), "| ricky state", w.fighters[1].state);

duel(1.3); tick(40); w.drainEvents();
console.log("== heavy (charged)");
I[0].buttons = BTN.HEAVY; tick(40); I[0].buttons = 0; tick(50);
console.log(fmt(hits()), "| ricky state", w.fighters[1].state, "vit", w.fighters[1].inj.vitality.toFixed(1));

duel(1.3); tick(80); w.drainEvents();
console.log("== guarded jab (Ricky guarding)");
I[1].buttons = BTN.GUARD; tick(25);
press(0, BTN.LIGHT); tick(30);
console.log(fmt(hits()), "| ricky stamina", w.fighters[1].inj.stamina.toFixed(1));

duel(3.0); tick(40); w.drainEvents();
console.log("== whiff (far away)");
press(0, BTN.HEAVY, 25); tick(60);
const ev = w.drainEvents();
console.log("whiff events", ev.filter((e) => e.t === "whiff").length, "hits", ev.filter((e) => e.t === "hit").length, "| gary state", w.fighters[0].state);

duel(1.15); tick(40); w.drainEvents();
console.log("== dodge i-frames (Ricky dodges as Gary jabs)");
I[0].buttons = BTN.LIGHT; I[1].buttons = BTN.DODGE; I[1].moveZ = 1; tick(2); I[0].buttons = 0; I[1].buttons = 0; I[1].moveZ = 0; tick(40);
console.log(fmt(hits()), "| ricky stamina", w.fighters[1].inj.stamina.toFixed(1));

duel(1.15); tick(40); w.drainEvents();
console.log("== sustained beating until something breaks (Gary vs passive Ricky)");
let lastState = "";
for (let n = 0; n < 40 && w.fighters[1].inj.consciousness !== "dead"; n++) {
  const f1 = w.fighters[1];
  if (f1.state === "ragdoll" || f1.state === "getup") { tick(30); duel(1.15); continue; }
  press(0, n % 5 === 4 ? BTN.HEAVY : BTN.LIGHT, n % 5 === 4 ? 6 : 2); tick(20);
  if (f1.state !== lastState) lastState = f1.state;
}
const all = w.drainEvents();
console.log("injury events:", all.filter((e) => e.t === "injury").map((e: any) => e.label).join(", "));
console.log("consciousness:", all.filter((e) => e.t === "consciousness").map((e: any) => `${e.fighter}:${e.state}`).join(", "));
console.log("final ricky:", w.fighters[1].inj.consciousness, "vit", w.fighters[1].inj.vitality.toFixed(1), "max joint gap", w.fighters[1].rig.maxJointGap().toFixed(3), "corrections", w.corrections);
h.dispose(); process.exit(0);

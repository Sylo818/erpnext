import { describe, expect, it } from "vitest";
import { InjuryState, computeEffects, type HitInput } from "../../src/shared/sim/injury.js";

const hit = (o: Partial<HitInput>): HitInput => ({ region: "chest", impulse: 30, heft: 0.15, cause: "fist", time: 0, ...o });

describe("injury model", () => {
  it("healthy fighter takes no bone damage from light punches", () => {
    const inj = new InjuryState();
    for (let i = 0; i < 6; i++) inj.applyHit(hit({ region: "forearmL", impulse: 18, time: i }), 3);
    expect(inj.bone.forearmL).toBe(100);
    expect(inj.level("forearmL")).toBeLessThanOrEqual(1);
  });
  it("a solid bat hit can fracture a forearm, reduces strike and grip", () => {
    const inj = new InjuryState();
    const out1 = inj.applyHit(hit({ region: "forearmL", impulse: 70, heft: 0.6, cause: "bat" }), 3);
    const out2 = inj.applyHit(hit({ region: "forearmL", impulse: 70, heft: 0.6, cause: "bat", time: 1 }), 3);
    expect(inj.level("forearmL")).toBeGreaterThanOrEqual(2);
    expect([...out1.notes, ...out2.notes].some((n) => n.kind === "injury" && n.label.includes("LEFT FOREARM FRACTURED"))).toBe(true);
    const fx = computeEffects(inj);
    expect(fx.strikeMultL).toBeLessThan(0.8);
    expect(fx.gripL).toBeLessThan(0.7);
    expect(fx.gripR).toBeGreaterThan(0.95);
  });
  it("repeated light attacks never detach a healthy limb", () => {
    const inj = new InjuryState();
    let detaches = 0;
    for (let i = 0; i < 200; i++) if (inj.applyHit(hit({ region: "upperArmR", impulse: 40, time: i * 0.2 }), 3).detach) detaches++;
    expect(detaches).toBe(0);
  });
  it("detach requires weakened bone AND a forceful heavy event, and commits only once", () => {
    const inj = new InjuryState();
    inj.bone.forearmR = 8;
    expect(inj.applyHit(hit({ region: "forearmR", impulse: 60, heft: 0.9 }), 3).detach).toBeNull(); // not forceful enough
    expect(inj.applyHit(hit({ region: "forearmR", impulse: 130, heft: 0.2 }), 3).detach).toBeNull(); // forceful but light weapon
    const out = inj.applyHit(hit({ region: "forearmR", impulse: 130, heft: 0.9 }), 3);
    expect(out.detach).toBe("armR");
    const notes: any[] = [];
    expect(inj.commitDetach("armR", notes)).toBe(true);
    expect(inj.commitDetach("armR", notes)).toBe(false);
    expect(computeEffects(inj).gripR).toBe(0);
    expect(computeEffects(inj).canTwoHand).toBe(false);
    expect(inj.level("handR")).toBe(4);
  });
  it("broken leg slows movement and disables dodge; severe leg crawls", () => {
    const inj = new InjuryState();
    inj.bone.shinL = 45; // fracture
    let fx = computeEffects(inj);
    expect(fx.speedMult).toBeLessThan(0.9);
    expect(["limp", "hop"]).toContain(fx.locomotion);
    inj.bone.shinL = 10; inj.bone.shinR = 10;
    fx = computeEffects(inj);
    expect(fx.locomotion).toBe("crawl");
    expect(fx.mustCrawl).toBe(true);
    expect(fx.canDodge).toBe(false);
  });
  it("nose breaks on a face hit over threshold; eyes damage then are lost", () => {
    const inj = new InjuryState();
    const o = inj.applyHit(hit({ region: "head", face: "nose", impulse: 40 }), 3);
    expect(inj.nose).toBe("broken");
    expect(o.notes.some((n) => n.kind === "injury" && n.label === "NOSE BROKEN")).toBe(true);
    inj.applyHit(hit({ region: "head", face: "eyeL", impulse: 30, time: 5 }), 3);
    expect(inj.eye.L).toBe(1);
    inj.applyHit(hit({ region: "head", face: "eyeL", impulse: 60, heft: 0.4, time: 9 }), 3);
    expect(inj.eye.L).toBe(2);
    expect(computeEffects(inj).aimAssist).toBeLessThan(0.8);
    expect(inj.eye.R).toBe(0);
  });
  it("blackout is recoverable, limited inside a combo, and has recovery protection", () => {
    const inj = new InjuryState();
    const o = inj.applyHit(hit({ region: "head", impulse: 90, time: 1 }), 3);
    expect(o.blackout).toBe(true);
    expect(inj.consciousness).toBe("blackout");
    // follow-up hits in the same combo cannot retrigger (already unconscious)
    const o2 = inj.applyHit(hit({ region: "head", impulse: 90, time: 1.3 }), 3);
    expect(o2.blackout).toBe(false);
    // recover after timer
    for (let t = 0; t < 4; t++) inj.tickConsciousness(1, 1 + t);
    expect(["awake", "dazed"]).toContain(inj.consciousness);
    // immune window: no new blackout
    const o3 = inj.applyHit(hit({ region: "head", impulse: 95, time: 4.5 }), 3);
    expect(o3.blackout).toBe(false);
    expect(inj.blackoutCount).toBe(1);
  });
  it("third blackout becomes a knockout; death is distinct from knockout", () => {
    const inj = new InjuryState();
    let t = 0;
    for (let i = 0; i < 3; i++) {
      t += 10;
      inj.applyHit(hit({ region: "head", impulse: 90, time: t }), 3);
      if (inj.consciousness === "blackout") for (let k = 0; k < 6; k++) inj.tickConsciousness(1, t + k);
    }
    expect(inj.consciousness).toBe("knockout");
    expect(inj.alive).toBe(true);
    const inj2 = new InjuryState();
    inj2.bone.head = 3;
    const o = inj2.applyHit(hit({ region: "head", impulse: 150 }), 3);
    expect(o.fatal).toBe(true);
    expect(inj2.consciousness).toBe("dead");
    expect(inj2.deathCause).toMatch(/head/);
  });
  it("reset restores everything", () => {
    const inj = new InjuryState();
    inj.bone.head = 3; inj.applyHit(hit({ region: "head", impulse: 150 }), 3);
    inj.reset();
    expect(inj.alive).toBe(true);
    expect(inj.bone.head).toBe(100);
    expect(inj.vitality).toBe(100);
  });
});

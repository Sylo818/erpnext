import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { basisToQuat, solveLegIK, Gait } from "../../src/shared/sim/gait.js";
import { buildRigSpec } from "../../src/shared/data/rigspec.js";

describe("leg IK", () => {
  const spec = buildRigSpec(1, 1, 80);
  const l1 = 0.43, l2 = 0.41;
  it("basisToQuat maps local axes to the given world axes", () => {
    const q = new Quaternion();
    basisToQuat(new Vector3(0, 0, 1), new Vector3(0, 1, 0), new Vector3(-1, 0, 0), q);
    const y = new Vector3(0, 1, 0).applyRotationQuaternion(q);
    const x = new Vector3(1, 0, 0).applyRotationQuaternion(q);
    expect(x.x).toBeCloseTo(0, 5); expect(x.z).toBeCloseTo(1, 5);
    expect(y.y).toBeCloseTo(1, 5);
  });
  it("reaches the ankle target and bends the knee forward", () => {
    const out = { thighQ: new Quaternion(), shinQ: new Quaternion(), knee: new Vector3(), reach: 0 };
    const hip = new Vector3(0.095, 0.96, 0);
    for (const ankle of [new Vector3(0.095, 0.12, 0), new Vector3(0.1, 0.2, 0.35), new Vector3(0.15, 0.2, -0.15), new Vector3(0.095, 0.35, 0.1)]) {
      solveLegIK(l1, l2, hip, ankle, new Vector3(0, 0, 1), out);
      const k = hip.add(new Vector3(0, -l1, 0).applyRotationQuaternion(out.thighQ));
      const a = k.add(new Vector3(0, -l2, 0).applyRotationQuaternion(out.shinQ));
      expect(Vector3.Distance(a, ankle)).toBeLessThan(0.01);
      expect(Vector3.Distance(k, out.knee)).toBeLessThan(0.01);
      // knee forward of the hip-ankle line
      const mid = hip.add(ankle).scale(0.5);
      expect(out.knee.z - mid.z).toBeGreaterThan(-0.001);
    }
  });
  it("knee flexion relative rotation is a pure +X rotation (hinge-consistent)", () => {
    const out = { thighQ: new Quaternion(), shinQ: new Quaternion(), knee: new Vector3(), reach: 0 };
    solveLegIK(l1, l2, new Vector3(0.095, 0.96, 0), new Vector3(0.1, 0.3, 0.3), new Vector3(0, 0, 1), out);
    const rel = Quaternion.Inverse(out.thighQ).multiply(out.shinQ);
    expect(Math.abs(rel.y)).toBeLessThan(0.02);
    expect(Math.abs(rel.z)).toBeLessThan(0.02);
    expect(rel.x).toBeGreaterThan(0); // positive X rotation = flexion (heel back)
  });
  it("gait keeps planted feet fixed while the root moves slowly, then steps", () => {
    const g = new Gait(spec);
    g.reset(0, 0, 0, 0);
    const p0 = g.feet[1].pos.clone();
    for (let i = 0; i < 6; i++) g.update({ vx: 0.5, vz: 0, yaw: 0, rootX: 0.01 * i, rootZ: 0, groundY: 0, stance: 1, stagger: 0, enabled: [true, true], stepScale: 1, dt: 1 / 60, freeze: false });
    expect(Vector3.Distance(g.feet[1].pos, p0)).toBeLessThan(0.001);
    let steps = 0, last = [true, true];
    let x = 0;
    for (let i = 0; i < 240; i++) {
      x += 2.5 / 60;
      g.update({ vx: 0, vz: 2.5, yaw: 0, rootX: 0, rootZ: x, groundY: 0, stance: 1, stagger: 0, enabled: [true, true], stepScale: 1, dt: 1 / 60, freeze: false });
      for (let k = 0; k < 2; k++) { if (last[k] && !g.feet[k].planted) steps++; last[k] = g.feet[k].planted; }
      // feet never too far from root
      for (const f of g.feet) expect(Math.hypot(f.pos.x, f.pos.z - x)).toBeLessThan(0.9);
    }
    expect(steps).toBeGreaterThan(6);
  });
});

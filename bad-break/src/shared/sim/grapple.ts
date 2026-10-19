/**
 * Opponent grappling: grab, drag, grapple strikes, push into furniture, directional throws.
 * The held fighter keeps its own movement capsule (so walls and furniture still stop it) but is steered
 * toward an anchor in front of the holder with a bounded speed. Grip strain rises over time and with
 * injury; a timing window lets the held fighter escape without button mashing.
 */
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { INJURY } from "../data/injuries.js";
import { clamp, wrapAngle } from "../math.js";
import { BTN } from "./input.js";
import type { Fighter } from "./fighter.js";
import type { SimWorld } from "./world.js";

const _v = new Vector3();

export class GrappleSystem {
  constructor(private world: SimWorld) {}

  tryStart(f: Fighter): boolean {
    const o = f.opponent;
    if (!o || o.dead || o.unconscious) return false;
    if (f.heldMain || f.heldOff) return false;
    if (o.state === "ragdoll" || o.state === "getup" || o.state === "grabbed" || o.iframes > 0 || o.grappleImmune > 0 || f.grappleImmune > 0) return false;
    if (f.state === "grapple" || o.state === "grapple") return false;
    const d = Math.hypot(o.pos.x - f.pos.x, o.pos.z - f.pos.z);
    if (d > 1.5) return false;
    const grip = Math.max(f.fx.gripL, f.fx.gripR);
    if (grip < 0.3) return false;
    // contested: a fighter that is also grabbing this tick - lower slot loses if equally close (deterministic)
    f.grappleRole = "holder";
    f.grappleOther = o;
    f.grappleT = 0;
    f.grappleStrain = 0;
    o.grappleRole = "held";
    o.grappleOther = f;
    o.grappleT = 0;
    o.grappleEscapeOpen = 0;
    o.grappleEscapeCd = 0.55;
    o.move = null;
    o.moveWeapon = null;
    f.setState("grapple");
    o.setState("grabbed");
    this.world.emit({ t: "grab", fighter: f.slot, hand: "both", targetKind: "fighter", targetId: String(o.slot) });
    return true;
  }

  /** End the relationship from either side. */
  end(f: Fighter, reason: string) {
    const o = f.grappleOther;
    if (!o) return;
    const holder = f.grappleRole === "holder" ? f : o;
    const held = holder === f ? o : f;
    holder.grappleRole = "none";
    holder.grappleOther = null;
    held.grappleRole = "none";
    held.grappleOther = null;
    holder.grappleImmune = 0.5;
    held.grappleImmune = 1.0;
    holder.grappleStrikeQueued = false;
    held.ext.setAll(0);
    this.world.emit({ t: "release", fighter: holder.slot, targetId: String(held.slot), reason });
    if (holder.state === "grapple") {
      holder.move = null;
      holder.setState("neutral");
    }
    if (held.state === "grabbed") held.setState("neutral");
  }

  /** Called every tick before fighters' preStep. */
  step(dt: number) {
    for (const holder of this.world.fighters) {
      if (holder.grappleRole !== "holder") continue;
      const held = holder.grappleOther;
      if (!held || held.grappleRole !== "held") {
        this.end(holder, "broken");
        continue;
      }
      holder.grappleT += dt;
      held.grappleT += dt;
      const grip = Math.max(holder.fx.gripL, holder.fx.gripR);
      const both = holder.fx.canTwoHand ? 1 : 0.7;
      // strain: time + resistance of the held fighter's weight vs the holder's grip
      const base = holder.grappleT / INJURY.grappleMaxSeconds;
      const heft = (held.def.mass / holder.def.mass) * (1.15 - grip * 0.5);
      holder.grappleStrain = clamp(base * 0.8 + heft * 0.2 * (1 / both) + (1 - holder.inj.stamina / 100) * 0.15, 0, 1.2);
      holder.inj.stamina = Math.max(0, holder.inj.stamina - (1.4 + heft * 1.5) * dt);

      if (holder.dead || holder.unconscious || held.dead || held.unconscious) {
        this.end(holder, holder.unconscious || holder.dead ? "holder down" : "target down");
        continue;
      }
      if (grip < 0.2 || holder.grappleStrain >= 1 || holder.grappleT > INJURY.grappleMaxSeconds || holder.state === "ragdoll") {
        this.end(holder, grip < 0.2 ? "grip failed" : "strain");
        continue;
      }

      // anchor in front of the holder (drag): bounded follow speed
      const fx = Math.sin(holder.facing),
        fz = Math.cos(holder.facing);
      const ax = holder.pos.x + fx * 0.86,
        az = holder.pos.z + fz * 0.86;
      const dx = ax - held.pos.x,
        dz = az - held.pos.z;
      const dist = Math.hypot(dx, dz);
      const speed = Math.min(6.5, dist / dt);
      if (dist > 0.01) held.ext.set((dx / dist) * speed * 0.9, 0, (dz / dist) * speed * 0.9);
      else held.ext.setAll(0);
      // held faces the holder
      held.facing = Math.atan2(holder.pos.x - held.pos.x, holder.pos.z - held.pos.z);
      if (dist > 2.0) {
        this.end(holder, "pulled away");
        continue;
      }

      // timing-based escape: a window opens periodically, signalled on the HUD / body
      if (held.grappleEscapeOpen > 0) {
        held.grappleEscapeOpen -= dt;
      } else if (held.grappleEscapeCd <= 0) {
        held.grappleEscapeOpen = INJURY.grappleEscapeWindowSeconds;
        held.grappleEscapeCd = 1.15;
      }
      const tryEscape = held.pressed(BTN.DODGE) || held.pressed(BTN.INTERACT) || held.pressed(BTN.GUARD);
      if (tryEscape) {
        if (held.grappleEscapeOpen > 0) {
          holder.inj.stamina = Math.max(0, holder.inj.stamina - 8);
          this.end(holder, "escaped");
          holder.enterStagger(0.28);
          held.recoveryProtect = Math.max(held.recoveryProtect, 0.5);
          continue;
        } else {
          // mistimed: tiny penalty and the next window is delayed (discourages mashing)
          held.inj.spendStamina(5);
          held.grappleEscapeCd = Math.max(held.grappleEscapeCd, 0.5);
        }
      }
    }
  }

  throwHeld(holder: Fighter) {
    const held = holder.grappleOther;
    if (!held) return;
    const yaw = holder.intent.aimYaw ?? holder.facing;
    const grip = Math.max(holder.fx.gripL, holder.fx.gripR);
    const ratio = Math.sqrt(clamp(holder.def.mass / held.def.mass, 0.6, 1.4));
    const strength = clamp(0.55 + 0.45 * grip, 0.4, 1) * (holder.fx.canTwoHand ? 1 : 0.8);
    const speed = 9.6 * ratio * strength * (holder.inj.stamina <= 5 ? 0.8 : 1);
    this.end(holder, "thrown");
    const v = _v.set(Math.sin(yaw) * speed, 2.6 + speed * 0.08, Math.cos(yaw) * speed);
    // lift the target out of the floor/capsule so it leaves cleanly
    held.enterRagdoll("thrown", v, holder.slot);
    holder.stats.throws++;
    holder.inj.spendStamina(14);
    holder.grappleImmune = 0.6;
    this.world.emit({ t: "throw", fighter: holder.slot, targetKind: "fighter", targetId: String(held.slot), speed });
    void wrapAngle;
  }
}

/**
 * Destructible architecture. Wall patches are grids of static panels (BREAKABLE group). A strong impact
 * (a thrown body, a shoulder check, a heavy projectile) removes the panels around the impact point at a
 * safe simulation boundary, hands a limited number of physical chunks to the physics engine and leaves a
 * traversable opening. Support walls are plain static boxes and never break.
 */
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import type { PhysicsShape } from "@babylonjs/core/Physics/v2/physicsShape.js";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { ARENAS, wallPanelCenter, wallPanelHalf, type ArenaDef, type DoorDef, type WallPatchDef } from "../data/arenas.js";
import { RIG_INDEX } from "../data/regions.js";
import type { V3 } from "../data/rigspec.js";
import { clamp } from "../math.js";
import { DEBRIS_COLLIDE_MASK, G, STATIC_COLLIDE_MASK } from "./groups.js";
import type { SimWorld } from "./world.js";

export interface Panel {
  idx: number;
  col: number;
  row: number;
  c: Vector3;
  half: V3;
  body: PhysicsBody | null;
  shape: PhysicsShape | null;
  node: TransformNode | null;
  broken: boolean;
  /** Effective impulse needed to break this panel. */
  thr: number;
  hits: number;
}
export interface WallRuntime {
  def: WallPatchDef;
  panels: Panel[];
  rev: number;
}
export interface DoorRuntime {
  def: DoorDef;
  body: PhysicsBody | null;
  shape: PhysicsShape | null;
  node: TransformNode | null;
  broken: boolean;
  rev: number;
}
export interface Chunk {
  id: string;
  wallId: string;
  panel: number;
  piece: number;
  node: TransformNode;
  body: PhysicsBody;
  shape: PhysicsShape;
  half: V3;
  born: number;
  /** Enables collision with ragdolls after this time (so a flying body passes through the new hole). */
  phaseUntil: number;
  isDoor?: boolean;
  prevPos: Vector3;
  curPos: Vector3;
  prevQ: Quaternion;
  curQ: Quaternion;
  retired: boolean;
}
export interface Portal {
  id: string;
  from: string;
  to: string;
  pos: Vector3;
  open: boolean;
  normalAxis: "x" | "z";
}

const _v1 = new Vector3();
const _v2 = new Vector3();
const MAX_CHUNKS = 24;

export class DestructionSystem {
  walls: WallRuntime[] = [];
  doors: DoorRuntime[] = [];
  chunks: Chunk[] = [];
  statics: { node: TransformNode; body: PhysicsBody; shape: PhysicsShape }[] = [];
  private seq = 0;

  constructor(private world: SimWorld) {}

  build(arena: ArenaDef) {
    const w = this.world;
    for (const s of arena.solids) {
      const node = w.phys.makeNode(`solid.${s.id}`, s.c);
      const shape = w.phys.boxShape([0, 0, 0], s.half, G.STATIC, STATIC_COLLIDE_MASK);
      shape.material = { friction: s.kind === "floor" ? 0.85 : 0.5, restitution: 0.05 };
      const body = w.phys.staticBody(node, shape);
      w.phys.register(body, { kind: "static", id: s.id });
      this.statics.push({ node, body, shape });
    }
    for (const wd of arena.walls) {
      const wall: WallRuntime = { def: wd, panels: [], rev: 0 };
      let idx = 0;
      for (let r = 0; r < wd.rows; r++) {
        for (let c = 0; c < wd.cols; c++) {
          const ctr = wallPanelCenter(wd, c, r);
          const half = wallPanelHalf(wd);
          const node = w.phys.makeNode(`wall.${wd.id}.${idx}`, ctr);
          const shape = w.phys.boxShape([0, 0, 0], half, G.BREAKABLE, STATIC_COLLIDE_MASK);
          shape.material = { friction: 0.5, restitution: 0.02 };
          const body = w.phys.staticBody(node, shape);
          w.phys.register(body, { kind: "wall", id: `${wd.id}:${idx}`, index: idx });
          wall.panels.push({
            idx,
            col: c,
            row: r,
            c: new Vector3(ctr[0], ctr[1], ctr[2]),
            half,
            body,
            shape,
            node,
            broken: false,
            thr: wd.threshold * (wd.colMult?.[c] ?? 1) * (wd.rowMult?.[r] ?? 1),
            hits: 0,
          });
          idx++;
        }
      }
      this.walls.push(wall);
    }
    for (const d of arena.doors) {
      const node = w.phys.makeNode(`door.${d.id}`, d.c);
      const shape = w.phys.boxShape([0, 0, 0], d.half, G.BREAKABLE, STATIC_COLLIDE_MASK);
      const body = w.phys.staticBody(node, shape);
      w.phys.register(body, { kind: "door", id: d.id });
      this.doors.push({ def: d, body, shape, node, broken: false, rev: 0 });
    }
  }

  dispose() {
    const w = this.world;
    for (const s of this.statics) w.phys.disposeBody(s.body, s.shape, s.node);
    this.statics.length = 0;
    for (const wall of this.walls) for (const p of wall.panels) if (p.body) w.phys.disposeBody(p.body, p.shape!, p.node!);
    this.walls.length = 0;
    for (const d of this.doors) if (d.body) w.phys.disposeBody(d.body, d.shape!, d.node!);
    this.doors.length = 0;
    for (const c of this.chunks) this.disposeChunk(c);
    this.chunks.length = 0;
  }

  /** Restore every panel/door (round reset). Rebuilds topology. */
  reset(arena: ArenaDef) {
    this.dispose();
    this.build(arena);
  }

  private disposeChunk(c: Chunk) {
    if (c.retired) return;
    c.retired = true;
    this.world.phys.disposeBody(c.body, c.shape, c.node);
  }

  get activeChunks(): number {
    return this.chunks.length;
  }

  // ------------------------------------------------------------------ detection
  /** Predictive: fast bodies heading for a breakable panel break it BEFORE contact so momentum survives. */
  step(dt: number) {
    const w = this.world;
    const arena = w.arena;
    const wallCount = this.walls.length + this.doors.length;
    if (wallCount > 0) {
      // fighters thrown / tumbling
      for (const f of w.fighters) {
        if (f.state === "ragdoll" && !f.dead) {
          const v = f.preVel;
          const sp = v.length();
          if (sp > 4.5) {
            for (const bi of [RIG_INDEX.pelvis, RIG_INDEX.chest, RIG_INDEX.head]) {
              if (!f.rig.attached[bi]) continue;
              this.probe(f.rig.nodes[bi].position, f.rig.bodies[bi].getLinearVelocity(), f.mass * 0.62, f.slot, dt, f);
            }
          }
        } else if (f.state === "attack" && f.move?.kind === "shoulder" && f.strikeActive()) {
          // a running shoulder check into the weak wall
          const dir = _v1.set(Math.sin(f.facing), 0, Math.cos(f.facing));
          const v = _v2.set(dir.x * 5.2, 0, dir.z * 5.2);
          this.probe(f.rig.nodes[RIG_INDEX.chest].position, v, f.mass * 0.95, f.slot, dt, null);
        }
      }
      // heavy projectiles
      for (const p of w.props.list) {
        if (p.removed || p.holder) continue;
        if (p.lastSpeed > 7 && p.def.mass >= 3.5) this.probe(p.node.position, p.lastVel, p.def.mass * 1.2, p.thrownBy, dt, null);
      }
      void arena;
    }
    // retire old chunks
    const now = w.time;
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i];
      const age = now - c.born;
      c.prevPos.copyFrom(c.curPos);
      c.prevQ.copyFrom(c.curQ);
      c.curPos.copyFrom(c.node.position);
      c.curQ.copyFrom(c.node.rotationQuaternion!);
      if (c.phaseUntil > 0 && now >= c.phaseUntil) {
        c.shape.filterCollideMask = DEBRIS_COLLIDE_MASK;
        c.phaseUntil = 0;
      }
      const sp = c.body.getLinearVelocity().length();
      if ((age > 9 && sp < 0.15) || age > 18 || c.node.position.y < -20) {
        this.disposeChunk(c);
        this.chunks.splice(i, 1);
      }
    }
  }

  private probe(pos: Vector3, vel: Vector3, mass: number, by: number, dt: number, holder: unknown) {
    const w = this.world;
    const sp = vel.length();
    if (sp < 4) return;
    const reach = Math.min(2.6, sp * dt * 3 + 0.5);
    _v1.copyFrom(vel).scaleInPlace(reach / sp).addInPlace(pos);
    const rr = w.phys.raycast(pos, _v1, G.SWEEP_ONLY, G.BREAKABLE);
    if (!rr.hasHit) return;
    // which breakable?
    // The raycast result does not expose the body, so locate by geometry
    const hp = rr.hitPointWorld;
    const n = rr.hitNormalWorld;
    const nvel = Math.abs(vel.x * n.x + vel.y * n.y + vel.z * n.z);
    const J = mass * nvel;
    this.impactAt(hp, J, vel, by);
    void holder;
  }

  /** Resolve which breakable lies at a world point and apply an impact of impulse J. */
  impactAt(pt: Vector3, J: number, vel: Vector3, by: number) {
    // doors first (cheapest)
    for (const d of this.doors) {
      if (d.broken || !d.body) continue;
      const c = d.node!.position;
      const h = d.def.half;
      if (Math.abs(pt.x - c.x) <= h[0] + 0.25 && Math.abs(pt.y - c.y) <= h[1] + 0.2 && Math.abs(pt.z - c.z) <= h[2] + 0.25) {
        if (J >= d.def.threshold) this.world.defer(() => this.breakDoor(d, vel, by));
        return;
      }
    }
    for (const wall of this.walls) {
      let best: Panel | null = null;
      let bd = 1e9;
      for (const p of wall.panels) {
        if (p.broken) continue;
        const d = Math.abs(p.c.x - pt.x) + Math.abs(p.c.y - pt.y) + Math.abs(p.c.z - pt.z);
        const inside = Math.abs(pt.x - p.c.x) <= p.half[0] + 0.3 && Math.abs(pt.y - p.c.y) <= p.half[1] + 0.3 && Math.abs(pt.z - p.c.z) <= p.half[2] + 0.3;
        if (inside && d < bd) {
          bd = d;
          best = p;
        }
      }
      if (!best) continue;
      best.hits++;
      if (J < best.thr) return;
      this.world.defer(() => this.breakWall(wall, best!, pt, J, vel, by));
      return;
    }
  }

  // ------------------------------------------------------------------ breaking
  breakWall(wall: WallRuntime, hitPanel: Panel, pt: Vector3, J: number, vel: Vector3, by: number) {
    if (hitPanel.broken) return;
    const w = this.world;
    const d = wall.def;
    const ratio = J / hitPanel.thr;
    // choose panels near the impact in the wall plane
    const ux = d.normalAxis === "x" ? 2 : 0; // horizontal axis index (z for x-normal walls)
    const radius = 0.5 + 0.55 * clamp(ratio - 0.6, 0, 1.8);
    const chosen = new Set<number>([hitPanel.idx]);
    for (const p of wall.panels) {
      if (p.broken) continue;
      const du = ux === 2 ? p.c.z - pt.z : p.c.x - pt.x;
      const dv = p.c.y - pt.y;
      if (Math.hypot(du * 0.9, dv) <= radius) chosen.add(p.idx);
    }
    // always carve a body-sized opening: the full column(s) of the lowest two rows
    const cols = new Set<number>([hitPanel.col]);
    if (ratio >= 1.25) {
      // neighbour column on the side of the impact
      const du = ux === 2 ? pt.z - hitPanel.c.z : pt.x - hitPanel.c.x;
      const nc = du >= 0 ? hitPanel.col + 1 : hitPanel.col - 1;
      if (nc >= 0 && nc < d.cols && ratio >= 1.6) cols.add(nc);
    }
    for (const c of cols) {
      for (let r = 0; r < Math.min(2, d.rows); r++) {
        const p = wall.panels[r * d.cols + c];
        if (p && !p.broken) chosen.add(p.idx);
      }
    }
    const list = [...chosen].map((i) => wall.panels[i]).filter((p) => !p.broken);
    if (list.length === 0) return;
    const horiz = _v1.set(vel.x, 0, vel.z);
    const hlen = horiz.length();
    const dirIn = hlen > 0.1 ? horiz.clone().scaleInPlace(1 / hlen) : new Vector3(d.normalAxis === "x" ? 1 : 0, 0, d.normalAxis === "z" ? 1 : 0);
    for (const p of list) {
      p.broken = true;
      const body = p.body!;
      w.phys.disposeBody(body, p.shape!, p.node!);
      p.body = null;
      p.shape = null;
      p.node = null;
      this.spawnChunks(wall, p, pt, dirIn, hlen);
    }
    wall.rev++;
    w.emit({ t: "wallBreak", wallId: d.id, patches: list.map((p) => p.idx), pos: [pt.x, pt.y, pt.z], by });
    w.emit({ t: "impact", material: "plaster", pos: [pt.x, pt.y, pt.z], strength: clamp(ratio / 2, 0.4, 1), a: "wall", b: "wall" });
    if (by >= 0 && w.fighters[by]) w.fighters[by].stats.wallsBroken++;
    // passing through costs a little energy but the body keeps going
    for (const f of w.fighters) {
      if (f.state !== "ragdoll") continue;
      if (Vector3.Distance(f.rootPos, pt) < 2.5) {
        for (let i = 0; i < f.rig.bodies.length; i++) {
          if (!f.rig.attached[i]) continue;
          const v = f.rig.bodies[i].getLinearVelocity();
          f.rig.bodies[i].setLinearVelocity(v.scale(0.88));
        }
      }
    }
  }

  private spawnChunks(wall: WallRuntime, p: Panel, hit: Vector3, dirIn: Vector3, speed: number) {
    const w = this.world;
    const d = wall.def;
    const n = d.chunksPerPanel;
    for (let i = 0; i < n; i++) {
      // slab along the horizontal axis of the panel
      const frac = (i + 0.5) / n - 0.5;
      const along = d.normalAxis === "x" ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0);
      const cen = p.c.add(along.scale(frac * d.cellU));
      const half: V3 = d.normalAxis === "x" ? [d.thickness * 0.45, d.cellV * 0.48, (d.cellU / n) * 0.48] : [(d.cellU / n) * 0.48, d.cellV * 0.48, d.thickness * 0.45];
      const outward = cen.subtract(hit);
      outward.y = Math.max(outward.y, -0.2) + 0.3;
      const out = outward.length() > 0.01 ? outward.normalize() : new Vector3(0, 1, 0);
      const vel = dirIn.scale(Math.min(speed, 9) * 0.45).add(out.scale(1.8 + w.rng.next() * 1.6)).add(new Vector3(0, w.rng.next() * 1.4, 0));
      const spin = new Vector3(w.rng.range(-5, 5), w.rng.range(-5, 5), w.rng.range(-5, 5));
      if (this.chunks.length >= MAX_CHUNKS) continue; // over budget: this piece is cosmetic only (renderer handles the dust & fragments)
      this.makeChunk(wall.def.id, p.idx, i, cen, half, 4.2, vel, spin);
    }
  }

  private makeChunk(wallId: string, panel: number, piece: number, pos: Vector3, half: V3, mass: number, vel: Vector3, spin: Vector3, isDoor = false): Chunk {
    const w = this.world;
    const id = `${wallId}.${panel}.${piece}`;
    const node = w.phys.makeNode(`chunk.${id}`, pos);
    const shape = w.phys.boxShape([0, 0, 0], half, G.DEBRIS, DEBRIS_COLLIDE_MASK & ~(G.RAG_A | G.RAG_B | G.LIMB), 0);
    shape.material = { friction: 0.7, restitution: 0.1 };
    const body = w.phys.dynamicBody(node, shape, mass, half, 0.15, 0.6);
    body.setLinearVelocity(vel);
    body.setAngularVelocity(spin);
    w.phys.enableContactEvents(body);
    w.phys.register(body, { kind: "chunk", id });
    const c: Chunk = { id, wallId, panel, piece, node, body, shape, half, born: w.time, phaseUntil: w.time + 0.55, isDoor, prevPos: pos.clone(), curPos: pos.clone(), prevQ: Quaternion.Identity(), curQ: Quaternion.Identity(), retired: false };
    this.chunks.push(c);
    return c;
  }

  breakDoor(d: DoorRuntime, vel: Vector3, by: number) {
    if (d.broken) return;
    const w = this.world;
    d.broken = true;
    d.rev++;
    const pos = d.node!.position.clone();
    w.phys.disposeBody(d.body!, d.shape!, d.node!);
    d.body = null;
    d.shape = null;
    d.node = null;
    const hv = new Vector3(vel.x, 0, vel.z);
    const hl = hv.length();
    const dir = hl > 0.1 ? hv.scale(1 / hl) : new Vector3(d.def.normalAxis === "x" ? 1 : 0, 0, d.def.normalAxis === "z" ? 1 : 0);
    // the door leaf comes off its hinges and flies
    this.makeChunk(d.def.id, 0, 0, pos, d.def.half, 14, dir.scale(Math.min(hl, 8) * 0.55 + 2).add(new Vector3(0, 1.2, 0)), new Vector3(0, w.rng.range(-3, 3), w.rng.range(-4, 4)), true);
    w.emit({ t: "doorBreak", id: d.def.id, pos: [pos.x, pos.y, pos.z] });
    w.emit({ t: "impact", material: "wood", pos: [pos.x, pos.y, pos.z], strength: 0.8, a: "wall", b: "wood" });
    void by;
  }

  /** Doorways and wall openings for navigation. */
  portals(): Portal[] {
    const out: Portal[] = [];
    for (const wall of this.walls) {
      const d = wall.def;
      for (let c = 0; c < d.cols; c++) {
        const low = wall.panels[c];
        const mid = d.rows > 1 ? wall.panels[d.cols + c] : low;
        const open = low.broken && mid.broken;
        const ctr = wallPanelCenter(d, c, 0);
        out.push({ id: `${d.id}:${c}`, from: d.connects[0], to: d.connects[1], pos: new Vector3(ctr[0], 0, ctr[2]), open, normalAxis: d.normalAxis });
      }
    }
    for (const dr of this.doors) {
      out.push({ id: dr.def.id, from: dr.def.connects[0], to: dr.def.connects[1], pos: new Vector3(dr.def.c[0], 0, dr.def.c[2]), open: dr.broken, normalAxis: dr.def.normalAxis });
    }
    return out;
  }

  /** Snapshot of topology for net/late-join: which panels/doors are broken. */
  topology(): { walls: { id: string; broken: number[]; rev: number }[]; doors: { id: string; broken: boolean; rev: number }[] } {
    return {
      walls: this.walls.map((w) => ({ id: w.def.id, broken: w.panels.filter((p) => p.broken).map((p) => p.idx), rev: w.rev })),
      doors: this.doors.map((d) => ({ id: d.def.id, broken: d.broken, rev: d.rev })),
    };
  }
}

void ARENAS;

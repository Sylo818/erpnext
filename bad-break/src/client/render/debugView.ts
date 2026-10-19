/**
 * Debug/placeholder renderer: draws physical shapes as simple meshes parented to the sim's nodes.
 * Used by the lab page and as the fallback if render assets fail to load.
 */
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { RIG_BODIES } from "../../shared/data/regions.js";
import type { ShapeSpec } from "../../shared/data/rigspec.js";
import type { PropShapePart } from "../../shared/data/props.js";
import type { SimWorld } from "../../shared/sim/world.js";

function mat(scene: Scene, hex: string, alpha = 1): StandardMaterial {
  const m = new StandardMaterial("dbg" + hex, scene);
  m.diffuseColor = Color3.FromHexString(hex);
  m.specularColor = new Color3(0.1, 0.1, 0.1);
  m.alpha = alpha;
  return m;
}

function shapeMesh(scene: Scene, s: ShapeSpec, m: StandardMaterial): Mesh {
  switch (s.kind) {
    case "box": {
      const b = MeshBuilder.CreateBox("b", { width: s.half[0] * 2, height: s.half[1] * 2, depth: s.half[2] * 2 }, scene);
      b.position.set(s.c[0], s.c[1], s.c[2]);
      b.material = m;
      return b;
    }
    case "sphere": {
      const b = MeshBuilder.CreateSphere("s", { diameter: s.r * 2, segments: 12 }, scene);
      b.position.set(s.c[0], s.c[1], s.c[2]);
      b.material = m;
      return b;
    }
    case "capsule": {
      const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]) + 2 * s.r;
      const b = MeshBuilder.CreateCapsule("c", { height: len, radius: s.r, tessellation: 12, subdivisions: 4 }, scene);
      b.position.set((s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2, (s.a[2] + s.b[2]) / 2);
      b.material = m;
      return b;
    }
  }
}

function partMesh(scene: Scene, p: PropShapePart, m: StandardMaterial): Mesh {
  switch (p.kind) {
    case "box": {
      const b = MeshBuilder.CreateBox("pb", { width: p.half[0] * 2, height: p.half[1] * 2, depth: p.half[2] * 2 }, scene);
      b.position.set(p.c[0], p.c[1], p.c[2]);
      if (p.rotY) b.rotation.y = p.rotY;
      b.material = m;
      return b;
    }
    case "sphere": {
      const b = MeshBuilder.CreateSphere("ps", { diameter: p.r * 2, segments: 10 }, scene);
      b.position.set(p.c[0], p.c[1], p.c[2]);
      b.material = m;
      return b;
    }
    case "capsule":
    case "cylinder": {
      const a = new Vector3(...p.a),
        bb = new Vector3(...p.b);
      const len = Vector3.Distance(a, bb) + (p.kind === "capsule" ? 2 * p.r : 0);
      const c = p.kind === "capsule" ? MeshBuilder.CreateCapsule("pc", { height: Math.max(len, p.r * 2.01), radius: p.r, tessellation: 10 }, scene) : MeshBuilder.CreateCylinder("pc", { height: Math.max(len, 0.01), diameter: p.r * 2, tessellation: 14 }, scene);
      c.position.copyFrom(a.add(bb).scale(0.5));
      const dir = bb.subtract(a);
      if (dir.length() > 1e-4) {
        dir.normalize();
        // align Y axis with dir
        const axis = Vector3.Cross(Vector3.Up(), dir);
        const ang = Math.acos(Math.min(1, Math.max(-1, Vector3.Dot(Vector3.Up(), dir))));
        if (axis.length() > 1e-4) c.rotationQuaternion = null, c.rotate(axis.normalize(), ang);
      }
      c.material = m;
      return c;
    }
  }
}

export class DebugView {
  private rigMeshes: Mesh[][] = [[], []];
  private propMeshes = new Map<string, Mesh[]>();
  private chunkMeshes = new Map<string, Mesh>();
  private panelMeshes = new Map<string, Mesh>();
  private lastPanelBroken = new Map<string, boolean>();
  constructor(private scene: Scene, private world: SimWorld) {
    const colours = ["#d9803a", "#3aa6b8"];
    for (let s = 0; s < 2; s++) {
      const f = world.fighters[s];
      const m = mat(scene, colours[s]);
      for (let i = 0; i < RIG_BODIES.length; i++) {
        const mesh = shapeMesh(scene, f.spec.bodies[i].shape, m);
        mesh.parent = f.rig.nodes[i];
        this.rigMeshes[s].push(mesh);
      }
    }
    // arena
    const sm = mat(scene, "#8d8f94");
    const wm = mat(scene, "#b9b3a0");
    for (const s of world.arena.solids) {
      if (s.kind === "ceiling") continue;
      const b = MeshBuilder.CreateBox(s.id, { width: s.half[0] * 2, height: s.half[1] * 2, depth: s.half[2] * 2 }, scene);
      b.position.set(s.c[0], s.c[1], s.c[2]);
      b.material = s.kind === "floor" ? sm : s.colour ? mat(scene, s.colour) : wm;
      if (s.foreground) b.visibility = 0.35;
    }
    const pm = mat(scene, "#d8cfb8");
    for (const wall of world.destruction.walls) {
      for (const p of wall.panels) {
        const b = MeshBuilder.CreateBox(`panel${p.idx}`, { width: p.half[0] * 2, height: p.half[1] * 2, depth: p.half[2] * 2 }, scene);
        b.position.copyFrom(p.c);
        b.material = pm;
        this.panelMeshes.set(`${wall.def.id}:${p.idx}`, b);
      }
    }
  }
  update() {
    const w = this.world;
    // props
    const seen = new Set<string>();
    const pmat = mat(this.scene, "#c8a46a");
    for (const p of w.props.list) {
      seen.add(p.id);
      if (!this.propMeshes.has(p.id)) {
        const meshes = p.def.parts.map((part) => partMesh(this.scene, part, pmat));
        for (const m of meshes) m.parent = p.node;
        this.propMeshes.set(p.id, meshes);
      }
    }
    for (const [id, ms] of this.propMeshes) {
      if (!seen.has(id)) {
        for (const m of ms) m.dispose();
        this.propMeshes.delete(id);
      }
    }
    for (const wall of w.destruction.walls) {
      for (const p of wall.panels) {
        const key = `${wall.def.id}:${p.idx}`;
        const mesh = this.panelMeshes.get(key);
        if (mesh && p.broken) mesh.setEnabled(false);
        else if (mesh) mesh.setEnabled(true);
      }
    }
    const cm = mat(this.scene, "#d8cfb8");
    const live = new Set<string>();
    for (const c of w.destruction.chunks) {
      live.add(c.id);
      let m = this.chunkMeshes.get(c.id);
      if (!m) {
        m = MeshBuilder.CreateBox(c.id, { width: c.half[0] * 2, height: c.half[1] * 2, depth: c.half[2] * 2 }, this.scene);
        m.material = cm;
        this.chunkMeshes.set(c.id, m);
      }
      m.position.copyFrom(c.node.position);
      m.rotationQuaternion = c.node.rotationQuaternion!.clone();
    }
    for (const [id, m] of this.chunkMeshes) if (!live.has(id)) (m.dispose(), this.chunkMeshes.delete(id));
    // hide meshes of detached rig bodies
    for (let s = 0; s < 2; s++) {
      const f = w.fighters[s];
      for (let i = 0; i < RIG_BODIES.length; i++) this.rigMeshes[s][i].setEnabled(f.rig.attached[i]);
    }
  }
}

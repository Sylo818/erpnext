/**
 * Developer lab (?lab=1): drives the real simulation in the browser with debug rendering, and exposes a
 * scripting API on window.__lab so tests and screenshots can step the sim deterministically.
 */
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Scene } from "@babylonjs/core/scene.js";
import { createEngine } from "./engine/createEngine";
import { loadHavok } from "./engine/havok";
import { DebugView } from "./render/debugView";
import { SimWorld } from "../shared/sim/world";
import { BTN, emptyIntent, type Intent } from "../shared/sim/input";

export async function startLab(canvas: HTMLCanvasElement) {
  const q = new URLSearchParams(location.search);
  const handle = await createEngine(canvas);
  const engine = handle.engine;
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.08, 0.09, 0.12, 1);
  const havok = await loadHavok();
  const world = new SimWorld({ scene, havok, fighters: [q.get("f0") ?? "gary", q.get("f1") ?? "ricky"], seed: 5, substeps: 2 });
  const cam = new ArcRotateCamera("cam", -Math.PI / 2 - 0.3, 1.0, 9, new Vector3(-3, 1, 0), scene);
  scene.activeCamera = cam;
  new HemisphericLight("h", new Vector3(0.3, 1, -0.4), scene).intensity = 0.9;
  const sun = new DirectionalLight("d", new Vector3(-0.4, -1, 0.5), scene);
  sun.intensity = 0.6;
  const view = new DebugView(scene, world);
  const intents: [Intent, Intent] = [emptyIntent(), emptyIntent()];
  let seq = 0;
  const api = {
    backend: handle.backend,
    reason: handle.reason,
    gpu: handle.gpuName,
    world,
    BTN,
    intents,
    /** Advance n fixed ticks with current intents. */
    step(n: number) {
      for (let i = 0; i < n; i++) {
        intents[0].seq = intents[1].seq = ++seq;
        world.step(intents);
      }
      view.update();
    },
    /** Run n ticks, calling script(tick) first to set intents. */
    run(n: number, script?: (t: number, i: [Intent, Intent]) => void) {
      for (let i = 0; i < n; i++) {
        script?.(i, intents);
        intents[0].seq = intents[1].seq = ++seq;
        world.step(intents);
      }
      view.update();
    },
    camera(alpha: number, beta: number, radius: number, tx: number, ty: number, tz: number) {
      cam.alpha = alpha;
      cam.beta = beta;
      cam.radius = radius;
      cam.target.set(tx, ty, tz);
    },
    render() {
      scene.render();
    },
    /** Render and return a PNG data URL (read in the same task so the buffer is valid). */
    capture(): string {
      scene.render();
      return canvas.toDataURL("image/png");
    },
    /** Teleport both fighters next to each other facing each other. */
    duel(gap = 1.15, x = -3, z = 0.9) {
      world.fighters[0].placeAt([x - gap / 2, 0, z], Math.PI / 2);
      world.fighters[1].placeAt([x + gap / 2, 0, z], -Math.PI / 2);
      for (const i of intents) {
        i.buttons = 0;
        i.moveX = 0;
        i.moveZ = 0;
      }
    },
    stats() {
      const f = world.fighters;
      return {
        t: world.time,
        phase: world.match.phase,
        states: f.map((x) => x.state),
        pos: f.map((x) => [x.pos.x, x.pos.z]),
        vitality: f.map((x) => x.inj.vitality),
        events: world.events.length,
        perf: world.perf,
        corrections: world.corrections,
      };
    },
  };
  (window as unknown as { __lab: typeof api }).__lab = api;
  // run 3.5s of settle so screenshots show the fighting phase
  if (q.get("auto") !== "0") api.step(Number(q.get("settle") ?? 210));
  engine.runRenderLoop(() => scene.render());
  (window as unknown as { __ready: boolean }).__ready = true;
  return api;
}

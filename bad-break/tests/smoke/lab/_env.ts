import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent.js";
import { Logger } from "@babylonjs/core/Misc/logger.js";

const require = createRequire(import.meta.url);
export async function makeEnv() {
  Logger.LogLevels = Logger.WarningLogLevel | Logger.ErrorLogLevel;
  const HavokPhysics = (await import("@babylonjs/havok")).default as (o?: any) => Promise<any>;
  const wasmBinary = readFileSync(require.resolve("@babylonjs/havok/lib/esm/HavokPhysics.wasm"));
  const havok = await HavokPhysics({ wasmBinary });
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const plugin = new HavokPlugin(false, havok);
  scene.enablePhysics(new Vector3(0, -9.81, 0), plugin);
  scene.physicsEnabled = false;
  const pe = scene.getPhysicsEngine()!;
  return { havok, engine, scene, plugin, pe, step: (n = 1) => { for (let i = 0; i < n; i++) pe._step(1 / 60); } };
}

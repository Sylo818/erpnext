/**
 * Headless Babylon + Havok bootstrap for Node: used by the match service, smoke tests and bot tooling.
 * No rendering code is loaded. Verified: Node >= 22, Havok WASM loaded from disk (no fetch), NullEngine.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Logger } from "@babylonjs/core/Misc/logger.js";
import { SimWorld, type WorldOptions } from "../shared/sim/world.js";

const require = createRequire(import.meta.url);
let havokPromise: Promise<unknown> | null = null;

export function loadHavokNode(): Promise<unknown> {
  if (!havokPromise) {
    havokPromise = (async () => {
      const mod = (await import("@babylonjs/havok")) as unknown as { default: (o?: unknown) => Promise<unknown> };
      const wasmBinary = readFileSync(require.resolve("@babylonjs/havok/lib/esm/HavokPhysics.wasm"));
      return mod.default({ wasmBinary });
    })();
  }
  return havokPromise;
}

export interface HeadlessWorld {
  world: SimWorld;
  scene: Scene;
  engine: NullEngine;
  dispose(): void;
}

export async function createHeadlessWorld(opts: Omit<WorldOptions, "scene" | "havok">): Promise<HeadlessWorld> {
  Logger.LogLevels = Logger.WarningLogLevel | Logger.ErrorLogLevel;
  const havok = await loadHavokNode();
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const world = new SimWorld({ ...opts, scene, havok });
  return {
    world,
    scene,
    engine,
    dispose() {
      world.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}

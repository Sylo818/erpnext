/**
 * Rendering backend selection. The backend is chosen and fully initialised BEFORE any scene resources
 * are created: WebGPU when supported and successfully initialised, otherwise WebGL2.
 * Babylon does not migrate an existing WebGPU scene to WebGL, so a failed WebGPU init disposes the
 * engine and the WebGL2 engine is created fresh on the same (replaced) canvas.
 */
import { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { Engine } from "@babylonjs/core/Engines/engine.js";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine.js";

export type Backend = "webgpu" | "webgl2";
export type BackendPreference = "auto" | "webgpu" | "webgl2";

export interface EngineHandle {
  engine: AbstractEngine;
  backend: Backend;
  canvas: HTMLCanvasElement;
  /** Why the chosen backend was selected (shown in the debug overlay and logged). */
  reason: string;
  gpuName: string;
}

function backendFromQuery(): BackendPreference {
  const q = new URLSearchParams(location.search).get("backend");
  return q === "webgl2" || q === "webgpu" ? q : "auto";
}

function freshCanvas(old: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.id = old.id;
  c.setAttribute("touch-action", "none");
  old.replaceWith(c);
  return c;
}

export async function createEngine(canvasIn: HTMLCanvasElement, pref: BackendPreference = backendFromQuery()): Promise<EngineHandle> {
  let canvas = canvasIn;
  let reason = "";
  if (pref !== "webgl2") {
    let supported = false;
    try {
      supported = await WebGPUEngine.IsSupportedAsync;
    } catch {
      supported = false;
    }
    if (supported) {
      const gpu = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true, powerPreference: "high-performance", stencil: true });
      try {
        await gpu.initAsync();
        const name = (gpu as any)._adapterInfo?.description || (gpu as any)._adapterInfo?.vendor || "WebGPU adapter";
        return { engine: gpu, backend: "webgpu", canvas, reason: "WebGPU supported and initialised", gpuName: String(name) };
      } catch (e) {
        console.warn("[BAD BREAK] WebGPU init failed, falling back to WebGL2:", e);
        reason = "WebGPU init failed: " + (e as Error).message;
        try {
          gpu.dispose();
        } catch {
          /* ignore */
        }
        canvas = freshCanvas(canvas);
      }
    } else {
      reason = pref === "webgpu" ? "WebGPU requested but not supported" : "WebGPU not supported";
    }
  } else {
    reason = "WebGL2 requested";
  }
  const engine = new Engine(canvas, true, { antialias: true, powerPreference: "high-performance", stencil: true, disableWebGL2Support: false, preserveDrawingBuffer: false }, true);
  if (engine.webGLVersion < 2) {
    throw new Error("WebGL2 is required but not available in this browser.");
  }
  let gpuName = "WebGL2";
  try {
    const gl = engine._gl;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (ext) gpuName = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  } catch {
    /* ignore */
  }
  return { engine, backend: "webgl2", canvas, reason: reason || "WebGL2 fallback", gpuName };
}

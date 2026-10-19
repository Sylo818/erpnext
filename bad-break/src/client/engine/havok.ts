import HavokPhysics from "@babylonjs/havok";
// Vite resolves this to a hashed asset URL in production and a served path in dev.
import wasmUrl from "@babylonjs/havok/lib/esm/HavokPhysics.wasm?url";

let cached: Promise<unknown> | null = null;
/** Loads the Havok WASM once per page. */
export function loadHavok(): Promise<any> {
  if (!cached) {
    cached = (HavokPhysics as unknown as (o?: unknown) => Promise<unknown>)({
      locateFile: (file: string) => (file.endsWith(".wasm") ? wasmUrl : file),
    });
  }
  return cached;
}

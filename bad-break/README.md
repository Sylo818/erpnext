# BAD BREAK

> Two idiots. One room. Absolutely no insurance.

A browser-based 3D physics fighting game built with Babylon.js, TypeScript, Vite and Babylon Physics V2 (Havok).

**Status: work in progress.** The simulation core, active-ragdoll fighters, injury model, props, grappling,
destructible wall patches, match rules and a developer lab are in place. There is no title menu, HUD, final
art, audio, bots or online play wired up yet, and strike hit registration is still being debugged.

## Requirements

- Node.js 22.12 or newer (22 LTS recommended)
- A browser with WebGL2 (WebGPU is used automatically when available)

## Run it

```bash
cd bad-break
npm install          # .npmrc sets legacy-peer-deps to work around an npm 10 resolver bug
npm run dev          # http://localhost:5173
```

Open `http://localhost:5173/?lab=1` for the developer lab: the real simulation with placeholder debug meshes.
Add `&backend=webgl2` or `&backend=webgpu` to force a rendering backend.

## Useful commands

| Command | What it does |
| --- | --- |
| `npm run typecheck` | Type-check client, shared and server code |
| `npm test` | Unit tests (injury model, gait / leg IK) |
| `npm run smoke` | Headless physics smoke test (not yet re-pointed, see `tests/smoke/`) |
| `npx tsx tests/smoke/sim-basic.ts` | Headless full-simulation smoke test in Node |
| `npx tsx tests/smoke/duel.ts` | Headless combat scenarios |

## Layout

- `src/shared/` fixed-step simulation and rules, shared by the browser and the (planned) match server
- `src/client/` rendering, engine selection, lab
- `src/server/` headless Babylon + Havok bootstrap (match service to come)
- `tests/` unit tests and headless smoke / lab scripts
- `tools/` screenshot and contact-sheet helpers (need Playwright, see `tools/shot.mjs`)

## Verified engineering findings so far

- Babylon 9.30.0 + `@babylonjs/havok` 1.3.14, pinned. Havok initialises headless in Node 22 with `NullEngine`.
- Havok 6-DoF limits: `ANGULAR_X` is the twist about the main axis, `ANGULAR_Y` about the perp axis, `ANGULAR_Z`
  about main x perp. Middle-axis ranges above 90 degrees show Euler gimbal coupling.
- Two physics substeps per 60 Hz tick cut ragdoll joint stretch from about 10 cm to 3 cm under extreme impulses.
- `PhysicsCharacterController` honours shape filter masks in its queries, so one fighter's capsule can block the
  other's without ragdoll bodies being blocked.

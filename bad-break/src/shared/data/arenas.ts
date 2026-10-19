/**
 * Arena definitions. One source of truth for collision geometry (sim + server), the offline asset
 * generator (render meshes) and bot navigation.
 *
 * World: Y up, floor at y=0, units metres. Camera looks generally toward +Z/+X from the -Z/-X side,
 * so south (-Z) and west (-X) walls are "foreground" walls that fade out.
 */
import type { V3 } from "./rigspec.js";
import type { Material } from "./props.js";

export interface SolidBox {
  id: string;
  c: V3;
  half: V3;
  mat: Material;
  /** Visual hint for the asset generator (what kind of thing this is). */
  kind: "floor" | "ceiling" | "wall" | "support" | "counter" | "locker" | "cabinet" | "pillar" | "bar" | "decor";
  /** Foreground walls fade when they obstruct the camera. */
  foreground?: boolean;
  colour?: string;
}

export interface WallPatchDef {
  id: string;
  /** Wall plane: patch spans `uAxis` (horizontal) and Y. Normal axis is the other horizontal axis. */
  normalAxis: "x" | "z";
  /** Centre of the patch in the plane's origin (the wall centre line). */
  origin: V3;
  cols: number;
  rows: number;
  /** Panel cell size along u (horizontal in the plane) and v (vertical), and wall thickness. */
  cellU: number;
  cellV: number;
  thickness: number;
  mat: Material;
  /** Impulse (N*s) needed to break an individual panel on direct hit. */
  threshold: number;
  /** Per-column threshold multiplier (edge panels stronger). */
  colMult?: number[];
  rowMult?: number[];
  chunksPerPanel: number;
  /** Both sides of this patch connect these zones (used by bot navigation to learn about new routes). */
  connects: [string, string];
}

export interface DoorDef {
  id: string;
  c: V3;
  half: V3;
  normalAxis: "x" | "z";
  threshold: number;
  mat: Material;
  connects: [string, string];
}

export interface FurnitureDef {
  id: string;
  prop: string;
  pos: V3;
  yaw: number;
  /** Starts asleep and "planted": needs this impulse to start moving (fixtures). */
  anchoredUntil?: number;
}

export interface PropPlacement {
  prop: string;
  pos: V3;
  yaw?: number;
  /** Euler pitch/roll for props lying down. */
  pitch?: number;
  roll?: number;
}

export interface LightDef {
  kind: "point" | "spot" | "hemi";
  pos: V3;
  colour: string;
  intensity: number;
  range?: number;
  flicker?: number;
  castShadow?: boolean;
  dir?: V3;
  angle?: number;
}

export interface ZoneDef {
  id: string;
  min: [number, number];
  max: [number, number];
}

export interface ArenaDef {
  id: string;
  name: string;
  blurb: string;
  ceiling: number;
  bounds: { min: V3; max: V3 };
  solids: SolidBox[];
  walls: WallPatchDef[];
  doors: DoorDef[];
  furniture: FurnitureDef[];
  props: PropPlacement[];
  spawns: [{ pos: V3; yaw: number }, { pos: V3; yaw: number }];
  zones: ZoneDef[];
  /** Positions bots like to throw an opponent from, aiming at a wall patch. */
  throwSpots: { wallId: string; from: V3; toward: V3 }[];
  lighting: { ambient: string; ambientIntensity: number; sun: { dir: V3; colour: string; intensity: number }; sky: string; fog: { colour: string; density: number }; lights: LightDef[]; exposure: number; contrast: number; bloom: number };
  materials: { floor: Material; wall: Material };
  ambience: { hum: number; tone: string };
  camera: { focus: V3; yaw: number; pitch: number; baseDistance: number; minDistance: number; maxDistance: number };
  theme: { floor: string; wall: string; trim: string; accent: string };
}

const S = (id: string, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, mat: Material, kind: SolidBox["kind"], extra: Partial<SolidBox> = {}): SolidBox => ({ id, c: [cx, cy, cz], half: [hx, hy, hz], mat, kind, ...extra });

const H = 2.8; // wall height
const HH = H / 2;

export const BREAK_ROOM: ArenaDef = {
  id: "breakRoom",
  name: "Break Room Breakdown",
  blurb: "A warehouse break room and a cramped supervisor's office. The wall between them has two days until retirement.",
  ceiling: H,
  bounds: { min: [-7, 0, -4], max: [5.4, H, 4] },
  solids: [
    S("floor", -0.8, -0.5, 0, 7.2, 0.5, 5, "concrete", "floor"),
    S("ceiling", -0.8, H + 0.5, 0, 7.2, 0.5, 5, "plaster", "ceiling"),
    // outer shell
    S("wallW", -7.2, HH, 0, 0.2, HH, 4.4, "plaster", "wall", { foreground: true }),
    S("wallS", -2.9, HH, -4.2, 4.5, HH, 0.2, "plaster", "wall", { foreground: true }),
    S("wallN", -2.9, HH, 4.2, 4.5, HH, 0.2, "plaster", "wall"),
    S("wallEstub1", 1.2, HH, 3.7, 0.2, HH, 0.7, "concrete", "wall"),
    S("wallEstub2", 1.2, HH, -3.7, 0.2, HH, 0.7, "concrete", "wall"),
    S("officeS", 3.6, HH, -3.2, 2.2, HH, 0.2, "plaster", "wall", { foreground: true }),
    S("officeN", 3.6, HH, 3.2, 2.2, HH, 0.2, "plaster", "wall"),
    S("officeE", 5.6, HH, 0, 0.2, HH, 3.4, "plaster", "wall"),
    // dividing wall solid supports (load bearing - these do NOT break)
    S("dividerSupportS", 1.2, HH, -2.4, 0.2, HH, 0.6, "concrete", "support"),
    S("dividerPost", 1.2, HH, 1.85, 0.2, HH, 0.05, "concrete", "support"),
    S("dividerLintel", 1.2, 2.45, 2.4, 0.2, 0.35, 0.55, "concrete", "support"),
    S("dividerSupportN", 1.2, HH, 2.9, 0.2, HH, 0.1, "concrete", "support"),
    // break room fixtures
    S("lockers", -6.7, 0.95, -2.0, 0.3, 0.95, 1.5, "metal", "locker", { colour: "#4a6a8a" }),
    S("counter", -4.6, 0.46, 3.6, 1.6, 0.46, 0.4, "wood", "counter"),
    S("fridge", -6.5, 0.9, 3.4, 0.35, 0.9, 0.35, "metal", "cabinet", { colour: "#c9ced4" }),
    S("pillar", -2.2, HH, 2.6, 0.25, HH, 0.25, "concrete", "pillar"),
    // office fixtures
    S("filing1", 5.2, 0.7, -2.2, 0.28, 0.7, 0.4, "metal", "cabinet", { colour: "#6d7a60" }),
    S("filing2", 5.2, 0.7, -1.3, 0.28, 0.7, 0.4, "metal", "cabinet", { colour: "#6d7a60" }),
    S("shelfOffice", 3.2, 0.85, 2.95, 0.9, 0.85, 0.2, "wood", "cabinet"),
  ],
  walls: [
    {
      id: "divider",
      normalAxis: "x",
      origin: [1.2, 0, 0],
      cols: 4,
      rows: 3,
      cellU: 0.9,
      cellV: H / 3,
      thickness: 0.4,
      mat: "plaster",
      threshold: 230,
      colMult: [1.25, 0.9, 0.9, 1.25],
      rowMult: [1.15, 1.0, 1.15],
      chunksPerPanel: 3,
      connects: ["breakRoom", "office"],
    },
  ],
  doors: [{ id: "officeDoor", c: [1.2, 1.05, 2.4], half: [0.06, 1.05, 0.45], normalAxis: "x", threshold: 120, mat: "wood", connects: ["breakRoom", "office"] }],
  furniture: [
    { id: "table1", prop: "table", pos: [-3.6, 0.37, -0.8], yaw: 0.15 },
    { id: "vending", prop: "vendingMachine", pos: [-0.9, 0.9, -3.55], yaw: 0, anchoredUntil: 650 },
    { id: "cooler", prop: "waterCooler", pos: [-0.3, 0.45, 3.5], yaw: 0 },
    { id: "desk", prop: "desk", pos: [4.1, 0.37, 0.8], yaw: Math.PI / 2 },
  ],
  props: [
    { prop: "foldingChair", pos: [-4.8, 0.45, -0.8], yaw: 1.3 },
    { prop: "foldingChair", pos: [-2.4, 0.45, -0.6], yaw: -1.7 },
    { prop: "foldingChair", pos: [-3.7, 0.45, -1.9], yaw: 0.2 },
    { prop: "foldingChair", pos: [-3.3, 0.45, 0.45], yaw: 3.0 },
    { prop: "mug", pos: [-3.9, 0.82, -0.75] },
    { prop: "mug", pos: [-3.2, 0.82, -0.85] },
    { prop: "pan", pos: [-5.2, 1.0, 3.55], yaw: 0.4 },
    { prop: "microwave", pos: [-4.0, 1.12, 3.6], yaw: 0 },
    { prop: "lid", pos: [-1.8, 0.02, 3.5], yaw: 0 },
    { prop: "broom", pos: [-6.3, 0.0, 1.1], pitch: 0.12, yaw: 0.2 },
    { prop: "extinguisher", pos: [-1.55, 0.3, -3.8] },
    { prop: "crate", pos: [-6.2, 0.2, -3.5], yaw: 0.3 },
    { prop: "crate", pos: [-5.5, 0.2, -3.6], yaw: -0.2 },
    { prop: "crate", pos: [-5.8, 0.6, -3.55], yaw: 0.5 },
    { prop: "monitor", pos: [4.2, 0.95, 0.5], yaw: -Math.PI / 2 + 0.3 },
    { prop: "lamp", pos: [4.1, 0.88, 1.35], yaw: 0.5 },
    { prop: "bat", pos: [5.05, 0.08, 2.7], pitch: 1.4, yaw: 0.5 },
    { prop: "foldingChair", pos: [3.1, 0.45, 0.8], yaw: -Math.PI / 2 },
    { prop: "crate", pos: [2.2, 0.2, -2.5], yaw: 0.6 },
  ],
  spawns: [
    { pos: [-4.7, 0, 0.9], yaw: Math.PI / 2 },
    { pos: [-1.6, 0, 0.9], yaw: -Math.PI / 2 },
  ],
  zones: [
    { id: "breakRoom", min: [-7, -4], max: [1.0, 4] },
    { id: "office", min: [1.4, -3], max: [5.4, 3] },
  ],
  throwSpots: [{ wallId: "divider", from: [-1.0, 0, 0.0], toward: [1.2, 1.0, 0.0] }],
  lighting: {
    ambient: "#9fb0c4",
    ambientIntensity: 0.55,
    sun: { dir: [0.35, -1, 0.5], colour: "#fff1d6", intensity: 0.8 },
    sky: "#1b2230",
    fog: { colour: "#252b38", density: 0.012 },
    lights: [
      { kind: "point", pos: [-3.4, 2.5, 0.0], colour: "#e8f3ff", intensity: 1.0, range: 11, flicker: 0.04, castShadow: true },
      { kind: "point", pos: [-5.5, 2.5, 2.5], colour: "#e8f3ff", intensity: 0.5, range: 7, flicker: 0.1 },
      { kind: "point", pos: [3.5, 2.4, 0.0], colour: "#ffe2b0", intensity: 0.8, range: 8, castShadow: false },
    ],
    exposure: 1.05,
    contrast: 1.15,
    bloom: 0.2,
  },
  materials: { floor: "concrete", wall: "plaster" },
  ambience: { hum: 55, tone: "fluorescent" },
  camera: { focus: [-1.2, 0.9, 0], yaw: 0.0, pitch: 0.95, baseDistance: 9.5, minDistance: 6.5, maxDistance: 15 },
  theme: { floor: "#8a8f94", wall: "#c9c3ae", trim: "#5a6470", accent: "#e0a030" },
};

export const ARENAS: Record<string, ArenaDef> = { breakRoom: BREAK_ROOM };
export const ARENA_LIST = Object.values(ARENAS);

export function wallPanelCenter(w: WallPatchDef, col: number, row: number): V3 {
  const u = (col - (w.cols - 1) / 2) * w.cellU;
  const y = (row + 0.5) * w.cellV;
  return w.normalAxis === "x" ? [w.origin[0], y, w.origin[2] + u] : [w.origin[0] + u, y, w.origin[2]];
}
export function wallPanelHalf(w: WallPatchDef): V3 {
  return w.normalAxis === "x" ? [w.thickness / 2, w.cellV / 2, w.cellU / 2] : [w.cellU / 2, w.cellV / 2, w.thickness / 2];
}
export function zoneOf(a: ArenaDef, x: number, z: number): string | null {
  for (const zn of a.zones) if (x >= zn.min[0] && x <= zn.max[0] && z >= zn.min[1] && z <= zn.max[1]) return zn.id;
  return null;
}

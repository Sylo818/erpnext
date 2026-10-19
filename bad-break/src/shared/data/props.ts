/**
 * Interactive object definitions (data-driven). Prop local frame: origin at the centre of mass,
 * +Y is the long axis for stick-like props (bat, broom) and "up" for everything else, +Z is "front".
 */
import type { V3 } from "./rigspec.js";

export type Material = "fist" | "wood" | "metal" | "glass" | "plastic" | "ceramic" | "plaster" | "concrete" | "flesh" | "cloth" | "foam" | "electronics" | "bone";
export type WeightClass = "light" | "medium" | "heavy" | "fixture";
export type SwingStyle = "club" | "thrust" | "smash" | "shield" | "throwOnly" | "flail" | "none";

export type PropShapePart =
  | { kind: "box"; c: V3; half: V3; rotY?: number }
  | { kind: "capsule"; a: V3; b: V3; r: number }
  | { kind: "cylinder"; a: V3; b: V3; r: number }
  | { kind: "sphere"; c: V3; r: number };

export interface GripDef {
  /** Prop-local position of the palm anchor. */
  pos: V3;
  /** Which hand slot uses it first: "main" or "off". */
  role: "main" | "off";
  /** Hand local orientation hint: finger axis direction in prop space. */
  axis?: V3;
}

export interface PropDamage {
  /** 0..1 how heavy / sharp the head is; gates dismemberment (see INJURY.detachMinWeaponHeft). */
  heft: number;
  /** Multiplies the impulse proxy for a swing with this prop. */
  impulseMult: number;
  /** Effective mass proxy in kg of prop+arm used with swing speed (kg). */
  effMass: number;
  material: Material;
  /** Extra stagger / balance damage multiplier. */
  stagger: number;
  /** Stamina cost per swing at weight 1. */
  stamina: number;
  /** Swing duration multiplier (heavier = slower). */
  swingTime: number;
  /** Impact loudness / sound hint id for the metallic "clang" etc. */
  sound: string;
}

export interface PropBreak {
  /** Impact impulse budget: durability drains by (impulse - threshold); breaks at 0. */
  durability: number;
  /** Ignore hits weaker than this (N*s). */
  threshold: number;
  /** PropDef ids spawned at break (positions are offsets in prop local space). */
  pieces: { id: string; offset: V3; rotY?: number }[];
  /** Cosmetic shard / splinter effect kind. */
  fx: "glass" | "wood" | "plastic" | "metalDent" | "electronics" | "foam" | "ceramic" | "none";
  /** If true the prop keeps existing (dented) and never splits. */
  dentOnly?: boolean;
}

export interface PropDef {
  id: string;
  name: string;
  mass: number;
  parts: PropShapePart[];
  weight: WeightClass;
  /** Hands required to lift (1 or 2). Heavy-class can only be dragged. */
  hands: 1 | 2;
  grips: GripDef[];
  /** Strike samples (prop-local) swept during an active swing. Tip first. */
  strike: V3[];
  /** Distance from main grip to tip (m): reach. */
  reach: number;
  swing: SwingStyle;
  damage: PropDamage;
  /** Thrown behaviour. */
  throwSpeed: number;
  throwSpin: number;
  throwDamageMult: number;
  /** Shield properties (trash-can lid). */
  guard?: { radius: number; strength: number; coverageForward: number };
  brk: PropBreak;
  /** Asset key in props.glb */
  mesh: string;
  /** Pull-against factor: how strongly the carried weight hampers movement/arm pose (0..1). */
  hindrance: number;
  /** Gets autonomous highlight priority for bots. */
  botValue: number;
  tags: string[];
}

const box = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): PropShapePart => ({ kind: "box", c: [cx, cy, cz], half: [hx, hy, hz] });
const cap = (ay: number, by: number, r: number): PropShapePart => ({ kind: "capsule", a: [0, ay, 0], b: [0, by, 0], r });

export const PROPS: Record<string, PropDef> = {
  foldingChair: {
    id: "foldingChair",
    name: "Folding Chair",
    mass: 3.6,
    parts: [box(0, 0.02, 0, 0.21, 0.02, 0.21), box(0, 0.28, -0.2, 0.21, 0.2, 0.015), box(-0.18, -0.2, 0.17, 0.015, 0.22, 0.015), box(0.18, -0.2, 0.17, 0.015, 0.22, 0.015), box(-0.18, -0.2, -0.17, 0.015, 0.22, 0.015), box(0.18, -0.2, -0.17, 0.015, 0.22, 0.015)],
    weight: "medium",
    hands: 1,
    grips: [{ pos: [0, 0.3, -0.2], role: "main", axis: [1, 0, 0] }],
    strike: [[0, -0.42, 0], [0, 0.0, 0.2], [0, 0.0, -0.2]],
    reach: 0.9,
    swing: "club",
    damage: { heft: 0.55, impulseMult: 1.25, effMass: 6.2, material: "metal", stagger: 1.4, stamina: 11, swingTime: 1.15, sound: "chair" },
    throwSpeed: 11,
    throwSpin: 6,
    throwDamageMult: 1.1,
    brk: {
      durability: 140,
      threshold: 38,
      pieces: [
        { id: "chairLeg", offset: [-0.18, -0.2, 0.17] },
        { id: "chairLeg", offset: [0.18, -0.2, 0.17] },
        { id: "chairLeg", offset: [-0.18, -0.2, -0.17] },
        { id: "chairSeat", offset: [0, 0.02, 0] },
        { id: "chairBack", offset: [0, 0.28, -0.2] },
      ],
      fx: "metalDent",
    },
    mesh: "prop.foldingChair",
    hindrance: 0.25,
    botValue: 0.8,
    tags: ["improvised", "breaks"],
  },
  chairLeg: {
    id: "chairLeg",
    name: "Chair Leg",
    mass: 0.35,
    parts: [cap(0.17, -0.17, 0.016)],
    weight: "light",
    hands: 1,
    grips: [{ pos: [0, 0.12, 0], role: "main" }],
    strike: [[0, -0.2, 0], [0, 0, 0]],
    reach: 0.4,
    swing: "club",
    damage: { heft: 0.25, impulseMult: 0.95, effMass: 3.2, material: "metal", stagger: 0.6, stamina: 5, swingTime: 0.7, sound: "stick" },
    throwSpeed: 15,
    throwSpin: 12,
    throwDamageMult: 0.9,
    brk: { durability: 400, threshold: 80, pieces: [], fx: "none", dentOnly: true },
    mesh: "prop.chairLeg",
    hindrance: 0.02,
    botValue: 0.45,
    tags: ["piece", "pathetic"],
  },
  chairSeat: {
    id: "chairSeat",
    name: "Chair Seat",
    mass: 0.9,
    parts: [box(0, 0, 0, 0.21, 0.02, 0.21)],
    weight: "light",
    hands: 1,
    grips: [{ pos: [0, 0, 0.18], role: "main" }],
    strike: [[0, 0, -0.2]],
    reach: 0.4,
    swing: "club",
    damage: { heft: 0.2, impulseMult: 0.8, effMass: 3.0, material: "metal", stagger: 0.7, stamina: 5, swingTime: 0.75, sound: "chair" },
    throwSpeed: 13,
    throwSpin: 14,
    throwDamageMult: 0.8,
    brk: { durability: 300, threshold: 80, pieces: [], fx: "none", dentOnly: true },
    mesh: "prop.chairSeat",
    hindrance: 0.03,
    botValue: 0.2,
    tags: ["piece"],
  },
  chairBack: {
    id: "chairBack",
    name: "Chair Back",
    mass: 0.8,
    parts: [box(0, 0, 0, 0.21, 0.2, 0.015)],
    weight: "light",
    hands: 1,
    grips: [{ pos: [0, 0, 0], role: "main" }],
    strike: [[0, 0.2, 0]],
    reach: 0.4,
    swing: "shield",
    damage: { heft: 0.18, impulseMult: 0.7, effMass: 2.8, material: "metal", stagger: 0.6, stamina: 4, swingTime: 0.7, sound: "chair" },
    throwSpeed: 13,
    throwSpin: 14,
    throwDamageMult: 0.8,
    guard: { radius: 0.24, strength: 0.45, coverageForward: 0.2 },
    brk: { durability: 300, threshold: 80, pieces: [], fx: "none", dentOnly: true },
    mesh: "prop.chairBack",
    hindrance: 0.03,
    botValue: 0.15,
    tags: ["piece"],
  },
  bat: {
    id: "bat",
    name: "Baseball Bat",
    mass: 1.0,
    parts: [cap(0.34, -0.34, 0.034)],
    weight: "light",
    hands: 1,
    grips: [
      { pos: [0, -0.28, 0], role: "main" },
      { pos: [0, -0.1, 0], role: "off" },
    ],
    strike: [[0, 0.4, 0], [0, 0.28, 0], [0, 0.14, 0]],
    reach: 0.95,
    swing: "club",
    damage: { heft: 0.6, impulseMult: 1.5, effMass: 6.5, material: "wood", stagger: 1.3, stamina: 9, swingTime: 1.0, sound: "bat" },
    throwSpeed: 13,
    throwSpin: 8,
    throwDamageMult: 0.9,
    brk: { durability: 700, threshold: 110, pieces: [], fx: "wood", dentOnly: true },
    mesh: "prop.bat",
    hindrance: 0.05,
    botValue: 1.0,
    tags: ["weapon", "twoHandOk"],
  },
  pan: {
    id: "pan",
    name: "Frying Pan",
    mass: 1.4,
    parts: [{ kind: "cylinder", a: [0, 0.0, 0.16], b: [0, 0.03, 0.16], r: 0.14 }, box(0, 0.01, -0.12, 0.018, 0.012, 0.14)],
    weight: "light",
    hands: 1,
    grips: [{ pos: [0, 0.01, -0.18], role: "main", axis: [0, 0, 1] }],
    strike: [[0, 0.02, 0.2], [0, 0.02, 0.1], [0.1, 0.02, 0.16], [-0.1, 0.02, 0.16]],
    reach: 0.55,
    swing: "club",
    damage: { heft: 0.45, impulseMult: 1.35, effMass: 5.2, material: "metal", stagger: 1.5, stamina: 7, swingTime: 0.85, sound: "pan" },
    throwSpeed: 12,
    throwSpin: 10,
    throwDamageMult: 1.0,
    guard: { radius: 0.16, strength: 0.55, coverageForward: 0.15 },
    brk: { durability: 900, threshold: 120, pieces: [], fx: "metalDent", dentOnly: true },
    mesh: "prop.pan",
    hindrance: 0.06,
    botValue: 0.85,
    tags: ["weapon", "clang"],
  },
  broom: {
    id: "broom",
    name: "Push Broom",
    mass: 1.1,
    parts: [cap(0.65, -0.5, 0.015), box(0, -0.62, 0, 0.17, 0.04, 0.03)],
    weight: "light",
    hands: 1,
    grips: [
      { pos: [0, 0.2, 0], role: "main" },
      { pos: [0, -0.15, 0], role: "off" },
    ],
    strike: [[0, 0.68, 0], [0, 0.5, 0], [0, -0.62, 0.0]],
    reach: 1.45,
    swing: "thrust",
    damage: { heft: 0.2, impulseMult: 0.85, effMass: 3.8, material: "wood", stagger: 1.0, stamina: 6, swingTime: 1.1, sound: "stick" },
    throwSpeed: 13,
    throwSpin: 3,
    throwDamageMult: 0.7,
    brk: { durability: 120, threshold: 45, pieces: [{ id: "chairLeg", offset: [0, 0.2, 0] }], fx: "wood" },
    mesh: "prop.broom",
    hindrance: 0.08,
    botValue: 0.45,
    tags: ["reach", "awkwardClose", "twoHandOk"],
  },
  extinguisher: {
    id: "extinguisher",
    name: "Fire Extinguisher",
    mass: 5.8,
    parts: [{ kind: "cylinder", a: [0, -0.22, 0], b: [0, 0.18, 0], r: 0.075 }, box(0, 0.24, 0, 0.04, 0.05, 0.05)],
    weight: "medium",
    hands: 1,
    grips: [
      { pos: [0, 0.22, 0], role: "main" },
      { pos: [0, -0.05, 0.075], role: "off", axis: [0, 1, 0] },
    ],
    strike: [[0, -0.28, 0], [0, 0.28, 0]],
    reach: 0.7,
    swing: "smash",
    damage: { heft: 0.9, impulseMult: 1.9, effMass: 11.0, material: "metal", stagger: 2.2, stamina: 17, swingTime: 1.55, sound: "extinguisher" },
    throwSpeed: 8,
    throwSpin: 2,
    throwDamageMult: 1.4,
    brk: { durability: 1200, threshold: 150, pieces: [], fx: "foam", dentOnly: true },
    mesh: "prop.extinguisher",
    hindrance: 0.55,
    botValue: 0.75,
    tags: ["heavy", "foam", "awkward"],
  },
  lid: {
    id: "lid",
    name: "Trash-Can Lid",
    mass: 0.8,
    parts: [{ kind: "cylinder", a: [0, -0.012, 0], b: [0, 0.012, 0], r: 0.26 }],
    weight: "light",
    hands: 1,
    grips: [{ pos: [0, 0.03, 0], role: "main", axis: [1, 0, 0] }],
    strike: [[0.24, 0, 0], [-0.24, 0, 0], [0, 0, 0.24], [0, 0, -0.24]],
    reach: 0.4,
    swing: "shield",
    damage: { heft: 0.3, impulseMult: 0.85, effMass: 3.5, material: "metal", stagger: 1.6, stamina: 5, swingTime: 0.7, sound: "lid" },
    throwSpeed: 15,
    throwSpin: 20,
    throwDamageMult: 0.9,
    guard: { radius: 0.27, strength: 0.88, coverageForward: 0.3 },
    brk: { durability: 1500, threshold: 160, pieces: [], fx: "metalDent", dentOnly: true },
    mesh: "prop.lid",
    hindrance: 0.03,
    botValue: 0.7,
    tags: ["shield", "clang"],
  },
  lamp: {
    id: "lamp",
    name: "Desk Lamp",
    mass: 1.6,
    parts: [{ kind: "cylinder", a: [0, -0.25, 0], b: [0, -0.22, 0], r: 0.1 }, cap(-0.2, 0.15, 0.012), box(0, 0.25, 0.08, 0.07, 0.05, 0.1)],
    weight: "light",
    hands: 1,
    grips: [{ pos: [0, 0.0, 0], role: "main" }],
    strike: [[0, 0.27, 0.12], [0, -0.25, 0]],
    reach: 0.6,
    swing: "flail",
    damage: { heft: 0.35, impulseMult: 1.05, effMass: 4.2, material: "metal", stagger: 0.9, stamina: 6, swingTime: 0.85, sound: "lamp" },
    throwSpeed: 12,
    throwSpin: 9,
    throwDamageMult: 1.0,
    brk: { durability: 80, threshold: 36, pieces: [], fx: "glass", dentOnly: true },
    mesh: "prop.lamp",
    hindrance: 0.08,
    botValue: 0.4,
    tags: ["breakable", "bulb"],
  },
  mug: {
    id: "mug",
    name: "Coffee Mug",
    mass: 0.35,
    parts: [{ kind: "cylinder", a: [0, -0.05, 0], b: [0, 0.05, 0], r: 0.04 }],
    weight: "light",
    hands: 1,
    grips: [{ pos: [0.045, 0, 0], role: "main" }],
    strike: [[0, 0, 0.0]],
    reach: 0.3,
    swing: "throwOnly",
    damage: { heft: 0.1, impulseMult: 0.6, effMass: 0.9, material: "ceramic", stagger: 0.4, stamina: 2, swingTime: 0.5, sound: "mug" },
    throwSpeed: 20,
    throwSpin: 18,
    throwDamageMult: 1.15,
    brk: { durability: 10, threshold: 14, pieces: [], fx: "ceramic" },
    mesh: "prop.mug",
    hindrance: 0.0,
    botValue: 0.35,
    tags: ["fastThrow", "shatters"],
  },
  crate: {
    id: "crate",
    name: "Small Crate",
    mass: 9.0,
    parts: [box(0, 0, 0, 0.26, 0.2, 0.26)],
    weight: "medium",
    hands: 2,
    grips: [
      { pos: [-0.26, 0.08, 0], role: "main", axis: [1, 0, 0] },
      { pos: [0.26, 0.08, 0], role: "off", axis: [1, 0, 0] },
    ],
    strike: [[0, 0, 0.26]],
    reach: 0.6,
    swing: "smash",
    damage: { heft: 0.55, impulseMult: 1.3, effMass: 10, material: "wood", stagger: 1.8, stamina: 15, swingTime: 1.4, sound: "crate" },
    throwSpeed: 8,
    throwSpin: 2,
    throwDamageMult: 1.3,
    brk: {
      durability: 190,
      threshold: 46,
      pieces: [
        { id: "plank", offset: [-0.15, 0.1, 0] },
        { id: "plank", offset: [0.15, -0.1, 0] },
        { id: "plank", offset: [0, 0.0, 0.15] },
      ],
      fx: "wood",
    },
    mesh: "prop.crate",
    hindrance: 0.5,
    botValue: 0.5,
    tags: ["obstruct", "bursts"],
  },
  plank: {
    id: "plank",
    name: "Splintered Plank",
    mass: 0.6,
    parts: [box(0, 0, 0, 0.03, 0.28, 0.012)],
    weight: "light",
    hands: 1,
    grips: [{ pos: [0, -0.2, 0], role: "main" }],
    strike: [[0, 0.3, 0], [0, 0.1, 0]],
    reach: 0.6,
    swing: "club",
    damage: { heft: 0.3, impulseMult: 0.95, effMass: 3.4, material: "wood", stagger: 0.8, stamina: 5, swingTime: 0.75, sound: "stick" },
    throwSpeed: 14,
    throwSpin: 10,
    throwDamageMult: 0.8,
    brk: { durability: 60, threshold: 30, pieces: [], fx: "wood", dentOnly: true },
    mesh: "prop.plank",
    hindrance: 0.03,
    botValue: 0.35,
    tags: ["piece"],
  },
  monitor: {
    id: "monitor",
    name: "Office Monitor",
    mass: 5.2,
    parts: [box(0, 0.06, 0, 0.27, 0.17, 0.03), box(0, -0.15, 0.0, 0.04, 0.07, 0.04), box(0, -0.21, 0.05, 0.12, 0.012, 0.09)],
    weight: "medium",
    hands: 1,
    grips: [{ pos: [0, -0.1, -0.02], role: "main" }],
    strike: [[0, 0.06, 0.04], [0.25, 0.06, 0.0], [-0.25, 0.06, 0.0]],
    reach: 0.65,
    swing: "club",
    damage: { heft: 0.4, impulseMult: 1.2, effMass: 7.5, material: "electronics", stagger: 1.2, stamina: 10, swingTime: 1.2, sound: "monitor" },
    throwSpeed: 10,
    throwSpin: 4,
    throwDamageMult: 1.5,
    brk: { durability: 110, threshold: 40, pieces: [{ id: "plank", offset: [0, 0.1, 0] }], fx: "electronics" },
    mesh: "prop.monitor",
    hindrance: 0.35,
    botValue: 0.7,
    tags: ["dramatic", "breaks"],
  },
  microwave: {
    id: "microwave",
    name: "Microwave",
    mass: 12,
    parts: [box(0, 0, 0, 0.27, 0.16, 0.2)],
    weight: "medium",
    hands: 2,
    grips: [
      { pos: [-0.27, 0, 0], role: "main", axis: [1, 0, 0] },
      { pos: [0.27, 0, 0], role: "off", axis: [1, 0, 0] },
    ],
    strike: [[0, 0, 0.2]],
    reach: 0.55,
    swing: "smash",
    damage: { heft: 0.75, impulseMult: 1.6, effMass: 14, material: "metal", stagger: 2.0, stamina: 19, swingTime: 1.6, sound: "monitor" },
    throwSpeed: 7,
    throwSpin: 1.5,
    throwDamageMult: 1.6,
    brk: { durability: 260, threshold: 70, pieces: [], fx: "electronics", dentOnly: true },
    mesh: "prop.microwave",
    hindrance: 0.65,
    botValue: 0.5,
    tags: ["heavy"],
  },
  limb: {
    id: "limb",
    name: "Detached Limb",
    mass: 4.0,
    parts: [cap(0.3, -0.3, 0.06)],
    weight: "light",
    hands: 1,
    grips: [{ pos: [0, 0.2, 0], role: "main" }],
    strike: [[0, -0.35, 0], [0, 0, 0]],
    reach: 0.7,
    swing: "club",
    damage: { heft: 0.3, impulseMult: 0.8, effMass: 3.8, material: "flesh", stagger: 0.7, stamina: 6, swingTime: 0.9, sound: "limb" },
    throwSpeed: 12,
    throwSpin: 8,
    throwDamageMult: 0.8,
    brk: { durability: 9999, threshold: 9999, pieces: [], fx: "none", dentOnly: true },
    mesh: "prop.limb",
    hindrance: 0.1,
    botValue: 0.2,
    tags: ["absurd", "limb"],
  },
};


// ---- Furniture and fixtures (heavier, breakable in stages) ----
const FURN: Record<string, PropDef> = {
  tableTop: {
    id: "tableTop", name: "Table Top", mass: 9, parts: [box(0, 0, 0, 0.55, 0.02, 0.28)], weight: "medium", hands: 2,
    grips: [{ pos: [-0.5, 0, 0], role: "main", axis: [1, 0, 0] }, { pos: [0.5, 0, 0], role: "off", axis: [1, 0, 0] }],
    strike: [[0.55, 0, 0], [-0.55, 0, 0]], reach: 0.9, swing: "shield",
    damage: { heft: 0.5, impulseMult: 1.2, effMass: 11, material: "wood", stagger: 1.7, stamina: 14, swingTime: 1.4, sound: "crate" },
    throwSpeed: 8, throwSpin: 3, throwDamageMult: 1.1, guard: { radius: 0.5, strength: 0.7, coverageForward: 0.2 },
    brk: { durability: 400, threshold: 90, pieces: [], fx: "wood", dentOnly: true }, mesh: "prop.tableTop", hindrance: 0.5, botValue: 0.4, tags: ["piece", "slab"],
  },
  tableLeg: {
    id: "tableLeg", name: "Table Leg", mass: 1.4, parts: [cap(0.3, -0.3, 0.03)], weight: "light", hands: 1, grips: [{ pos: [0, 0.2, 0], role: "main" }],
    strike: [[0, -0.36, 0], [0, 0, 0]], reach: 0.7, swing: "club",
    damage: { heft: 0.45, impulseMult: 1.2, effMass: 5, material: "metal", stagger: 1.0, stamina: 7, swingTime: 0.9, sound: "stick" },
    throwSpeed: 13, throwSpin: 9, throwDamageMult: 0.9, brk: { durability: 600, threshold: 110, pieces: [], fx: "none", dentOnly: true },
    mesh: "prop.tableLeg", hindrance: 0.05, botValue: 0.55, tags: ["piece", "weapon"],
  },
  table: {
    id: "table", name: "Break Room Table", mass: 26, parts: [box(0, 0.35, 0, 0.6, 0.02, 0.3), box(-0.52, -0.02, -0.24, 0.025, 0.35, 0.025), box(0.52, -0.02, -0.24, 0.025, 0.35, 0.025), box(-0.52, -0.02, 0.24, 0.025, 0.35, 0.025), box(0.52, -0.02, 0.24, 0.025, 0.35, 0.025)],
    weight: "heavy", hands: 2, grips: [{ pos: [-0.6, 0.35, 0], role: "main", axis: [1, 0, 0] }, { pos: [0.6, 0.35, 0], role: "off", axis: [1, 0, 0] }],
    strike: [[0.6, 0.35, 0]], reach: 0.8, swing: "none",
    damage: { heft: 0.7, impulseMult: 1.5, effMass: 26, material: "wood", stagger: 2.0, stamina: 20, swingTime: 2, sound: "crate" },
    throwSpeed: 4, throwSpin: 0.5, throwDamageMult: 1.3,
    brk: { durability: 520, threshold: 130, pieces: [{ id: "tableTop", offset: [0, 0.35, 0] }, { id: "tableLeg", offset: [-0.52, -0.02, -0.24] }, { id: "tableLeg", offset: [0.52, -0.02, -0.24] }, { id: "tableLeg", offset: [-0.52, -0.02, 0.24] }, { id: "tableLeg", offset: [0.52, -0.02, 0.24] }], fx: "wood" },
    mesh: "prop.table", hindrance: 0.9, botValue: 0.2, tags: ["furniture", "collapses", "drag"],
  },
  desk: {
    id: "desk", name: "Supervisor's Desk", mass: 44, parts: [box(0, 0.35, 0, 0.85, 0.03, 0.4), box(-0.7, -0.02, 0, 0.12, 0.34, 0.36), box(0.7, -0.02, 0, 0.12, 0.34, 0.36)],
    weight: "heavy", hands: 2, grips: [{ pos: [-0.85, 0.35, 0], role: "main" }, { pos: [0.85, 0.35, 0], role: "off" }],
    strike: [[0.85, 0.35, 0]], reach: 1, swing: "none",
    damage: { heft: 0.8, impulseMult: 1.6, effMass: 44, material: "wood", stagger: 2, stamina: 24, swingTime: 2, sound: "crate" },
    throwSpeed: 3, throwSpin: 0.3, throwDamageMult: 1.4,
    brk: { durability: 900, threshold: 200, pieces: [{ id: "tableTop", offset: [0, 0.35, 0] }, { id: "crate", offset: [-0.7, -0.02, 0] }, { id: "crate", offset: [0.7, -0.02, 0] }], fx: "wood" },
    mesh: "prop.desk", hindrance: 1.0, botValue: 0.15, tags: ["furniture", "heavy", "drag"],
  },
  vendingMachine: {
    id: "vendingMachine", name: "Vending Machine", mass: 230, parts: [box(0, 0, 0, 0.45, 0.9, 0.4)], weight: "fixture", hands: 2,
    grips: [], strike: [], reach: 0, swing: "none",
    damage: { heft: 1, impulseMult: 2.5, effMass: 230, material: "metal", stagger: 3, stamina: 0, swingTime: 3, sound: "vending" },
    throwSpeed: 0, throwSpin: 0, throwDamageMult: 2,
    brk: { durability: 4000, threshold: 600, pieces: [], fx: "glass", dentOnly: true }, mesh: "prop.vendingMachine", hindrance: 1, botValue: 0.1, tags: ["fixture", "topple"],
  },
  waterCooler: {
    id: "waterCooler", name: "Water Cooler", mass: 17, parts: [box(0, -0.2, 0, 0.16, 0.45, 0.16), { kind: "cylinder", a: [0, 0.3, 0], b: [0, 0.62, 0], r: 0.14 }],
    weight: "medium", hands: 2, grips: [{ pos: [-0.16, 0.0, 0], role: "main" }, { pos: [0.16, 0.0, 0], role: "off" }],
    strike: [[0, 0.5, 0]], reach: 0.6, swing: "smash",
    damage: { heft: 0.7, impulseMult: 1.5, effMass: 17, material: "plastic", stagger: 2, stamina: 20, swingTime: 1.7, sound: "extinguisher" },
    throwSpeed: 6, throwSpin: 1, throwDamageMult: 1.4,
    brk: { durability: 220, threshold: 60, pieces: [{ id: "crate", offset: [0, -0.2, 0] }], fx: "plastic" }, mesh: "prop.waterCooler", hindrance: 0.7, botValue: 0.35, tags: ["splash"],
  },
};
Object.assign(PROPS, FURN);

export const SPAWNABLE_PROP_IDS = Object.keys(PROPS).filter((k) => !["limb", "chairLeg", "chairSeat", "chairBack", "plank"].includes(k));

import type { Personality } from "../config.js";

export interface FighterPalette {
  skin: string;
  hair: string;
  shirt: string;
  shirt2: string;
  pants: string;
  shoes: string;
  accent: string;
  eyes: string;
}

export interface FighterDef {
  id: string;
  name: string;
  nickname: string;
  tagline: string;
  build: "bruiser" | "scrapper";
  height: number;
  girth: number;
  mass: number;
  /** m/s */
  walkSpeed: number;
  runSpeed: number;
  accel: number;
  turnRate: number;
  /** Multipliers. */
  damage: number;
  resist: number;
  stamina: number;
  /** Animation speed multipliers (lower = slower, heavier). */
  lightTempo: number;
  heavyTempo: number;
  grip: number;
  stance: "heavy" | "bouncy";
  taunt: "flex" | "flair";
  palette: FighterPalette;
  defaultPersonality: Personality;
  /** Announcer / grunt voice pitch hint for synthesised vocals. */
  voicePitch: number;
}

export const FIGHTERS: Record<string, FighterDef> = {
  gary: {
    id: "gary",
    name: "Gary Dobbs",
    nickname: "The Filing Cabinet",
    tagline: "Eighteen years in receiving. Zero days of regret.",
    build: "bruiser",
    height: 1.04,
    girth: 1.22,
    mass: 108,
    walkSpeed: 2.3,
    runSpeed: 3.7,
    accel: 10,
    turnRate: 8,
    damage: 1.18,
    resist: 1.25,
    stamina: 1.1,
    lightTempo: 0.9,
    heavyTempo: 0.88,
    grip: 1.2,
    stance: "heavy",
    taunt: "flex",
    palette: { skin: "#d9a07a", hair: "#3a2a20", shirt: "#c8532b", shirt2: "#8d3a1d", pants: "#2f3a4d", shoes: "#2a2320", accent: "#f2c230", eyes: "#3b5f8a" },
    defaultPersonality: "bruiser",
    voicePitch: 0.78,
  },
  ricky: {
    id: "ricky",
    name: "Ricky Vale",
    nickname: "No Refunds",
    tagline: "Quick hands, quicker excuses, a lanyard full of regrets.",
    build: "scrapper",
    height: 0.96,
    girth: 0.9,
    mass: 70,
    walkSpeed: 2.7,
    runSpeed: 4.6,
    accel: 15,
    turnRate: 12,
    damage: 0.92,
    resist: 0.85,
    stamina: 1.0,
    lightTempo: 1.15,
    heavyTempo: 1.0,
    grip: 0.95,
    stance: "bouncy",
    taunt: "flair",
    palette: { skin: "#f0c8a0", hair: "#d86a1a", shirt: "#2e8f8a", shirt2: "#f3f0e6", pants: "#5b4a6e", shoes: "#e9e4d6", accent: "#ff4d8d", eyes: "#4a7d3a" },
    defaultPersonality: "showoff",
    voicePitch: 1.18,
  },
};
export const FIGHTER_LIST = Object.values(FIGHTERS);

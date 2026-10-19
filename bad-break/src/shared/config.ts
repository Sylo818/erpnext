/** Global tunables. Everything gameplay-affecting that designers may tweak lives here or in src/shared/data. */
export const SIM = {
  hz: 60,
  dt: 1 / 60,
  /** Max fixed steps per rendered frame; excess time is dropped (never spirals). */
  maxCatchUpSteps: 5,
  gravity: -9.81,
  snapshotHz: 20,
  /** Linear/angular velocity clamps handed to the physics engine. */
  maxLinearSpeed: 40,
  maxAngularSpeed: 40,
} as const;

export interface MatchSettings {
  roundsToWin: number;
  roundSeconds: number;
  /** Seconds a blacked-out fighter stays limp before recovering (tunable). */
  blackoutSeconds: number;
  /** A knockout lasts until this many seconds pass without recovering = round ends. */
  knockoutCountSeconds: number;
  /** Delay before the next round after a result. */
  intermissionSeconds: number;
}
export const DEFAULT_MATCH: MatchSettings = {
  roundsToWin: 2,
  roundSeconds: 120,
  blackoutSeconds: 3.2,
  knockoutCountSeconds: 5,
  intermissionSeconds: 3.5,
};

export type Difficulty = "rookie" | "regular" | "veteran" | "nightmare";
export type Personality = "bruiser" | "scavenger" | "showoff";

export interface CosmeticSettings {
  masterVolume: number;
  announcerVolume: number;
  profanity: boolean;
  /** 0 = none, 1 = cartoon default, 2 = exaggerated. Cosmetic only. */
  bloodIntensity: number;
  cameraShake: number;
  flashIntensity: number;
  quality: "low" | "medium" | "high";
  resolutionScale: number;
  debugOverlay: boolean;
}
export const DEFAULT_COSMETICS: CosmeticSettings = {
  masterVolume: 0.8,
  announcerVolume: 0.9,
  profanity: true,
  bloodIntensity: 1,
  cameraShake: 1,
  flashIntensity: 1,
  quality: "medium",
  resolutionScale: 1,
  debugOverlay: false,
};

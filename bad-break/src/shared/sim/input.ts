/** Control intention submitted per fixed tick (locally or over the network). World-space, camera independent. */
export const BTN = {
  LIGHT: 1 << 0,
  HEAVY: 1 << 1,
  KICK: 1 << 2,
  GUARD: 1 << 3,
  DODGE: 1 << 4,
  INTERACT: 1 << 5,
  THROW: 1 << 6,
  TAUNT: 1 << 7,
  INFO: 1 << 8,
} as const;
export type BtnName = keyof typeof BTN;

export interface Intent {
  seq: number;
  /** Desired movement direction in world XZ, length 0..1 (already camera relative). */
  moveX: number;
  moveZ: number;
  /** Desired facing / aim direction as a world yaw (rad). Throws use it. */
  aimYaw: number;
  buttons: number;
  /** Attack emphasis: -1 low, 0 middle, +1 high. */
  height: -1 | 0 | 1;
}
export function emptyIntent(): Intent {
  return { seq: 0, moveX: 0, moveZ: 0, aimYaw: 0, buttons: 0, height: 0 };
}
export function copyIntent(from: Intent, to: Intent = emptyIntent()): Intent {
  to.seq = from.seq;
  to.moveX = from.moveX;
  to.moveZ = from.moveZ;
  to.aimYaw = from.aimYaw;
  to.buttons = from.buttons;
  to.height = from.height;
  return to;
}
export function quantizeIntent(i: Intent): Intent {
  // Network quantisation: keeps authoritative and predicted inputs identical.
  return {
    seq: i.seq,
    moveX: Math.round(i.moveX * 100) / 100,
    moveZ: Math.round(i.moveZ * 100) / 100,
    aimYaw: Math.round(i.aimYaw * 1000) / 1000,
    buttons: i.buttons,
    height: i.height,
  };
}

/**
 * Collision groups. Havok filter: two shapes collide when
 *   (A.membership & B.collideMask) != 0  AND  (B.membership & A.collideMask) != 0.
 *
 * Fighters never self-collide (each fighter has its own ragdoll bit). The movement capsule of
 * fighter A is seen only by fighter B's controller, never by ragdoll bodies, so fists reach torsos.
 */
export const G = {
  STATIC: 1 << 0, // fixed architecture, floor, intact walls
  PROP: 1 << 1, // movable gameplay props
  DEBRIS: 1 << 2, // physical wall/furniture chunks
  RAG_A: 1 << 3, // fighter 0 ragdoll bodies
  RAG_B: 1 << 4, // fighter 1 ragdoll bodies
  CAP_A: 1 << 5, // fighter 0 movement capsule
  CAP_B: 1 << 6, // fighter 1 movement capsule
  LIMB: 1 << 7, // detached limbs
  BREAKABLE: 1 << 8, // intact breakable wall patches (also solid for fighters)
  SWEEP_ONLY: 1 << 9, // query-only: nothing physically collides with this
} as const;

export function ragGroup(slot: number): number {
  return slot === 0 ? G.RAG_A : G.RAG_B;
}
export function capGroup(slot: number): number {
  return slot === 0 ? G.CAP_A : G.CAP_B;
}
export function otherSlot(slot: number): number {
  return slot === 0 ? 1 : 0;
}

/** Ragdoll bodies: collide with world, props, debris, limbs, breakables and the OTHER fighter's ragdoll. */
export function ragCollideMask(slot: number): number {
  return G.STATIC | G.PROP | G.DEBRIS | G.LIMB | G.BREAKABLE | ragGroup(otherSlot(slot));
}
/** Movement capsule queries: world, props, breakables, and the OTHER fighter's capsule. */
export function capCollideMask(slot: number): number {
  return G.STATIC | G.PROP | G.BREAKABLE | capGroup(otherSlot(slot));
}
export const PROP_COLLIDE_MASK = G.STATIC | G.PROP | G.DEBRIS | G.RAG_A | G.RAG_B | G.CAP_A | G.CAP_B | G.LIMB | G.BREAKABLE;
export const DEBRIS_COLLIDE_MASK = G.STATIC | G.PROP | G.DEBRIS | G.RAG_A | G.RAG_B | G.LIMB;
export const STATIC_COLLIDE_MASK = 0xffff;
/** Raycast mask for line-of-sight / blocking geometry. */
export const BLOCKER_MASK = G.STATIC | G.BREAKABLE;
/** Masks used by hit sweeps against a fighter. */
export function ragdollOnly(slot: number): number {
  return ragGroup(slot);
}

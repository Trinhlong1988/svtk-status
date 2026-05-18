/**
 * STABLE ORDER COMPARATOR — replay-safe entity iteration (CMD1 FIX #2).
 *
 * REJECT reliance on Map insertion order alone — future refactor / migration /
 * restore path may recreate insertion order differently.
 *
 * REQUIRED tie-break (per CMD1 audit):
 *   1. turn_created    ASC  (earlier first)
 *   2. spawn_sequence  ASC  (deterministic spawn order)
 *   3. entity_id       LEX  (string compare)
 *
 * Caller (registry / scheduler / sweeper) MUST use `stableEntityOrderComparator`
 * for ANY authoritative iteration that affects:
 *   - replay record output
 *   - cleanup sweep order
 *   - target selection ordering
 *   - threat resolver iteration
 *
 * Map insertion order STILL OK for non-authoritative diagnostics.
 */

/**
 * Stable order key (CMD1 FIX #6 spawn_sequence_id integration).
 *
 * Every spawned entity MUST carry these 3 fields for stable ordering.
 */
export interface StableOrderKey {
  /** Turn at which entity was created. */
  turnCreated: number;
  /** Monotonic sequence id per shard/encounter (CMD1 FIX #6). */
  spawnSequence: number;
  /** Entity unique id (lex tiebreak). */
  entityId: string;
}

/**
 * Comparator function: returns negative if a < b, positive if a > b, 0 if equal.
 *
 * Order: turnCreated ASC → spawnSequence ASC → entityId LEX.
 */
export function stableEntityOrderComparator(a: StableOrderKey, b: StableOrderKey): number {
  if (a.turnCreated !== b.turnCreated) return a.turnCreated - b.turnCreated;
  if (a.spawnSequence !== b.spawnSequence) return a.spawnSequence - b.spawnSequence;
  if (a.entityId < b.entityId) return -1;
  if (a.entityId > b.entityId) return 1;
  return 0;
}

/**
 * Helper — sort array of stable-order-key carriers in place.
 */
export function sortStableOrder<T extends StableOrderKey>(items: T[]): T[] {
  return items.sort(stableEntityOrderComparator);
}

/**
 * Build stable key from individual fields.
 */
export function makeStableKey(
  entityId: string,
  turnCreated: number,
  spawnSequence: number,
): StableOrderKey {
  return { entityId, turnCreated, spawnSequence };
}

/**
 * Equality check (for dedup / cache invalidation).
 */
export function stableKeyEquals(a: StableOrderKey, b: StableOrderKey): boolean {
  return a.entityId === b.entityId &&
    a.turnCreated === b.turnCreated &&
    a.spawnSequence === b.spawnSequence;
}

/**
 * Globally-monotonic spawn sequence counter — pure functional (caller owns state).
 */
export interface SpawnSequenceCounter {
  next: number;
}

export function createSpawnSequenceCounter(start: number = 0): SpawnSequenceCounter {
  return { next: start };
}

export function nextSpawnSequence(counter: SpawnSequenceCounter): number {
  const seq = counter.next;
  counter.next += 1;
  return seq;
}

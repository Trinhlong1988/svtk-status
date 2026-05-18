/**
 * RNG SUBSTREAM ARCHITECTURE — Phase 1 hardening FIX #1.
 *
 * Single sequential RNG (current pipeline) is replay fragile: nếu future code
 * insert thêm roll vào middle (vd evade roll, passive proc, summon proc, reflect,
 * loot, boss AI) thì existing replay sequence mismatch.
 *
 * Solution: 5 named substreams independent + deterministic from parent encounter seed.
 * Caller pick substream theo concern (rng_hit / rng_crit / rng_proc / rng_ai / rng_loot).
 *
 * Backward compatible:
 *   - Existing pipeline vẫn pass `RNG` (single function) qua CombatContext.rng
 *   - Module 1 KHÔNG migrate ngay — Module 2-6 sẽ adopt RNGStream khi cần
 *
 * Deterministic guarantee:
 *   - Same encounter seed → same substream seeds (composer formula stable)
 *   - Substream consumption order independent — rng_loot không ảnh hưởng rng_hit sequence
 *   - Replay-safe: substream identity là string key, KHÔNG ordinal index
 */
import { createRNG, type RNG } from './rng.js';

/**
 * Named substream keys — adding new key KHÔNG shift existing roll sequence
 * (substream identity là string, KHÔNG ordinal index).
 *
 * - rng_hit:        accuracy/dodge roll
 * - rng_crit:       crit roll
 * - rng_proc:       passive/effect proc roll (skill chain trigger)
 * - rng_ai:         boss AI decision roll
 * - rng_loot:       drop table roll
 * - rng_jitter:     damage jitter ±BP
 * - rng_status:     STATUS pipeline roll (boss CC resist, future status proc)
 * - rng_skill_proc: SKILL pipeline proc (Phase 3 — skill-tied chance proc)
 * - rng_combo:     combo trigger roll (Phase 3 — combo proc selection)
 */
export type RNGSubstreamKey =
  | 'rng_hit'
  | 'rng_crit'
  | 'rng_proc'
  | 'rng_ai'
  | 'rng_loot'
  | 'rng_jitter'
  | 'rng_status'
  | 'rng_skill_proc'
  | 'rng_combo'
  | 'rng_ai_threat'      // Phase 4 — boss target probabilistic selection
  | 'rng_spawn';         // CMD1 FIX #1 — spawn picks SEPARATE from rng_loot (anti-replay-desync)

export interface RNGStream {
  /** Get (or lazy create) substream by name. Same key → same RNG instance per stream. */
  sub(key: RNGSubstreamKey): RNG;
  /** Root encounter seed — for serialize / replay restore. */
  readonly rootSeed: string;
}

/**
 * Compose substream seed deterministically from root + key.
 * Stable across runs / platforms — pure string concat.
 */
export function makeSubstreamSeed(rootSeed: string, key: RNGSubstreamKey): string {
  return `${rootSeed}::${key}`;
}

/**
 * Default implementation — lazy substream creation, cached per-encounter.
 *
 * Usage:
 *   const stream = createRNGStream(makeEncounterSeed('enc_001', 5, 0));
 *   const hitRoll = stream.sub('rng_hit')();
 *   const critRoll = stream.sub('rng_crit')();
 *   const lootRoll = stream.sub('rng_loot')();   // independent — không ảnh hưởng hit/crit
 */
export function createRNGStream(rootSeed: string): RNGStream {
  const cache = new Map<RNGSubstreamKey, RNG>();
  return {
    rootSeed,
    sub(key: RNGSubstreamKey): RNG {
      let rng = cache.get(key);
      if (!rng) {
        rng = createRNG(makeSubstreamSeed(rootSeed, key));
        cache.set(key, rng);
      }
      return rng;
    },
  };
}

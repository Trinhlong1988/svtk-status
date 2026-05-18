/**
 * SPATIAL + MECHANIC SCHEMA VERSION — replay-safe semantic lock (Phase 6 FP FIX #3).
 *
 * PROBLEM (CMD1.docx Phase 6 Final Perfect Pass):
 *   Future balance patch may break replay:
 *     - cone width change
 *     - pull distance change
 *     - collision logic change
 *     - AoE timing change
 *
 *   OLD replay must still replay correctly.
 *
 * SOLUTION: 2 sibling versions + signature hash.
 *
 *   SPATIAL_SCHEMA_VERSION  = bump when cone / pull / knockback / collision /
 *                             placement semantics change.
 *   MECHANIC_SCHEMA_VERSION = bump when mechanic kind enum / trigger semantics
 *                             / telegraph timing / dispatch order changes.
 *
 * Each version paired with `*_SIGNATURE_HASH` (sha256 short) — drift detection
 * when constants change WITHOUT a version bump (catches stealth balance tweaks).
 *
 * Recording embeds:
 *   replayFrame.payload.spatialSchema:  { version, hash }
 *   replayFrame.payload.mechanicSchema: { version, hash }
 *
 * Replay verify:
 *   - version mismatch → reject replay (incompatible)
 *   - hash drift      → warn (constants tuned without version bump)
 *
 * Caller embeds via `replay_event_stream` `appendEvent(..., 'custom', { schema })`.
 */
import { createHash } from 'node:crypto';
import { NpcConstants } from './npc_constants.js';

// ─────────────────────────────────────────────────────────
// SPATIAL SCHEMA — cone / pull / knockback / collision / placement
// ─────────────────────────────────────────────────────────

/**
 * Bump when:
 *   - cone half-width formula changes
 *   - pull / knockback step direction changes (king move semantics)
 *   - collision check rules change
 *   - placeRaidSafe scan order changes
 *   - SpatialLayerState shape changes
 *   - distance map invalidation semantics change
 *   - AoE shape semantics change
 *
 * History:
 *   - 1: Phase 6 baseline (cone linear half-width, king-move forced movement,
 *        spiral raid-safe placement, version-bumped distance cache)
 */
export const SPATIAL_SCHEMA_VERSION = 1 as const;

export function computeSpatialSignatureHash(): string {
  const sig = {
    version: SPATIAL_SCHEMA_VERSION,
    // king-move direction count
    directions: ['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW'],
    // cone half-width formula constants
    coneFormula: 'half_width = floor((forward * halfWidthAtMax) / max(1, range))',
    // pull / knockback semantics
    forcedMovement: {
      stepX: 'sign(dx) * direction',
      stepY: 'sign(dy) * direction',
      clamp: ['bounds', 'collision', 'none'],
    },
    // raid-safe placement
    placeOrder: 'spiral_outward_ring_by_chebyshev',
    // distance map cache invalidation policy
    versionedDistanceMap: true,
    // chebyshev distance metric — KING MOVE
    distanceMetric: 'chebyshev',
    // grid bounds origin
    boundOrigin: 'top_left',
  };
  return createHash('sha256').update(JSON.stringify(sig)).digest('hex').slice(0, 16);
}

export const SPATIAL_SIGNATURE_HASH = computeSpatialSignatureHash();

// ─────────────────────────────────────────────────────────
// MECHANIC SCHEMA — boss mechanic dispatch / scheduler / timeline
// ─────────────────────────────────────────────────────────

/**
 * Bump when:
 *   - MechanicDef.kind enum changes
 *   - MechanicTriggerKind enum changes
 *   - Trigger evaluation semantics change (vd hp_threshold_bp comparator change)
 *   - Scheduler drain order changes
 *   - Boss timeline LOCK ORDER changes (boss_timeline_resolver.ts)
 *   - PendingMechanic shape changes
 *
 * History:
 *   - 1: Phase 6 baseline (10 mechanic kinds, 5 trigger kinds, 7-phase boss timeline)
 */
export const MECHANIC_SCHEMA_VERSION = 1 as const;

export function computeMechanicSignatureHash(): string {
  const sig = {
    version: MECHANIC_SCHEMA_VERSION,
    mechanicKinds: [
      'spatial_aoe', 'spatial_line', 'spatial_cone', 'forced_movement',
      'wipe_check', 'aggro_reset', 'summon', 'cinematic_lock',
      'enrage_buff', 'custom',
    ],
    triggerKinds: [
      'turn_interval', 'turn_one_shot', 'hp_threshold_bp',
      'phase_enter', 'rng_chance_bp',
    ],
    timelinePhases: [
      'PHASE_TRANSITION', 'CINEMATIC_LOCK', 'AGGRO_RESET',
      'DELAYED_AOE', 'WIPE_CHECK', 'SUMMON', 'CLEANUP',
    ],
    schedulerDrainOrder: 'resolveTurn_asc_seq_asc_id_lex',
    behaviorPolicy: '70_20_10_BP',
    leashDistanceConst: NpcConstants.LEASH_CHASE_DISTANCE,
    sessionMaxDuration: NpcConstants.COMBAT_SESSION_MAX_DURATION_TURNS,
  };
  return createHash('sha256').update(JSON.stringify(sig)).digest('hex').slice(0, 16);
}

export const MECHANIC_SIGNATURE_HASH = computeMechanicSignatureHash();

// ─────────────────────────────────────────────────────────
// Compatibility check
// ─────────────────────────────────────────────────────────

export interface SchemaCompatibility {
  compatible: boolean;
  reason?:
    | 'spatial_version_mismatch'
    | 'spatial_signature_drift'
    | 'mechanic_version_mismatch'
    | 'mechanic_signature_drift';
  spatial: { recordedVersion: number; currentVersion: number; recordedHash: string; currentHash: string };
  mechanic: { recordedVersion: number; currentVersion: number; recordedHash: string; currentHash: string };
}

export function checkSchemaCompatibility(
  spatialRec: { version: number; hash: string },
  mechanicRec: { version: number; hash: string },
): SchemaCompatibility {
  const spatial = {
    recordedVersion: spatialRec.version,
    currentVersion: SPATIAL_SCHEMA_VERSION,
    recordedHash: spatialRec.hash,
    currentHash: SPATIAL_SIGNATURE_HASH,
  };
  const mechanic = {
    recordedVersion: mechanicRec.version,
    currentVersion: MECHANIC_SCHEMA_VERSION,
    recordedHash: mechanicRec.hash,
    currentHash: MECHANIC_SIGNATURE_HASH,
  };

  if (spatialRec.version !== SPATIAL_SCHEMA_VERSION) {
    return { compatible: false, reason: 'spatial_version_mismatch', spatial, mechanic };
  }
  if (mechanicRec.version !== MECHANIC_SCHEMA_VERSION) {
    return { compatible: false, reason: 'mechanic_version_mismatch', spatial, mechanic };
  }
  if (spatialRec.hash !== SPATIAL_SIGNATURE_HASH) {
    return { compatible: false, reason: 'spatial_signature_drift', spatial, mechanic };
  }
  if (mechanicRec.hash !== MECHANIC_SIGNATURE_HASH) {
    return { compatible: false, reason: 'mechanic_signature_drift', spatial, mechanic };
  }
  return { compatible: true, spatial, mechanic };
}

/** Emit-friendly bundle for replay frame payload. */
export interface SchemaStamp {
  spatial: { version: number; hash: string };
  mechanic: { version: number; hash: string };
}

export function currentSchemaStamp(): SchemaStamp {
  return {
    spatial: { version: SPATIAL_SCHEMA_VERSION, hash: SPATIAL_SIGNATURE_HASH },
    mechanic: { version: MECHANIC_SCHEMA_VERSION, hash: MECHANIC_SIGNATURE_HASH },
  };
}

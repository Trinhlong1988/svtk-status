/**
 * STATUS_SCHEMA_VERSION — Phase 2 hardening FIX #10.
 *
 * Status pipeline có 4 semantic axis có thể drift independently từ formula version:
 *   - DR semantic       (DR_LEVELS_<group>_BP shape, reset window)
 *   - Stack semantic    (5 behaviors enum, stack cap default)
 *   - Overwrite semantic (transactional vs naive — FIX #6)
 *   - Cleanse semantic  (priorityOrder, immunity bypass — FIX #4)
 *
 * Bump version khi:
 *   - Add/remove StackBehavior enum value
 *   - Add/remove DRGroup enum value
 *   - Change StatusEffectSchema shape
 *   - Change overwrite ordering (transactional vs flicker)
 *   - Change cleanse default sort order
 *
 * Recording embed STATUS_SCHEMA_VERSION + STATUS_SIGNATURE_HASH.
 * Replay verify both → drift_warning if hash differs even though version same
 * (catches data tuning change without code bump).
 */
import { createHash } from 'node:crypto';
import { StatusConstants } from './status_constants.js';

/**
 * Bumped khi semantic break. v1 = Phase 2 baseline.
 * History:
 *   - 1: initial Phase 2 (11 effect handler, 5 stack, 4 DR groups, naive overwrite)
 *   - 2: Phase 2 hardening (transactional overwrite, cleanse priorityOrder, runtime guards)
 */
export const STATUS_SCHEMA_VERSION = 2;

/**
 * Drift detect — hash all StatusConstants + key enum lists.
 * Mismatch → tuning change without version bump → emit drift_warning.
 */
export function computeStatusSignatureHash(): string {
  const sig = {
    version: STATUS_SCHEMA_VERSION,
    drLevels: {
      hard_cc: StatusConstants.DR_LEVELS_HARD_CC_BP,
      soft_cc: StatusConstants.DR_LEVELS_SOFT_CC_BP,
      dot:     StatusConstants.DR_LEVELS_DOT_BP,
      hot:     StatusConstants.DR_LEVELS_HOT_BP,
    },
    drReset: {
      hard_cc: StatusConstants.DR_RESET_TURNS_HARD_CC,
      soft_cc: StatusConstants.DR_RESET_TURNS_SOFT_CC,
      dot:     StatusConstants.DR_RESET_TURNS_DOT,
      hot:     StatusConstants.DR_RESET_TURNS_HOT,
    },
    stackCap: {
      dot:     StatusConstants.STACK_CAP_DOT,
      hot:     StatusConstants.STACK_CAP_HOT,
      debuff:  StatusConstants.STACK_CAP_DEBUFF_STAT,
      buff:    StatusConstants.STACK_CAP_BUFF_STAT,
      def:     StatusConstants.STACK_CAP_DEFAULT,
    },
    boss: {
      hardcc:  StatusConstants.BOSS_HARDCC_RESIST_BP,
      softcc:  StatusConstants.BOSS_SOFTCC_RESIST_BP,
    },
    pvp: StatusConstants.PVP_DR_SCALE_BP,
    maxChain: StatusConstants.MAX_EFFECT_CHAIN_DEPTH,
    behaviors: ['additive', 'refresh', 'strongest', 'capped', 'unique'] as const,
    drGroups:  ['hard_cc', 'soft_cc', 'dot', 'hot', 'none'] as const,
    categories: ['DOT', 'HOT', 'HARD_CC', 'SOFT_CC', 'DEFENSIVE', 'THREAT_CONTROL', 'SUPPORT'] as const,
  };
  return createHash('sha256').update(JSON.stringify(sig)).digest('hex').slice(0, 16);
}

/** Cached. */
export const STATUS_SIGNATURE_HASH = computeStatusSignatureHash();

export interface StatusSchemaCompatibility {
  compatible: boolean;
  reason?: 'status_schema_mismatch' | 'status_signature_drift';
  recording: { version: number; hash: string };
  current: { version: number; hash: string };
}

export function checkStatusSchemaCompatibility(
  recordedVersion: number,
  recordedHash: string,
): StatusSchemaCompatibility {
  const current = { version: STATUS_SCHEMA_VERSION, hash: STATUS_SIGNATURE_HASH };
  const recording = { version: recordedVersion, hash: recordedHash };
  if (recordedVersion !== STATUS_SCHEMA_VERSION) {
    return { compatible: false, reason: 'status_schema_mismatch', recording, current };
  }
  if (recordedHash !== STATUS_SIGNATURE_HASH) {
    return { compatible: false, reason: 'status_signature_drift', recording, current };
  }
  return { compatible: true, recording, current };
}

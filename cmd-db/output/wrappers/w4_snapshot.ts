/**
 * R44 W4 — R68 snapshot binding
 *
 * Persists a deterministic SHA-256 state-checksum tied to a transaction.
 * Uses CMD1's `checksumFrame` from cmd-engine/output/replay/state_checksum.ts
 * (no parallel impl — single source of truth for R68 hash).
 *
 * Foundation v2.8.0 R68: every server-authoritative state mutation should
 * stamp the resulting frame so cmd-qa-core can replay-verify divergence.
 *
 * Cross-CMD evidence: CMD1 ship commit dd3c7e3 (cmd-engine R67+R68 gap fill).
 */
import type { PoolClient } from 'pg';
import { checksumFrame, type Sha256Hex } from '../../../cmd-engine/output/replay/state_checksum.js';
import type { ReplayFrame } from '../../../cmd-engine/output/legacy/replay_frame.js';

export interface SnapshotBinding {
  txn_id: string;
  frame_id: string;
  turn: number;
  checksum: Sha256Hex;
  bound_at: Date;
}

/**
 * Compute checksum of the given frame and persist binding into the
 * `transaction_log.target_state` JSONB (no separate table needed for v1 —
 * upgrade to dedicated `state_checksums` table when CMD QA-CORE wires up).
 *
 * Returns the binding for caller's audit trail.
 */
export async function bindSnapshotToTxn(
  client: PoolClient,
  txn_id: string,
  frame: ReplayFrame,
): Promise<SnapshotBinding> {
  const checksum = checksumFrame(frame);
  const binding: SnapshotBinding = {
    txn_id,
    frame_id: frame.frameId,
    turn: frame.turn,
    checksum,
    bound_at: new Date(),
  };

  // Merge checksum into transaction_log.target_state JSONB (idempotent re-bind
  // overwrites only the r68_* keys, preserving caller-set fields).
  const patch = JSON.stringify({
    r68_checksum: checksum,
    r68_frame_id: frame.frameId,
    r68_turn: frame.turn,
    r68_bound_at: binding.bound_at.toISOString(),
  });
  await client.query(
    `UPDATE transaction_log
       SET target_state = COALESCE(target_state, '{}'::jsonb) || $2::jsonb
     WHERE txn_id = $1`,
    [txn_id, patch],
  );

  return binding;
}

/**
 * Verify a stored binding matches a recomputed checksum (used by cmd-qa-core
 * during replay-divergence audits).
 */
export async function verifySnapshotBinding(
  client: PoolClient,
  txn_id: string,
  expected_frame: ReplayFrame,
): Promise<{ valid: boolean; stored?: Sha256Hex; computed: Sha256Hex }> {
  const computed = checksumFrame(expected_frame);
  const r = await client.query(
    `SELECT target_state ->> 'r68_checksum' AS stored FROM transaction_log WHERE txn_id = $1`,
    [txn_id],
  );
  const stored = r.rows[0]?.stored as string | undefined;
  return { valid: stored === computed, stored, computed };
}

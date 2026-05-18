/**
 * CROSS-SHARD PROGRESSION SYNC — Phase 14 §2.
 *
 * Canonical cross-shard progression synchronization layer.
 *
 * Wraps existing Phase 13 `progression_shard_export` primitives — NO new
 * architecture. Adds the operational entry-points for the live MMO scenarios:
 *
 *   1. Shard transfer verification — given an export bundle, prove it
 *      represents the same logical state as the snapshot it came from.
 *   2. Canonical progression export — produce a sync envelope that ANY
 *      shard can consume to reconstruct the canonical state.
 *   3. Deterministic shard parity — assert two bundles built from the same
 *      snapshot under different partition strategies still represent the
 *      same logical state (re-aggregate identity).
 *   4. Replay-safe shard migration — verify migrating from N shards to M
 *      shards preserves canonical state byte-for-byte after re-composition.
 *   5. Progression continuity validation — verify a freshly partitioned
 *      bundle reassembles into the source snapshot losslessly.
 *
 * Phase 14 §"STRICT LIMITS":
 *   - NO websocket/network/shard-networking runtime
 *   - Pure data-shape coordinator. Caller plugs transport.
 *
 * Determinism contract:
 *   - Same snapshot + same partitioner ⇒ byte-identical sync envelope ALWAYS.
 *   - Same logical state, ANY shard count ⇒ same re-composed checksum.
 */
import { z } from 'zod';
import {
  type CompositeWorldSnapshot,
  composeWorldSnapshot,
  checksumSnapshot,
  toCanonicalJson,
  type WorldStateSnapshotSource,
  type WorldEventInstanceSnapshot,
} from './world_state_snapshot_schema.js';
import type { FullProgressionSnapshot } from './progression_replay_runtime.js';
import {
  partitionSnapshot,
  verifyShardBundle,
  type ShardExportBundle,
  type ShardPartitionFn,
} from './progression_shard_export.js';
import type { GlobalTelemetryService } from './global_telemetry_service.js';

export const CROSS_SHARD_SYNC_SCHEMA_VERSION = 1;

// ───────────────────── schemas ─────────────────────
export const ShardSyncEnvelopeSchema = z.object({
  envelope_schema_version: z.number().int().positive(),
  /** Ordinal at which the source snapshot was captured. */
  ordinal: z.number().int().nonnegative(),
  /** FNV-1a checksum over canonical JSON of the source CompositeWorldSnapshot. */
  source_checksum: z.string().min(1),
  /** Shard bundle (canonical, traversal-stable). */
  bundle: z.unknown(), // typed at runtime
  /** FNV-1a checksum over canonical JSON of the bundle (defense-in-depth). */
  bundle_checksum: z.string().min(1),
  /**
   * BUG-V FIX (Phase 15 deep-review): envelope-level meta checksum covering
   * (envelope_schema_version | ordinal | source_checksum | bundle_checksum).
   *
   * Previous design left `source_checksum` unprotected at verify time — an
   * attacker could send a valid bundle with a forged source_checksum and pass
   * `verifyShardSync(ok=true)`, deferring divergence detection to apply time.
   * Per Phase 15 "0 persistence divergence tolerated" directive, this is now
   * caught at verify time via `envelope_checksum` re-derivation.
   */
  envelope_checksum: z.string().min(1),
});
export interface ShardSyncEnvelope {
  envelope_schema_version: number;
  ordinal: number;
  source_checksum: string;
  bundle: ShardExportBundle;
  bundle_checksum: string;
  envelope_checksum: string;
}

export interface ShardSyncVerifyResult {
  ok: boolean;
  reason?: string;
  /** Bundle-level integrity (per shard checksum + manifest consistency). */
  bundle_ok?: boolean;
  /** Bundle checksum recomputation matches the envelope-stored value. */
  bundle_checksum_ok?: boolean;
  /** Envelope-level integrity (envelope_checksum re-derived matches). */
  envelope_ok?: boolean;
}

export interface ShardSyncApplyResult {
  ok: boolean;
  /** Re-composed snapshot (from per-shard slices) when ok=true. */
  snapshot?: CompositeWorldSnapshot;
  /** Re-composed snapshot checksum — must equal envelope.source_checksum. */
  recomposed_checksum?: string;
  reason?: string;
}

export interface ShardMigrationParityResult {
  ok: boolean;
  /** Re-composed snapshot checksums from each side. */
  before_recomposed_checksum?: string;
  after_recomposed_checksum?: string;
  reason?: string;
}

export interface CrossShardSyncDeps {
  /** Optional telemetry sink — diagnostics published when set. */
  telemetry?: GlobalTelemetryService;
}

function fnv1a(s: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function computeEnvelopeChecksum(
  schema_version: number,
  ordinal: number,
  source_checksum: string,
  bundle_checksum: string,
): string {
  return fnv1a(`${schema_version}|${ordinal}|${source_checksum}|${bundle_checksum}`);
}

/**
 * Re-aggregate per-shard slices back into a CompositeWorldSnapshot.
 *
 * Pure deterministic — feeds the union of all per-shard entries to the composer,
 * which canonicalizes them. Same bundle ⇒ same recomposed snapshot ALWAYS.
 */
function reaggregate(
  bundle: ShardExportBundle,
  base: { ordinal: number; full: FullProgressionSnapshot },
): CompositeWorldSnapshot {
  type Flag = FullProgressionSnapshot['world_state']['flags'][number];
  type Quest = FullProgressionSnapshot['quest_progress'][number];
  const allFlags = bundle.shards.flatMap((s) => s.flags as Flag[]);
  const allQuests = bundle.shards.flatMap((s) => s.quests as Quest[]);
  const allEvents = bundle.shards.flatMap((s) => s.world_events as WorldEventInstanceSnapshot[]);
  const source: WorldStateSnapshotSource = {
    full: {
      ...base.full,
      ordinal: base.ordinal,
      world_state: {
        ...base.full.world_state,
        ordinal: base.ordinal,
        flags: allFlags,
      },
      quest_progress: allQuests,
    },
    world_event_instances: allEvents,
  };
  return composeWorldSnapshot(source);
}

/**
 * Cross-shard progression sync coordinator.
 *
 * Stateless — same input → same output. Caller manages transport / shard topology.
 */
export class CrossShardProgressionSync {
  constructor(private readonly deps: CrossShardSyncDeps = {}) {}

  /**
   * Prepare a sync envelope from a source snapshot + partitioner.
   *
   * Same snapshot + same partitioner ⇒ byte-identical envelope.
   */
  prepareShardSync(snapshot: CompositeWorldSnapshot, partitioner: ShardPartitionFn): ShardSyncEnvelope {
    const bundle = partitionSnapshot(snapshot, partitioner);
    const source_checksum = checksumSnapshot(snapshot);
    const bundle_checksum = fnv1a(JSON.stringify(bundle));
    const envelope_checksum = computeEnvelopeChecksum(
      CROSS_SHARD_SYNC_SCHEMA_VERSION,
      snapshot.ordinal,
      source_checksum,
      bundle_checksum,
    );
    const envelope: ShardSyncEnvelope = {
      envelope_schema_version: CROSS_SHARD_SYNC_SCHEMA_VERSION,
      ordinal: snapshot.ordinal,
      source_checksum,
      bundle,
      bundle_checksum,
      envelope_checksum,
    };
    if (this.deps.telemetry) {
      this.deps.telemetry.publishWorldStateDiagnostic({
        kind: 'shard_sync_prepared',
        severity: 'info',
        ordinal: snapshot.ordinal,
        payload: {
          source_checksum,
          bundle_checksum,
          envelope_checksum,
          shard_count: bundle.manifest.shard_count,
        },
      });
    }
    return envelope;
  }

  /**
   * Verify a sync envelope without applying it.
   *
   * Checks:
   *   1. Schema version compatible
   *   2. `verifyShardBundle` (per-shard checksum + manifest consistency)
   *   3. bundle_checksum re-derives from bundle's canonical JSON
   *   4. Manifest ordinal matches envelope ordinal
   *   5. envelope_checksum re-derives from (schema_version, ordinal, source_checksum, bundle_checksum)
   *      — Phase 15 BUG-V FIX: catches tampered source_checksum at verify time
   */
  verifyShardSync(envelope: ShardSyncEnvelope): ShardSyncVerifyResult {
    if (envelope.envelope_schema_version !== CROSS_SHARD_SYNC_SCHEMA_VERSION) {
      return {
        ok: false,
        reason: `Envelope schema version mismatch: ${envelope.envelope_schema_version}`,
      };
    }
    const bundle_ok = verifyShardBundle(envelope.bundle);
    if (!bundle_ok) {
      this.emit('shard_sync_bundle_invalid', envelope.ordinal);
      return { ok: false, bundle_ok: false, reason: 'Bundle integrity failed' };
    }
    const reDerivedBundle = fnv1a(JSON.stringify(envelope.bundle));
    const bundle_checksum_ok = reDerivedBundle === envelope.bundle_checksum;
    if (!bundle_checksum_ok) {
      this.emit(
        'shard_sync_bundle_checksum_mismatch',
        envelope.ordinal,
        `re-derived ${reDerivedBundle} ≠ envelope ${envelope.bundle_checksum}`,
      );
      return {
        ok: false,
        bundle_ok: true,
        bundle_checksum_ok: false,
        reason: `Bundle checksum mismatch: ${reDerivedBundle} ≠ ${envelope.bundle_checksum}`,
      };
    }
    if (envelope.bundle.manifest.ordinal !== envelope.ordinal) {
      return {
        ok: false,
        bundle_ok: true,
        bundle_checksum_ok: true,
        reason: `Manifest ordinal ${envelope.bundle.manifest.ordinal} ≠ envelope ${envelope.ordinal}`,
      };
    }
    const reDerivedEnvelope = computeEnvelopeChecksum(
      envelope.envelope_schema_version,
      envelope.ordinal,
      envelope.source_checksum,
      envelope.bundle_checksum,
    );
    const envelope_ok = reDerivedEnvelope === envelope.envelope_checksum;
    if (!envelope_ok) {
      this.emit(
        'shard_sync_envelope_checksum_mismatch',
        envelope.ordinal,
        `re-derived ${reDerivedEnvelope} ≠ envelope ${envelope.envelope_checksum}`,
      );
      return {
        ok: false,
        bundle_ok: true,
        bundle_checksum_ok: true,
        envelope_ok: false,
        reason: `Envelope checksum mismatch: ${reDerivedEnvelope} ≠ ${envelope.envelope_checksum}`,
      };
    }
    return { ok: true, bundle_ok: true, bundle_checksum_ok: true, envelope_ok: true };
  }

  /**
   * Apply a sync envelope: re-aggregate per-shard slices into a CompositeWorldSnapshot.
   *
   * Requires `base` — a same-ordinal FullProgressionSnapshot template (typically
   * loaded from the receiving shard's persistence so reward_ledger / affinity / etc.
   * scaffolding is in place). The composer canonicalizes both inputs.
   *
   * Verifies re-composed checksum matches envelope.source_checksum.
   */
  applyShardSync(
    envelope: ShardSyncEnvelope,
    base: { ordinal: number; full: FullProgressionSnapshot },
  ): ShardSyncApplyResult {
    const verify = this.verifyShardSync(envelope);
    if (!verify.ok) {
      return { ok: false, reason: verify.reason };
    }
    if (base.ordinal !== envelope.ordinal) {
      return {
        ok: false,
        reason: `Base ordinal ${base.ordinal} ≠ envelope ordinal ${envelope.ordinal}`,
      };
    }
    const recomposed = reaggregate(envelope.bundle, base);
    const recomposed_checksum = checksumSnapshot(recomposed);
    if (recomposed_checksum !== envelope.source_checksum) {
      this.emit(
        'shard_sync_recomposed_checksum_drift',
        envelope.ordinal,
        `recomposed ${recomposed_checksum} ≠ source ${envelope.source_checksum}`,
      );
      return {
        ok: false,
        snapshot: recomposed,
        recomposed_checksum,
        reason: `Re-composed checksum drift: ${recomposed_checksum} ≠ ${envelope.source_checksum}`,
      };
    }
    return { ok: true, snapshot: recomposed, recomposed_checksum };
  }

  /**
   * Verify shard migration parity: same source snapshot partitioned into N
   * shards (before) vs M shards (after) MUST re-aggregate to the same
   * canonical state.
   *
   * Caller supplies `base` (same-ordinal full snapshot template) for both
   * re-aggregations.
   */
  verifyShardMigration(
    beforeBundle: ShardExportBundle,
    afterBundle: ShardExportBundle,
    base: { ordinal: number; full: FullProgressionSnapshot },
  ): ShardMigrationParityResult {
    if (!verifyShardBundle(beforeBundle)) {
      return { ok: false, reason: 'Before-bundle integrity failed' };
    }
    if (!verifyShardBundle(afterBundle)) {
      return { ok: false, reason: 'After-bundle integrity failed' };
    }
    if (beforeBundle.manifest.ordinal !== afterBundle.manifest.ordinal) {
      return {
        ok: false,
        reason: `Manifest ordinal mismatch: before ${beforeBundle.manifest.ordinal} ≠ after ${afterBundle.manifest.ordinal}`,
      };
    }
    if (beforeBundle.manifest.ordinal !== base.ordinal) {
      return {
        ok: false,
        reason: `Manifest ordinal ${beforeBundle.manifest.ordinal} ≠ base ${base.ordinal}`,
      };
    }
    const beforeSnap = reaggregate(beforeBundle, base);
    const afterSnap = reaggregate(afterBundle, base);
    const before_recomposed_checksum = checksumSnapshot(beforeSnap);
    const after_recomposed_checksum = checksumSnapshot(afterSnap);
    const ok = before_recomposed_checksum === after_recomposed_checksum;
    if (!ok) {
      this.emit(
        'shard_migration_parity_drift',
        base.ordinal,
        `before ${before_recomposed_checksum} ≠ after ${after_recomposed_checksum}`,
      );
    }
    return {
      ok,
      before_recomposed_checksum,
      after_recomposed_checksum,
      ...(ok
        ? {}
        : {
            reason: `Migration parity drift: ${before_recomposed_checksum} ≠ ${after_recomposed_checksum}`,
          }),
    };
  }

  /**
   * Progression continuity validation — partition then re-aggregate without
   * any cross-shard mutation in between. Returns ok=true iff bytes match.
   */
  validateContinuity(
    snapshot: CompositeWorldSnapshot,
    partitioner: ShardPartitionFn,
  ): { ok: boolean; reason?: string; source_checksum: string; recomposed_checksum: string } {
    const sourceJson = toCanonicalJson(snapshot);
    const source_checksum = checksumSnapshot(snapshot);
    const envelope = this.prepareShardSync(snapshot, partitioner);
    const applied = this.applyShardSync(envelope, {
      ordinal: snapshot.ordinal,
      full: snapshot.replay_progression.full,
    });
    if (!applied.ok || !applied.snapshot) {
      return {
        ok: false,
        source_checksum,
        recomposed_checksum: applied.recomposed_checksum ?? '',
        ...(applied.reason !== undefined ? { reason: applied.reason } : {}),
      };
    }
    const ok = toCanonicalJson(applied.snapshot) === sourceJson;
    return {
      ok,
      source_checksum,
      recomposed_checksum: applied.recomposed_checksum!,
      ...(ok ? {} : { reason: 'Re-composed canonical JSON differs from source' }),
    };
  }

  private emit(kind: string, ordinal?: number, detail?: string): void {
    if (!this.deps.telemetry) return;
    this.deps.telemetry.publishWorldStateDiagnostic({
      kind,
      severity: 'warn',
      ...(ordinal !== undefined ? { ordinal } : {}),
      ...(detail !== undefined ? { detail } : {}),
    });
  }
}

/**
 * Parse a ShardSyncEnvelope at deserialization boundary.
 *
 * NOTE: nested `bundle` is opaque to Zod here — caller pairs with
 * `parseShardBundle` from `progression_shard_export` if strict bundle
 * validation is required.
 */
export function parseShardSyncEnvelope(raw: unknown): ShardSyncEnvelope {
  return ShardSyncEnvelopeSchema.parse(raw) as ShardSyncEnvelope;
}

/**
 * CANONICAL PERSISTENCE SNAPSHOT RUNTIME — Phase 16 §2.
 *
 * Final canonical persistence snapshot infrastructure. Wraps the existing
 * `progression_persistence_adapter` save/load pipeline with a layered envelope
 * that explicitly separates SNAPSHOT-CONTENT bytes from OPERATIONAL METADATA.
 *
 * The CRITICAL contract (per directive v7 §2):
 *
 *   snapshot metadata MUST NEVER affect
 *     - replay continuation
 *     - restore checksum
 *     - shard synchronization
 *     - persistence verification
 *
 * This module enforces that contract structurally:
 *   - `content_envelope_checksum` is computed over the inner persistence envelope ONLY
 *     (no metadata fields enter the hash domain)
 *   - `metadata` is carried in a sibling field outside the hash domain
 *   - `verifyCanonicalEnvelope` re-derives content_envelope_checksum to detect any tamper
 *   - `verifyMetadataIsolation(env, mutator)` proves the contract by running a mutation
 *     and confirming the content hash is unchanged
 *
 * Phase 16 §"STRICT LIMITS":
 *   - NO live networking / DB / websocket
 *   - Validation + canonical-form coordinator ONLY
 *   - Pure deterministic
 */
import { z } from 'zod';
import {
  composeWorldSnapshot,
  type CompositeWorldSnapshot,
  type WorldEventInstanceSnapshot,
} from './world_state_snapshot_schema.js';
import {
  saveComposite,
  loadSnapshot,
  type PersistenceEnvelope,
  type SaveOptions,
} from './progression_persistence_adapter.js';
import type { FullProgressionSnapshot } from './progression_replay_runtime.js';
import type { GlobalTelemetryService } from './global_telemetry_service.js';

export const CANONICAL_SNAPSHOT_SCHEMA_VERSION = 1;

// ───────────────────── schemas ─────────────────────

/**
 * Metadata sidecar — caller-supplied operational info that MUST NOT affect content hashing.
 *
 * Examples: timestamps, observer attach counters, network shard topology hints,
 * authority node id, GM session id. NONE of these should change the canonical
 * persistence verification result.
 */
export const CanonicalSnapshotMetadataSchema = z.object({
  /** Optional operational metadata key/value pairs. */
  tags: z.record(z.string(), z.string()).optional(),
  /** Optional notes (debug-only). */
  notes: z.string().optional(),
  /** Optional caller-supplied capture identifier. */
  capture_id: z.string().optional(),
});
export type CanonicalSnapshotMetadata = z.infer<typeof CanonicalSnapshotMetadataSchema>;

export const CanonicalSnapshotEnvelopeSchema = z.object({
  envelope_schema_version: z.number().int().positive(),
  /** Inner persistence envelope (the content). Opaque at this level. */
  content_envelope: z.unknown(),
  /** FNV-1a checksum over canonical JSON of `content_envelope` ALONE. */
  content_envelope_checksum: z.string().min(1),
  /** Operational metadata — HASH-EXCLUDED. Caller can mutate freely without breaking verify. */
  metadata: CanonicalSnapshotMetadataSchema,
});
export interface CanonicalSnapshotEnvelope {
  envelope_schema_version: number;
  content_envelope: PersistenceEnvelope;
  content_envelope_checksum: string;
  metadata: CanonicalSnapshotMetadata;
}

export interface CanonicalSnapshotVerifyResult {
  ok: boolean;
  reason?: string;
  /** True if the inner envelope parses + recomputes its own content_checksum. */
  inner_ok: boolean;
  /** True if the canonical envelope's content_envelope_checksum re-derives. */
  outer_ok: boolean;
}

export interface CanonicalSnapshotCaptureOptions {
  /** Forwarded to the inner persistence adapter (e.g. replay_version). */
  save_options?: SaveOptions;
  /** Caller-supplied metadata (defaults to empty). */
  metadata?: CanonicalSnapshotMetadata;
}

export interface CanonicalSnapshotRuntimeDeps {
  /** Optional telemetry sink. */
  telemetry?: GlobalTelemetryService;
}

// ───────────────────── helpers ─────────────────────
function fnv1a(s: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function computeContentEnvelopeChecksum(inner: PersistenceEnvelope): string {
  return fnv1a(JSON.stringify(inner));
}

/**
 * Canonicalize metadata for stable comparison — sort keys + sort tag entries.
 * Used by `verifyMetadataIsolation` to reject no-op mutators (BUG-AN).
 */
function canonicalizeMetadata(m: CanonicalSnapshotMetadata): unknown {
  const sortedTags: Record<string, string> = {};
  if (m.tags) {
    for (const k of Object.keys(m.tags).sort()) sortedTags[k] = m.tags[k]!;
  }
  return {
    tags: sortedTags,
    notes: m.notes ?? '',
    capture_id: m.capture_id ?? '',
  };
}

/**
 * Canonical persistence snapshot coordinator.
 *
 * Same inputs (snapshot + save_options) ⇒ byte-identical content_envelope.
 * Metadata field is sidecar — mutation does NOT affect content_envelope_checksum.
 */
export class CanonicalPersistenceSnapshotRuntime {
  constructor(private readonly deps: CanonicalSnapshotRuntimeDeps = {}) {}

  /**
   * Capture a snapshot into a canonical envelope.
   *
   * Steps:
   *   1. saveComposite(snapshot, options) → inner PersistenceEnvelope + wire_bytes
   *   2. Compute content_envelope_checksum = FNV-1a(JSON.stringify(content_envelope))
   *   3. Wrap with caller metadata sidecar
   *
   * Pure deterministic — same snapshot + same options → byte-identical content_envelope.
   */
  capture(
    snapshot: CompositeWorldSnapshot,
    options: CanonicalSnapshotCaptureOptions = {},
  ): CanonicalSnapshotEnvelope {
    const save = saveComposite(snapshot, options.save_options ?? {});
    const content_envelope_checksum = computeContentEnvelopeChecksum(save.envelope);
    const metadata = options.metadata ?? {};
    if (this.deps.telemetry) {
      this.deps.telemetry.publishWorldStateDiagnostic({
        kind: 'canonical_snapshot_captured',
        severity: 'info',
        ordinal: snapshot.ordinal,
        payload: {
          content_envelope_checksum,
          content_checksum: save.envelope.content_checksum,
          metadata_keys: Object.keys(metadata).sort(),
        },
      });
    }
    return {
      envelope_schema_version: CANONICAL_SNAPSHOT_SCHEMA_VERSION,
      content_envelope: save.envelope,
      content_envelope_checksum,
      metadata,
    };
  }

  /**
   * Convenience: capture directly from a source (composes first).
   */
  captureFromSource(
    full: FullProgressionSnapshot,
    world_event_instances: readonly WorldEventInstanceSnapshot[],
    options: CanonicalSnapshotCaptureOptions = {},
  ): CanonicalSnapshotEnvelope {
    return this.capture(
      composeWorldSnapshot({ full, world_event_instances }),
      options,
    );
  }

  /**
   * Verify a canonical envelope:
   *   - inner_ok: PersistenceEnvelope parses + inner content_checksum matches snapshot
   *   - outer_ok: content_envelope_checksum re-derives from inner envelope JSON
   *
   * Both must be true for ok=true.
   */
  verify(envelope: CanonicalSnapshotEnvelope): CanonicalSnapshotVerifyResult {
    if (envelope.envelope_schema_version !== CANONICAL_SNAPSHOT_SCHEMA_VERSION) {
      return {
        ok: false,
        inner_ok: false,
        outer_ok: false,
        reason: `Schema version mismatch: ${envelope.envelope_schema_version}`,
      };
    }
    const reDerived = computeContentEnvelopeChecksum(envelope.content_envelope);
    const outer_ok = reDerived === envelope.content_envelope_checksum;
    if (!outer_ok) {
      this.emit('canonical_snapshot_outer_checksum_drift', envelope.content_envelope.ordinal, `re-derived ${reDerived} ≠ ${envelope.content_envelope_checksum}`);
    }
    // Verify inner by re-routing through loadSnapshot (which checks inner content_checksum).
    const innerWire = JSON.stringify(envelope.content_envelope);
    const loaded = loadSnapshot(innerWire);
    const inner_ok = loaded.ok;
    if (!inner_ok) {
      this.emit('canonical_snapshot_inner_load_failed', envelope.content_envelope.ordinal, loaded.reason);
    }
    const ok = inner_ok && outer_ok;
    return {
      ok,
      inner_ok,
      outer_ok,
      ...(ok ? {} : { reason: `Verify failed: inner_ok=${inner_ok}, outer_ok=${outer_ok}` }),
    };
  }

  /**
   * Restore a snapshot from a canonical envelope.
   *
   * Verifies the envelope first; returns undefined on failure.
   */
  restore(envelope: CanonicalSnapshotEnvelope): { ok: boolean; snapshot?: CompositeWorldSnapshot; reason?: string } {
    const verify = this.verify(envelope);
    if (!verify.ok) {
      return { ok: false, reason: verify.reason };
    }
    const innerWire = JSON.stringify(envelope.content_envelope);
    const loaded = loadSnapshot(innerWire);
    if (!loaded.ok || !loaded.snapshot) {
      return { ok: false, reason: loaded.reason ?? 'Load failed' };
    }
    return { ok: true, snapshot: loaded.snapshot };
  }

  /**
   * Verify metadata isolation contract:
   *   mutating metadata MUST NOT change content_envelope_checksum.
   *
   * BUG-AB FIX (deep audit): the previous version computed `after_checksum`
   * from `mutated.content_envelope` — the SAME object reference as the input
   * envelope, so the mutator was effectively dead-weight. That collapsed the
   * function into a self-consistency check (`stored === re-derived from same
   * inner`) and gave false confidence that metadata could not propagate. A
   * future regression that routed metadata into the inner persistence pipeline
   * would still pass that probe.
   *
   * The fixed version exercises the FULL capture pipeline twice:
   *   1. capture(snapshot, baseOptions) → env_before
   *   2. capture(snapshot, mutator(baseOptions)) → env_after
   *   3. Assert content_envelope_checksum is byte-identical.
   *
   * Any regression that routes metadata into the hash domain (or any
   * caller-supplied option that leaks into save_options) is detected.
   */
  verifyMetadataIsolation(
    snapshot: CompositeWorldSnapshot,
    baseOptions: CanonicalSnapshotCaptureOptions,
    mutator: (m: CanonicalSnapshotMetadata) => CanonicalSnapshotMetadata,
  ): { ok: boolean; before_checksum: string; after_checksum: string; reason?: string } {
    const baseMetadata: CanonicalSnapshotMetadata = baseOptions.metadata ?? {};
    const mutatedMetadata = mutator({ ...baseMetadata });
    // BUG-AN FIX (deep audit): require the mutator to ACTUALLY mutate. An
    // identity mutator (m => m) would otherwise produce before === after
    // trivially and return ok=true without exercising the isolation contract.
    // Compare canonical JSON of base vs mutated metadata; reject no-op mutators.
    const baseMetaJson = JSON.stringify(canonicalizeMetadata(baseMetadata));
    const mutatedMetaJson = JSON.stringify(canonicalizeMetadata(mutatedMetadata));
    if (baseMetaJson === mutatedMetaJson) {
      const stable = this.capture(snapshot, baseOptions).content_envelope_checksum;
      return {
        ok: false,
        before_checksum: stable,
        after_checksum: stable,
        reason: 'Mutator did not change metadata — cannot verify isolation with a no-op mutation',
      };
    }
    const before = this.capture(snapshot, baseOptions);
    const after = this.capture(snapshot, {
      ...baseOptions,
      metadata: mutatedMetadata,
    });
    return {
      ok: before.content_envelope_checksum === after.content_envelope_checksum,
      before_checksum: before.content_envelope_checksum,
      after_checksum: after.content_envelope_checksum,
    };
  }

  private emit(kind: string, ordinal?: number, detail?: string): void {
    if (!this.deps.telemetry) return;
    // BUG-BG FIX (deep audit R7 telemetry-critical-path): the previous
    // version hardcoded `severity: 'warn'` for ALL emits — including
    // `canonical_snapshot_outer_checksum_drift` and
    // `canonical_snapshot_inner_load_failed`, both of which signal envelope
    // tampering or corruption (i.e. the integrity guarantee of the canonical
    // snapshot pipeline has been violated). Monitoring dashboards filter by
    // severity; tampering events emitted at `warn` were silently bucketed
    // alongside benign warnings instead of paging on-call. The two integrity-
    // violation kinds are now elevated to `critical`; all other diagnostic
    // emits remain `warn` (the original default semantics).
    const severity: 'critical' | 'warn' =
      kind === 'canonical_snapshot_outer_checksum_drift' ||
      kind === 'canonical_snapshot_inner_load_failed'
        ? 'critical'
        : 'warn';
    this.deps.telemetry.publishWorldStateDiagnostic({
      kind,
      severity,
      ...(ordinal !== undefined ? { ordinal } : {}),
      ...(detail !== undefined ? { detail } : {}),
    });
  }
}

export function parseCanonicalSnapshotEnvelope(raw: unknown): CanonicalSnapshotEnvelope {
  return CanonicalSnapshotEnvelopeSchema.parse(raw) as CanonicalSnapshotEnvelope;
}

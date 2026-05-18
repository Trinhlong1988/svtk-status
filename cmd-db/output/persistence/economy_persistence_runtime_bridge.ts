/**
 * ECONOMY PERSISTENCE RUNTIME BRIDGE — Phase 14 #1.
 *
 * Storage-agnostic persistence bridge specifically cho ECONOMY layer.
 * Khác với generic persistence_adapter_bridge.ts (Batch 2 — cross-CMD generic),
 * file này dành riêng ECONOMY domain:
 *   - Wraps frozen PersistenceAdapter (Phase 12) + frozen SnapshotExporter
 *   - Provides save/load/restore lifecycle cho economy state
 *   - Reconnect-safe restore (idempotent + canonical)
 *   - Canonical snapshot export với hash verification
 *
 * STRICT SCOPE (v15 Phase 14 spec):
 *   - SUPPORT: storage-agnostic / replay-safe save+load / reconnect-safe restore / canonical export / deterministic ordering
 *   - NO direct DB implementation (caller injects PersistenceAdapter impl)
 *   - NO live economy runtime / loot rewrite / progression modify
 *
 * MANDATORY RULE:
 *   same economy state = same persistence snapshot = same restore ALWAYS.
 *
 * Lock policy:
 *   - economy/* FROZEN — bridge consumes types + serialization only
 *   - economy_integration/persistence_adapter.ts FROZEN — bridge wraps
 *   - economy_integration/snapshot_exporter.ts FROZEN — bridge orchestrates
 *
 * Audit-fix notes (Phase 14 pass 1):
 *   - P#1: importPlayerSnapshot now reads serialization_version (was schema_version mismatch)
 *   - P#2: loadInventory / restoreOnReconnect / exportPlayerSnapshot return frozen snapshot
 *   - P#3: expected_hash regex validates hex chars (was length-only)
 *   - P#4: lifecycle log getter wraps each entry in frozen (was already frozen on push)
 *
 * Audit-fix notes (Phase 14 pass 2):
 *   - P2#1: deep freeze snapshots returned from load/restore/export (caller cannot mutate nested arrays)
 */
import type {
  PersistenceAdapter,
  PersistedRecord,
  PersistenceQuery,
} from './persistence_adapter.js';
import type {
  SnapshotExporter,
  PlayerEconomySnapshot,
} from './snapshot_exporter.js';
import type { EconomyFoundationRuntime } from '../../../cmd-engine/output/economy/foundation/economy_foundation_runtime.js';
import type { InventorySnapshot } from '../../../cmd-engine/output/economy/inventory_snapshot_schema.js';
import { serializeInventorySnapshot, deserializeInventorySnapshot, canonicalJSON } from '../../../cmd-engine/output/economy/economy_serialization_contract.js';
import { fnv1a32 } from '../../../cmd-engine/output/economy/modifier_ordering_audit.js';
import { ECONOMY_SERIALIZATION_VERSION } from '../../../cmd-engine/output/economy/economy_serialization_contract.js';

export const ECONOMY_PERSISTENCE_BRIDGE_VERSION = 1;

// ───────── Lifecycle event kinds ─────────
export const PERSISTENCE_LIFECYCLE_KINDS = [
  'save_inventory',
  'load_inventory',
  'restore_reconnect',
  'export_snapshot',
  'import_snapshot',
] as const;
export type PersistenceLifecycleKind = (typeof PERSISTENCE_LIFECYCLE_KINDS)[number];

export interface PersistenceLifecycleEntry {
  /** Lifecycle event kind. */
  kind: PersistenceLifecycleKind;
  /** Player scope (null for system-wide). */
  player_id: string | null;
  /** Server tick. */
  tick: number;
  /** Deterministic content hash (FNV-1a). */
  content_hash: string;
  /** Schema version of payload at event time. */
  schema_version: number;
  /** Status discriminator. */
  status: 'ok' | 'noop' | 'verify_failed';
}

// ───────── Bridge contract ─────────
export interface EconomyPersistenceRuntimeBridge {
  /**
   * Save inventory snapshot via underlying PersistenceAdapter.
   * Returns record_id from adapter + lifecycle entry.
   */
  saveInventory(snapshot: InventorySnapshot, tick: number): {
    record_id: string;
    lifecycle: PersistenceLifecycleEntry;
  };

  /**
   * Load latest inventory for player. Idempotent + replay-safe.
   * Returns null if no snapshot persisted.
   */
  loadInventory(player_id: string, tick: number): {
    snapshot: InventorySnapshot | null;
    lifecycle: PersistenceLifecycleEntry;
  };

  /**
   * Reconnect-safe restore. Verifies snapshot canonical hash matches before return.
   * If hash mismatch → returns null + verify_failed lifecycle.
   */
  restoreOnReconnect(player_id: string, tick: number): {
    snapshot: InventorySnapshot | null;
    lifecycle: PersistenceLifecycleEntry;
  };

  /**
   * Export player economy snapshot canonical (via SnapshotExporter).
   * Requires EconomyFoundationRuntime + tick range (matches frozen exporter API).
   * Returns snapshot + content_hash + lifecycle.
   */
  exportPlayerSnapshot(
    runtime: EconomyFoundationRuntime,
    player_id: string,
    tick_start: number,
    tick_end: number,
  ): {
    snapshot: PlayerEconomySnapshot;
    content_hash: string;
    lifecycle: PersistenceLifecycleEntry;
  };

  /**
   * Import (verify) player snapshot. Caller provides snapshot JSON +
   * expected hash → bridge canonicalize + compare.
   */
  importPlayerSnapshot(
    snapshot_json: string,
    expected_hash: string,
    player_id: string,
    tick: number,
  ): {
    ok: boolean;
    lifecycle: PersistenceLifecycleEntry;
  };

  /** Persistence lifecycle audit log (in-memory, frozen snapshot). */
  readonly lifecycleLog: readonly PersistenceLifecycleEntry[];

  /** Clear lifecycle audit (test). */
  clearLifecycleLog(): void;

  /** Get underlying adapter reference (READ-ONLY usage only). */
  readonly adapter: PersistenceAdapter;
}

// ───────── Deep freeze utility (P2#1) ─────────
/**
 * Recursively freeze plain objects + arrays. Skip primitives + null + already-frozen.
 * Used cho replay-safety: caller MUST NOT mutate snapshots returned by bridge.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const k of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[k]);
  }
  return value;
}

// ───────── Validation ─────────
function validateTick(tick: number): void {
  if (!Number.isInteger(tick) || tick < 0) {
    throw new Error(`[EconomyPersistenceRuntimeBridge] tick must be non-negative integer (got ${tick})`);
  }
}

function validatePlayerId(player_id: string): void {
  if (typeof player_id !== 'string' || player_id.length === 0) {
    throw new Error(`[EconomyPersistenceRuntimeBridge] player_id must be non-empty string`);
  }
}

// ───────── Factory ─────────
export interface EconomyPersistenceBridgeOptions {
  /** Underlying adapter (caller-provided — server team's DB impl OR in-memory ref). */
  adapter: PersistenceAdapter;
  /** Underlying snapshot exporter. */
  snapshotExporter: SnapshotExporter;
}

export function createEconomyPersistenceRuntimeBridge(
  opts: EconomyPersistenceBridgeOptions,
): EconomyPersistenceRuntimeBridge {
  const { adapter, snapshotExporter } = opts;
  if (!adapter) {
    throw new Error(`[EconomyPersistenceRuntimeBridge] adapter is required`);
  }
  if (!snapshotExporter) {
    throw new Error(`[EconomyPersistenceRuntimeBridge] snapshotExporter is required`);
  }

  const lifecycleLog: PersistenceLifecycleEntry[] = [];

  function pushLifecycle(entry: PersistenceLifecycleEntry): PersistenceLifecycleEntry {
    const frozen = Object.freeze({ ...entry });
    lifecycleLog.push(frozen);
    return frozen;
  }

  function inventoryHash(snapshot: InventorySnapshot): string {
    return fnv1a32(serializeInventorySnapshot(snapshot));
  }

  return {
    saveInventory(snapshot, tick) {
      validateTick(tick);
      if (!snapshot || typeof snapshot !== 'object') {
        throw new Error(`[EconomyPersistenceRuntimeBridge] snapshot must be non-null InventorySnapshot`);
      }
      const record_id = adapter.writeInventorySnapshot(snapshot);
      const content_hash = inventoryHash(snapshot);
      const lifecycle = pushLifecycle({
        kind: 'save_inventory',
        player_id: snapshot.player_id,
        tick,
        content_hash,
        schema_version: ECONOMY_SERIALIZATION_VERSION,
        status: 'ok',
      });
      return { record_id, lifecycle };
    },

    loadInventory(player_id, tick) {
      validatePlayerId(player_id);
      validateTick(tick);
      const snapshot = adapter.readInventorySnapshot(player_id);
      if (!snapshot) {
        const lifecycle = pushLifecycle({
          kind: 'load_inventory',
          player_id,
          tick,
          content_hash: fnv1a32(`empty|${player_id}`),
          schema_version: ECONOMY_SERIALIZATION_VERSION,
          status: 'noop',
        });
        return { snapshot: null, lifecycle };
      }
      const content_hash = inventoryHash(snapshot);
      const lifecycle = pushLifecycle({
        kind: 'load_inventory',
        player_id,
        tick,
        content_hash,
        schema_version: ECONOMY_SERIALIZATION_VERSION,
        status: 'ok',
      });
      // P#2 + P2#1: deep freeze snapshot (caller cannot mutate any nested field).
      return { snapshot: deepFreeze(snapshot), lifecycle };
    },

    restoreOnReconnect(player_id, tick) {
      validatePlayerId(player_id);
      validateTick(tick);
      const snapshot = adapter.readInventorySnapshot(player_id);
      if (!snapshot) {
        const lifecycle = pushLifecycle({
          kind: 'restore_reconnect',
          player_id,
          tick,
          content_hash: fnv1a32(`empty|${player_id}`),
          schema_version: ECONOMY_SERIALIZATION_VERSION,
          status: 'noop',
        });
        return { snapshot: null, lifecycle };
      }
      // Hash verification — serialize then deserialize then re-serialize
      // canonical equality check.
      const json = serializeInventorySnapshot(snapshot);
      let verified = false;
      try {
        const restored = deserializeInventorySnapshot(json);
        const json2 = serializeInventorySnapshot(restored);
        verified = json === json2;
      } catch {
        verified = false;
      }
      const content_hash = fnv1a32(json);
      const lifecycle = pushLifecycle({
        kind: 'restore_reconnect',
        player_id,
        tick,
        content_hash,
        schema_version: ECONOMY_SERIALIZATION_VERSION,
        status: verified ? 'ok' : 'verify_failed',
      });
      // P#2 + P2#1: deep freeze restored snapshot.
      return { snapshot: verified ? deepFreeze(snapshot) : null, lifecycle };
    },

    exportPlayerSnapshot(runtime, player_id, tick_start, tick_end) {
      if (!runtime || typeof runtime.getSnapshot !== 'function') {
        throw new Error(`[EconomyPersistenceRuntimeBridge] runtime must be a valid EconomyFoundationRuntime`);
      }
      validatePlayerId(player_id);
      validateTick(tick_start);
      validateTick(tick_end);
      if (tick_end < tick_start) {
        throw new Error(`[EconomyPersistenceRuntimeBridge] tick_end (${tick_end}) < tick_start (${tick_start})`);
      }
      const snapshot = snapshotExporter.buildPlayerEconomySnapshot(runtime, player_id, tick_start, tick_end);
      const content_hash = fnv1a32(canonicalJSON(snapshot as unknown));
      const lifecycle = pushLifecycle({
        kind: 'export_snapshot',
        player_id,
        tick: tick_end,
        content_hash,
        schema_version: snapshot.serialization_version,
        status: 'ok',
      });
      // P#2 + P2#1: deep freeze exported snapshot.
      return { snapshot: deepFreeze(snapshot), content_hash, lifecycle };
    },

    importPlayerSnapshot(snapshot_json, expected_hash, player_id, tick) {
      validatePlayerId(player_id);
      validateTick(tick);
      if (typeof snapshot_json !== 'string' || snapshot_json.length === 0) {
        throw new Error(`[EconomyPersistenceRuntimeBridge] snapshot_json must be non-empty string`);
      }
      // P#3: validate hex char format (was length-only check).
      if (typeof expected_hash !== 'string' || !/^[0-9a-f]{8}$/.test(expected_hash)) {
        throw new Error(`[EconomyPersistenceRuntimeBridge] expected_hash must be 8-char lowercase hex (FNV-1a) string`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(snapshot_json);
      } catch {
        const lifecycle = pushLifecycle({
          kind: 'import_snapshot',
          player_id,
          tick,
          content_hash: 'invalid0',
          schema_version: 0,
          status: 'verify_failed',
        });
        return { ok: false, lifecycle };
      }
      const recanonical = canonicalJSON(parsed);
      const actual_hash = fnv1a32(recanonical);
      const ok = actual_hash === expected_hash;
      // P#1 fix: PlayerEconomySnapshot exposes `serialization_version`, not `schema_version`.
      // Try both for resilience (caller may import other snapshot shapes).
      const vs = parsed as { serialization_version?: unknown; schema_version?: unknown } | null;
      const vCand = vs?.serialization_version ?? vs?.schema_version;
      const schema_version = typeof vCand === 'number' && Number.isInteger(vCand) && vCand >= 1
        ? vCand
        : 0;
      const lifecycle = pushLifecycle({
        kind: 'import_snapshot',
        player_id,
        tick,
        content_hash: actual_hash,
        schema_version,
        status: ok ? 'ok' : 'verify_failed',
      });
      return { ok, lifecycle };
    },

    get lifecycleLog() {
      return Object.freeze([...lifecycleLog]);
    },

    clearLifecycleLog() {
      lifecycleLog.length = 0;
    },

    get adapter() {
      return adapter;
    },
  };
}

// ───────── Helper: replay-safe save/load chain verification ─────────
/**
 * Round-trip verify: save → load → re-serialize. Returns true if byte-identical.
 * Pure helper — caller provides their own bridge instance.
 */
export function verifyEconomyPersistenceRoundtrip(
  bridge: EconomyPersistenceRuntimeBridge,
  snapshot: InventorySnapshot,
  tick: number,
): boolean {
  bridge.saveInventory(snapshot, tick);
  const loaded = bridge.loadInventory(snapshot.player_id, tick);
  if (!loaded.snapshot) return false;
  return serializeInventorySnapshot(loaded.snapshot) === serializeInventorySnapshot(snapshot);
}

// Re-export types caller may need.
export type {
  PersistenceAdapter,
  PersistedRecord,
  PersistenceQuery,
  SnapshotExporter,
  PlayerEconomySnapshot,
  EconomyFoundationRuntime,
};

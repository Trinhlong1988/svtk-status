/**
 * PERSISTENCE ADAPTER — Phase 12 Batch 1 Mục V.
 *
 * Contract layer cho economy persistence — actual DB impl ngoài scope CMD2
 * (server orchestration / ops team owns DB layer).
 *
 * Provides:
 *   - PersistenceAdapter interface
 *   - InMemoryPersistenceAdapter reference impl (test/dev)
 *   - 4 persistence domain: inventory / economy flow / loot delta / forensic event
 *
 * Lock policy (Phase 11B FREEZE):
 *   - KHÔNG modify frozen economy/* runtime
 *   - Adapter chỉ READ contract type từ economy/, KHÔNG modify economy state
 *   - Deterministic ordering ALWAYS (canonical sort enforced)
 *
 * R30 + R31 + canonical sort preserved.
 */
import type { InventorySnapshot } from '../../../cmd-engine/output/economy/inventory_snapshot_schema.js';
import type { LootDeltaMetadata, EconomyForensicSnapshotPayload } from '../../../cmd-engine/output/economy/economy_serialization_contract.js';
import { codepointCompare } from '../_shared/codepoint_compare.js';
import type { GoldFlow, ItemFlow } from '../../../cmd-engine/output/economy/foundation/economy_foundation_runtime.js';
import type { EconomyForensicEvent } from '../../../cmd-engine/output/economy/economy_forensic_telemetry.js';
// R14 bug-hunt: consolidated dup imports (was 2 separate blocks + 1 mid-file lazy import)
import {
  serializeInventorySnapshot,
  deserializeInventorySnapshot,
  serializeLootDelta,
  deserializeLootDelta,
  serializeEconomyForensicSnapshot,
  deserializeEconomyForensicSnapshot,
  canonicalJSON,
  ECONOMY_SERIALIZATION_VERSION,
} from '../../../cmd-engine/output/economy/economy_serialization_contract.js';
import { fnv1a32 } from '../../../cmd-engine/output/economy/modifier_ordering_audit.js';

// ───────── Persistence record kinds ─────────
export const PERSISTENCE_RECORD_KINDS = [
  'inventory_snapshot',
  'gold_flow',
  'item_flow',
  'loot_delta',
  'forensic_event',
  'forensic_snapshot',
] as const;
export type PersistenceRecordKind = (typeof PERSISTENCE_RECORD_KINDS)[number];

// ───────── Persisted record envelope ─────────
/**
 * Common envelope wrapping any persisted payload.
 * Caller index by (kind, player_id, tick, record_id) for query.
 */
export interface PersistedRecord {
  /** Kind discriminator. */
  kind: PersistenceRecordKind;
  /** Optional player scope (null for system-wide forensic). */
  player_id: string | null;
  /** Server tick when record persisted. */
  tick: number;
  /** Deterministic record id — FNV-1a hash of serialized payload (idempotency key). */
  record_id: string;
  /** Canonical JSON payload (caller deserialize via correct schema). */
  payload_json: string;
  /** Schema version (ECONOMY_SERIALIZATION_VERSION at write time). */
  schema_version: number;
}

// ───────── Query criteria ─────────
export interface PersistenceQuery {
  kind?: PersistenceRecordKind;
  player_id?: string;
  tick_start?: number;
  tick_end?: number;
  /** Limit returned records. Default 1000 (anti-flood). */
  limit?: number;
}

// ───────── PersistenceAdapter Contract ─────────
/**
 * Abstract adapter — server orchestration team implements actual DB backend
 * (PostgreSQL / Redis / MongoDB tuỳ chọn).
 *
 * Contract guarantees:
 *   - write: serialize input → canonical JSON → compute record_id → upsert
 *   - read: deserialize back to typed object (Zod re-validate)
 *   - query: return records sorted by (tick ASC, record_id ASC) deterministic
 */
export interface PersistenceAdapter {
  /** Persist inventory snapshot. Returns record_id. */
  writeInventorySnapshot(snapshot: InventorySnapshot): string;

  /** Read latest inventory snapshot for player. Returns null if none. */
  readInventorySnapshot(player_id: string): InventorySnapshot | null;

  /** Persist gold flow record. */
  writeGoldFlow(flow: GoldFlow): string;

  /** Persist item flow record. */
  writeItemFlow(flow: ItemFlow): string;

  /** Persist loot delta metadata. */
  writeLootDelta(meta: LootDeltaMetadata): string;

  /** Persist forensic event. */
  writeForensicEvent(event: EconomyForensicEvent): string;

  /** Persist forensic snapshot payload. */
  writeForensicSnapshot(payload: EconomyForensicSnapshotPayload): string;

  /** Query records by criteria. Sorted (tick ASC, record_id ASC). */
  query(criteria: PersistenceQuery): readonly PersistedRecord[];

  /** Get total record count by kind (telemetry counter). */
  count(kind?: PersistenceRecordKind): number;

  /** Reset all (test only). */
  _resetForTest(): void;
}

// ───────── In-memory reference implementation ─────────

interface InMemoryStore {
  records: PersistedRecord[];
  /** Index: latest inventory snapshot per player. */
  latestInventoryByPlayer: Map<string, string>;  // player_id → record_id
}

export function createInMemoryPersistenceAdapter(): PersistenceAdapter {
  const store: InMemoryStore = {
    records: [],
    latestInventoryByPlayer: new Map(),
  };

  function buildEnvelope(
    kind: PersistenceRecordKind,
    player_id: string | null,
    tick: number,
    payload_json: string,
  ): PersistedRecord {
    const record_id = fnv1a32(`${kind}|${player_id ?? ''}|${tick}|${payload_json}`);
    return { kind, player_id, tick, record_id, payload_json, schema_version: ECONOMY_SERIALIZATION_VERSION };
  }

  function upsert(record: PersistedRecord): void {
    // Idempotency: same record_id → replace (no duplicate).
    const existingIdx = store.records.findIndex(r => r.record_id === record.record_id);
    if (existingIdx >= 0) {
      store.records[existingIdx] = record;
    } else {
      store.records.push(record);
    }
  }

  return {
    writeInventorySnapshot(snapshot) {
      const json = serializeInventorySnapshot(snapshot);
      const record = buildEnvelope('inventory_snapshot', snapshot.player_id, snapshot.snapshot_tick, json);
      upsert(record);
      store.latestInventoryByPlayer.set(snapshot.player_id, record.record_id);
      return record.record_id;
    },

    readInventorySnapshot(player_id) {
      const record_id = store.latestInventoryByPlayer.get(player_id);
      if (!record_id) return null;
      const record = store.records.find(r => r.record_id === record_id);
      if (!record) return null;
      return deserializeInventorySnapshot(record.payload_json);
    },

    writeGoldFlow(flow) {
      const json = canonicalJSON(flow as unknown);
      const record = buildEnvelope('gold_flow', flow.player_id, flow.tick, json);
      upsert(record);
      return record.record_id;
    },

    writeItemFlow(flow) {
      const json = canonicalJSON(flow as unknown);
      const record = buildEnvelope('item_flow', flow.player_id, flow.tick, json);
      upsert(record);
      return record.record_id;
    },

    writeLootDelta(meta) {
      const json = serializeLootDelta(meta);
      const record = buildEnvelope('loot_delta', meta.player_id, meta.tick, json);
      upsert(record);
      return record.record_id;
    },

    writeForensicEvent(event) {
      const json = canonicalJSON({
        kind: event.kind,
        severity: event.severity,
        tick_start: event.tick_start,
        tick_end: event.tick_end,
        detail: event.detail,
        value_bp: event.value_bp,
        ...(event.player_id !== undefined ? { player_id: event.player_id } : {}),
      } as unknown);
      const record = buildEnvelope('forensic_event', event.player_id ?? null, event.tick_start, json);
      upsert(record);
      return record.record_id;
    },

    writeForensicSnapshot(payload) {
      const json = serializeEconomyForensicSnapshot(payload);
      const record = buildEnvelope('forensic_snapshot', null, payload.tick_end, json);
      upsert(record);
      return record.record_id;
    },

    query(criteria) {
      const limit = criteria.limit ?? 1000;
      const filtered = store.records.filter(r => {
        if (criteria.kind && r.kind !== criteria.kind) return false;
        if (criteria.player_id && r.player_id !== criteria.player_id) return false;
        if (criteria.tick_start !== undefined && r.tick < criteria.tick_start) return false;
        if (criteria.tick_end !== undefined && r.tick > criteria.tick_end) return false;
        return true;
      });
      // Sort deterministic (tick ASC, record_id ASC).
      const sorted = [...filtered].sort((a, b) => {
        if (a.tick !== b.tick) return a.tick - b.tick;
        return codepointCompare(a.record_id, b.record_id);
      });
      return sorted.slice(0, limit);
    },

    count(kind) {
      if (!kind) return store.records.length;
      return store.records.filter(r => r.kind === kind).length;
    },

    _resetForTest() {
      store.records.length = 0;
      store.latestInventoryByPlayer.clear();
    },
  };
}

// ───────── Replay-safe round-trip helpers ─────────

/**
 * Verify replay-safe persistence (Mục XI):
 *   write snapshot → read → re-serialize → compare byte-identical.
 */
export function verifyInventoryPersistenceRoundtrip(
  adapter: PersistenceAdapter,
  snapshot: InventorySnapshot,
): boolean {
  adapter.writeInventorySnapshot(snapshot);
  const restored = adapter.readInventorySnapshot(snapshot.player_id);
  if (!restored) return false;
  return serializeInventorySnapshot(restored) === serializeInventorySnapshot(snapshot);
}

/** Read all records of a kind for a player as deserialized form (utility). */
export function readLootDeltasForPlayer(
  adapter: PersistenceAdapter,
  player_id: string,
  tick_start?: number,
  tick_end?: number,
): LootDeltaMetadata[] {
  const q: PersistenceQuery = { kind: 'loot_delta', player_id };
  if (tick_start !== undefined) q.tick_start = tick_start;
  if (tick_end !== undefined) q.tick_end = tick_end;
  const records = adapter.query(q);
  return records.map(r => deserializeLootDelta(r.payload_json));
}

/** Read all forensic snapshots in window (utility). */
export function readForensicSnapshotsInWindow(
  adapter: PersistenceAdapter,
  tick_start: number,
  tick_end: number,
): EconomyForensicSnapshotPayload[] {
  const records = adapter.query({ kind: 'forensic_snapshot', tick_start, tick_end });
  return records.map(r => deserializeEconomyForensicSnapshot(r.payload_json));
}

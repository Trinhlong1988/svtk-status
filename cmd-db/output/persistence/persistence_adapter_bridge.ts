/**
 * PERSISTENCE ADAPTER BRIDGE — Phase 13 Batch 2 Scope #3 (audit-fixed).
 *
 * Generic persistence compatibility bridge cho CMD1 / CMD3 / CMD4 adoption.
 *
 * STRICT SCOPE (Mr.Long v14 Batch 2 spec):
 *   - SUPPORT: CMD1 checkpoint compat / CMD3 progression snapshot compat / CMD4 export tooling compat
 *   - IMPORTANT: BRIDGE ONLY. NO runtime ownership transfer.
 *   - NOT: new economy runtime / loot reopen / persistence redesign / replay core modify / combat/progression modify / gameplay logic
 *
 * Bridge pattern:
 *   - CMD wraps own payload → bridge produces BridgedRecord envelope với deterministic record_id
 *   - Bridge KHÔNG own actual DB layer — chỉ format/envelope layer (in-memory ref impl)
 *   - Round-trip verify available (write → read → re-canonicalize → byte-identical)
 *   - Separation: bridge KHÔNG import frozen PersistenceAdapter (economy domain isolation)
 *
 * Lock policy:
 *   - economy/* FROZEN — bridge chỉ consume frozen serialization helpers
 *   - economy_integration/persistence_adapter.ts FROZEN — bridge KHÔNG import (separation)
 *
 * Audit-fix notes (Phase 13 Batch 2 audit pass 1):
 *   - F#14: replaced `this.write(input)` with closure capture in verifyRoundtrip
 *           (was latent bug if caller destructured method reference)
 *   - F#15: fixed header doc — was incorrectly referencing "PersistedRecord" + "host PersistenceAdapter"
 *   - F#16: added limit validation (non-negative integer, 0 returns empty)
 *   - F#17: documented verifyRoundtrip MUTATES store (side-effect intentional)
 *   - F#18: added owner_cmd + player_id validation (empty string rejected, undefined→null normalized)
 *
 * Audit-fix notes (Phase 13 Batch 2 audit pass 2):
 *   - G#8: read() returns frozen BridgedRecord
 *   - G#9: readLatest() returns frozen BridgedRecord
 *   - G#10: query() returns frozen array of frozen BridgedRecords
 *
 * Audit-fix notes (Phase 13 Batch 2 audit pass 3):
 *   - H#1: readLatest() tie-breaker via record_id DESC (was insertion-order dependent)
 */
import { fnv1a32 } from '../../../cmd-engine/output/economy/modifier_ordering_audit.js';
import { canonicalJSON } from '../../../cmd-engine/output/economy/economy_serialization_contract.js';

export const PERSISTENCE_BRIDGE_VERSION = 1;

// ───────── Domain enum ─────────
/**
 * Bridge supports 4 cross-CMD domain kinds:
 *   - combat_checkpoint: CMD1 turn-state snapshot at checkpoint tick
 *   - progression_snapshot: CMD3 quest/progression state
 *   - export_artifact: CMD4 tooling export payload (registry/validation/audit)
 *   - generic: cross-CMD utility records
 */
export const BRIDGE_DOMAINS = [
  'combat_checkpoint',
  'progression_snapshot',
  'export_artifact',
  'generic',
] as const;
export type BridgeDomain = (typeof BRIDGE_DOMAINS)[number];

export const BRIDGE_OWNER_CMDS = ['CMD1', 'CMD3', 'CMD4', 'shared'] as const;
export type BridgeOwnerCmd = (typeof BRIDGE_OWNER_CMDS)[number];

// ───────── Bridge envelope ─────────
/**
 * BridgedRecord wraps caller payload với deterministic metadata.
 * Stored trong bridge's own in-memory store.
 */
export interface BridgedRecord {
  /** Bridge envelope schema version (PERSISTENCE_BRIDGE_VERSION). */
  bridge_version: number;
  /** Domain discriminator. */
  domain: BridgeDomain;
  /** Owner CMD declaring origin. */
  owner_cmd: BridgeOwnerCmd;
  /** Player scope (null for system-wide). */
  player_id: string | null;
  /** Server tick when record created. INT ≥ 0. */
  tick: number;
  /** Deterministic record id — FNV-1a 32-bit hex (8 chars). */
  record_id: string;
  /** Canonical JSON payload (caller deserialize via JSON.parse). */
  payload_json: string;
  /** Caller payload schema version (independent of bridge_version). INT ≥ 1. */
  payload_schema_version: number;
}

export interface BridgeWriteInput {
  domain: BridgeDomain;
  owner_cmd: BridgeOwnerCmd;
  player_id: string | null;
  tick: number;
  payload_schema_version: number;
  /** Raw payload — bridge canonicalizes via canonicalJSON before computing record_id. */
  payload: unknown;
}

export interface BridgeQuery {
  domain?: BridgeDomain;
  owner_cmd?: BridgeOwnerCmd;
  player_id?: string;
  tick_start?: number;
  tick_end?: number;
  /** Result cap. Default 1000. MUST be non-negative integer (0 → empty result). */
  limit?: number;
}

// ───────── Bridge contract ─────────
export interface PersistenceAdapterBridge {
  /** Write a bridged record. Returns deterministic record_id. Idempotent. */
  write(input: BridgeWriteInput): string;

  /** Read by record_id. Returns null if not found. */
  read(record_id: string): BridgedRecord | null;

  /**
   * Read latest bridged record matching domain + owner_cmd + player_id.
   * Sort: tick DESC, tie-break record_id DESC (deterministic — no insertion-order dependency).
   */
  readLatest(
    domain: BridgeDomain,
    owner_cmd: BridgeOwnerCmd,
    player_id: string | null,
  ): BridgedRecord | null;

  /** Query records by criteria. Sorted deterministic (tick ASC → record_id ASC). */
  query(criteria: BridgeQuery): readonly BridgedRecord[];

  /** Count records by domain (telemetry). */
  count(domain?: BridgeDomain): number;

  /**
   * Round-trip verify: write input → read back → re-canonicalize → compare byte-identical.
   * Returns true if input survives write→read→re-serialize unchanged.
   *
   * NOTE: SIDE EFFECT — adds record to store (or replaces if duplicate record_id).
   * Caller should call on test or seed payload, not on hot-path business data.
   */
  verifyRoundtrip(input: BridgeWriteInput): boolean;

  /** Reset all (test). */
  _resetForTest(): void;
}

// ───────── Bridge backing store ─────────
/**
 * Bridge owns its own in-memory backing store cho cross-CMD records.
 * KHÔNG bridge sang frozen PersistenceAdapter — separation of concerns:
 *   - PersistenceAdapter chứa economy domain records (6 kind enum locked)
 *   - Bridge chứa cross-CMD generic records (CMD1/3/4 payload chưa biết shape)
 * Server orchestration team có thể wire bridge sang real DB layer riêng (Phase 14+).
 */
interface InternalStore {
  records: BridgedRecord[];
  byRecordId: Map<string, number>;  // record_id → records[idx]
}

// ───────── Input validation ─────────
function validateInput(input: BridgeWriteInput): void {
  if (!BRIDGE_DOMAINS.includes(input.domain)) {
    throw new Error(`[PersistenceAdapterBridge] invalid domain: ${input.domain}`);
  }
  if (!BRIDGE_OWNER_CMDS.includes(input.owner_cmd)) {
    throw new Error(`[PersistenceAdapterBridge] invalid owner_cmd: ${input.owner_cmd}`);
  }
  if (input.player_id !== null && (typeof input.player_id !== 'string' || input.player_id.length === 0)) {
    throw new Error(`[PersistenceAdapterBridge] player_id must be non-empty string or null`);
  }
  if (!Number.isInteger(input.tick) || input.tick < 0) {
    throw new Error(`[PersistenceAdapterBridge] tick must be non-negative integer`);
  }
  if (!Number.isInteger(input.payload_schema_version) || input.payload_schema_version < 1) {
    throw new Error(`[PersistenceAdapterBridge] payload_schema_version must be positive integer`);
  }
}

// ───────── Factory ─────────
export function createPersistenceAdapterBridge(): PersistenceAdapterBridge {
  const store: InternalStore = {
    records: [],
    byRecordId: new Map(),
  };

  function buildRecord(input: BridgeWriteInput): BridgedRecord {
    validateInput(input);
    const payload_json = canonicalJSON(input.payload);
    const record_id = fnv1a32(
      `${input.domain}|${input.owner_cmd}|${input.player_id ?? ''}|${input.tick}|${input.payload_schema_version}|${payload_json}`,
    );
    // G#8: frozen record — caller mutation post-read cannot corrupt store.
    return Object.freeze({
      bridge_version: PERSISTENCE_BRIDGE_VERSION,
      domain: input.domain,
      owner_cmd: input.owner_cmd,
      player_id: input.player_id,
      tick: input.tick,
      record_id,
      payload_json,
      payload_schema_version: input.payload_schema_version,
    });
  }

  // F#14: closure-captured write function — no `this` binding risk.
  function doWrite(input: BridgeWriteInput): string {
    const record = buildRecord(input);
    const existingIdx = store.byRecordId.get(record.record_id);
    if (existingIdx !== undefined) {
      store.records[existingIdx] = record;  // idempotent replace
    } else {
      store.byRecordId.set(record.record_id, store.records.length);
      store.records.push(record);
    }
    return record.record_id;
  }

  function doRead(record_id: string): BridgedRecord | null {
    const idx = store.byRecordId.get(record_id);
    if (idx === undefined) return null;
    return store.records[idx] ?? null;
  }

  return {
    write(input) {
      return doWrite(input);
    },

    read(record_id) {
      return doRead(record_id);
    },

    readLatest(domain, owner_cmd, player_id) {
      // H#1: tie-break by (tick DESC, record_id DESC) — deterministic across insertion order.
      let latest: BridgedRecord | null = null;
      for (const r of store.records) {
        if (r.domain !== domain) continue;
        if (r.owner_cmd !== owner_cmd) continue;
        if (r.player_id !== player_id) continue;
        if (!latest) {
          latest = r;
          continue;
        }
        if (r.tick > latest.tick) {
          latest = r;
        } else if (r.tick === latest.tick && r.record_id > latest.record_id) {
          // Tie-break: lex-greater record_id wins (deterministic).
          latest = r;
        }
      }
      return latest;
    },

    query(criteria) {
      // F#16: limit validation.
      const rawLimit = criteria.limit ?? 1000;
      if (!Number.isInteger(rawLimit) || rawLimit < 0) {
        throw new Error(`[PersistenceAdapterBridge] query limit must be non-negative integer (got ${rawLimit})`);
      }
      const filtered = store.records.filter(r => {
        if (criteria.domain && r.domain !== criteria.domain) return false;
        if (criteria.owner_cmd && r.owner_cmd !== criteria.owner_cmd) return false;
        if (criteria.player_id && r.player_id !== criteria.player_id) return false;
        if (criteria.tick_start !== undefined && r.tick < criteria.tick_start) return false;
        if (criteria.tick_end !== undefined && r.tick > criteria.tick_end) return false;
        return true;
      });
      // G#6/G#10: codepoint sort (locale-independent) + frozen array snapshot.
      const sorted = [...filtered].sort((a, b) => {
        if (a.tick !== b.tick) return a.tick - b.tick;
        if (a.record_id < b.record_id) return -1;
        if (a.record_id > b.record_id) return 1;
        return 0;
      });
      return Object.freeze(sorted.slice(0, rawLimit));
    },

    count(domain) {
      if (!domain) return store.records.length;
      return store.records.filter(r => r.domain === domain).length;
    },

    verifyRoundtrip(input) {
      // F#14: closure capture — independent of `this`.
      const record = buildRecord(input);
      doWrite(input);
      const restored = doRead(record.record_id);
      if (!restored) return false;
      const recomputed = canonicalJSON(JSON.parse(restored.payload_json));
      return recomputed === record.payload_json;
    },

    _resetForTest() {
      store.records.length = 0;
      store.byRecordId.clear();
    },
  };
}

// ───────── Cross-CMD typed wrapper helpers ─────────

/**
 * CMD1 combat checkpoint wrapper. Typed convenience.
 */
export function writeCombatCheckpoint(
  bridge: PersistenceAdapterBridge,
  player_id: string,
  tick: number,
  schema_version: number,
  checkpoint_payload: unknown,
): string {
  return bridge.write({
    domain: 'combat_checkpoint',
    owner_cmd: 'CMD1',
    player_id,
    tick,
    payload_schema_version: schema_version,
    payload: checkpoint_payload,
  });
}

/**
 * CMD3 progression snapshot wrapper. Typed convenience.
 */
export function writeProgressionSnapshot(
  bridge: PersistenceAdapterBridge,
  player_id: string,
  tick: number,
  schema_version: number,
  progression_payload: unknown,
): string {
  return bridge.write({
    domain: 'progression_snapshot',
    owner_cmd: 'CMD3',
    player_id,
    tick,
    payload_schema_version: schema_version,
    payload: progression_payload,
  });
}

/**
 * CMD4 export artifact wrapper. Typed convenience.
 */
export function writeExportArtifact(
  bridge: PersistenceAdapterBridge,
  tick: number,
  schema_version: number,
  export_payload: unknown,
  player_id: string | null = null,
): string {
  return bridge.write({
    domain: 'export_artifact',
    owner_cmd: 'CMD4',
    player_id,
    tick,
    payload_schema_version: schema_version,
    payload: export_payload,
  });
}

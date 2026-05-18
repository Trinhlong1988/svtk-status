/**
 * TELEMETRY — server-side logging (R14 — Telemetry First).
 *
 * "Không có telemetry = balance bằng cảm giác."
 *
 * 6 log type BẮT BUỘC (mục 7E CLAUDE.md):
 *   - DPS log
 *   - death log
 *   - skill usage
 *   - boss wipe reason
 *   - economy flow
 *   - PvP winrate
 *
 * Mode:
 *   - MVP: append-only JSONL file
 *   - Production: stream → PostgreSQL `telemetry_*` table + S3 cold archive
 *
 * Layer 3 SIMULATION (server-side). KHÔNG client-side.
 */
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CombatEvent } from '../legacy/event_bus.js';
import { EventBus } from '../legacy/event_bus.js';
import { currentClock } from '../legacy/deterministic_clock.js';

export type TelemetryCategory =
  | 'dps'
  | 'death'
  | 'skill_usage'
  | 'boss_wipe'
  | 'economy_flow'
  | 'pvp_winrate'
  | 'anomaly';

export interface TelemetryRecord {
  timestamp: string;       // ISO 8601
  category: TelemetryCategory;
  encounterId?: string;
  turn?: number;
  playerId?: string;
  data: Record<string, unknown>;
}

export interface TelemetryStore {
  write(record: TelemetryRecord): void;
  flush?(): Promise<void>;
}

// ─────────────────────────────────────────────────────────
// FIX #6 — TELEMETRY PREPARATION (interfaces only, no impl)
// Mr.Long instruction: "Prepare interfaces only. NO S3 / Redis / networking impl."
// Module 10 Network sẽ implement concrete RollingFlushStore + S3 stream archive.
// ─────────────────────────────────────────────────────────

/** Rolling flush behavior — flush buffer mỗi N second hoặc M record (whichever first). */
export interface RollingFlushConfig {
  flushIntervalMs: number;     // default 10_000 (10s)
  flushBatchSize: number;      // default 1000 record
}

/** Chunk writer rotation — close + rotate file mỗi N bytes. */
export interface ChunkWriterConfig {
  chunkMaxBytes: number;       // default 10 * 1024 * 1024 (10MB)
  chunkPathPattern: string;    // vd 'telemetry.{timestamp}.jsonl'
}

/** Sampling rate per category (anti-flood). */
export interface SamplingConfig {
  rates: Partial<Record<TelemetryCategory, number>>;   // 0..1, vd { dps: 0.05, anomaly: 1.0 }
}

/** Async archive — gzip stream + upload to cold storage. */
export interface AsyncArchiveConfig {
  archiveAfterMs: number;      // default 60_000 (1 min after rotation)
  destination: 'local_gz' | 's3' | 'b2' | 'wasabi';
  retentionDays: number;       // default 90
}

/** Composite production-grade store interface (Module 10 implements). */
export interface ProductionTelemetryStore extends TelemetryStore {
  rollingFlush?: RollingFlushConfig;
  chunkWriter?: ChunkWriterConfig;
  sampling?: SamplingConfig;
  asyncArchive?: AsyncArchiveConfig;
}

/**
 * JSONL file-based store (MVP).
 * Append-only, line per record, never overwrite.
 */
export class JsonlStore implements TelemetryStore {
  private readonly path: string;

  constructor(logDir: string, fileName: string = 'telemetry.jsonl') {
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    this.path = join(logDir, fileName);
  }

  write(record: TelemetryRecord): void {
    appendFileSync(this.path, JSON.stringify(record) + '\n', 'utf8');
  }
}

/**
 * In-memory store (test only).
 */
export class MemoryStore implements TelemetryStore {
  records: TelemetryRecord[] = [];
  write(record: TelemetryRecord): void {
    this.records.push(record);
  }
  clear(): void {
    this.records = [];
  }
}

/**
 * Telemetry recorder — tap EventBus, transform events → telemetry records.
 *
 * Usage:
 *   const bus = new EventBus();
 *   const telemetry = new Telemetry(new JsonlStore('./logs'));
 *   telemetry.attach(bus, { encounterId: 'enc_001' });
 */
export class Telemetry {
  constructor(private readonly store: TelemetryStore) {}

  /** Attach to EventBus — auto-record all events. */
  attach(bus: EventBus, ctx: { encounterId: string }): () => void {
    const unsubscribe = bus.on('*', (event) => this.recordEvent(event, ctx));
    return unsubscribe;
  }

  private recordEvent(event: CombatEvent, ctx: { encounterId: string }): void {
    const ts = currentClock().nowIso();
    const base = { timestamp: ts, encounterId: ctx.encounterId, turn: (event as { turn?: number }).turn };

    // Map event type → telemetry category
    if (event.type === 'hit' || event.type === 'dot_tick') {
      this.store.write({
        ...base,
        category: 'dps',
        playerId: 'casterId' in event ? event.casterId : undefined,
        data: { ...event },
      });
    } else if (event.type === 'death') {
      this.store.write({
        ...base,
        category: 'death',
        playerId: event.victimId,
        data: { killerId: event.killerId },
      });
    } else if (event.type === 'cast') {
      this.store.write({
        ...base,
        category: 'skill_usage',
        playerId: event.casterId,
        data: { skillId: event.skillId, targetId: event.targetId },
      });
    }
    // Other categories (economy_flow, pvp_winrate) emit từ subsystem khác, không qua EventBus combat.
  }

  /** Direct write — cho subsystem ngoài combat (economy, PvP rank). */
  writeRecord(record: TelemetryRecord): void {
    this.store.write(record);
  }
}

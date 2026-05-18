/**
 * THREAT SERVICE — Layer 3 STATEFUL.
 *
 * Owns ThreatTable per encounter. Wraps Layer 2 pure helpers (`src/logic/threat.ts`).
 *
 * Scope (Phase 0/1 skeleton):
 *   - Lifecycle methods: getOrCreate / endEncounter
 *   - addThreat — gọi pure `calcThreatDelta` rồi accumulate vào entry
 *   - decayAll — gọi pure `decayValue` cho mọi entry
 *   - decideTarget — STUB, full 5-mech implementation ở Module 4 (spec/06_THREAT_SYSTEM.md)
 *
 * KHÔNG implement target memory / spike / forced / anti-heal-aggro priority ở đây —
 * Module 4 sẽ điền theo spec đã chốt.
 */
import {
  calcThreatDelta,
  decayValue,
  type ThreatAction,
} from '../legacy/threat.js';

export interface ThreatEntry {
  attackerId: string;
  threat: number;
  lastActionTurn: number;
  spikeUntilTurn?: number;
  forcedUntilTurn?: number;
}

/**
 * Per-encounter threat table. Mutable state owned by Layer 3 service.
 *
 * Serializable: entries Map → Object cho replay snapshot.
 */
export class ThreatTable {
  private entries = new Map<string, ThreatEntry>();
  private targetMemory: string[] = [];
  readonly memorySize: number;

  constructor(memorySize: number = 5) {
    this.memorySize = memorySize;
  }

  /** Get entry — create empty nếu chưa có. */
  getOrCreate(attackerId: string, currentTurn: number): ThreatEntry {
    let e = this.entries.get(attackerId);
    if (!e) {
      e = { attackerId, threat: 0, lastActionTurn: currentTurn };
      this.entries.set(attackerId, e);
    }
    return e;
  }

  /** Read-only access cho test / decideTarget Module 4. */
  getEntry(attackerId: string): Readonly<ThreatEntry> | undefined {
    return this.entries.get(attackerId);
  }

  /** All entries — read-only iteration. */
  allEntries(): readonly Readonly<ThreatEntry>[] {
    return [...this.entries.values()];
  }

  /** Target memory (FIFO) — read-only. */
  getMemory(): readonly string[] {
    return [...this.targetMemory];
  }

  /** Push target to memory FIFO. */
  pushMemory(targetId: string): void {
    if (this.targetMemory[this.targetMemory.length - 1] === targetId) return;
    this.targetMemory.push(targetId);
    if (this.targetMemory.length > this.memorySize) this.targetMemory.shift();
  }

  /** Reset state (end of encounter, test setup). */
  clear(): void {
    this.entries.clear();
    this.targetMemory = [];
  }

  /** Serialize cho replay snapshot. */
  serialize(): { entries: ThreatEntry[]; memory: string[] } {
    return {
      entries: this.allEntries().map((e) => ({ ...e })),
      memory: this.getMemory().slice(),
    };
  }

  /** Restore từ snapshot. */
  static deserialize(snap: { entries: ThreatEntry[]; memory: string[] }, memorySize: number = 5): ThreatTable {
    const tbl = new ThreatTable(memorySize);
    for (const e of snap.entries) tbl.entries.set(e.attackerId, { ...e });
    tbl.targetMemory = snap.memory.slice();
    return tbl;
  }
}

/**
 * Service hub — manages ThreatTable per encounter.
 *
 * decideTarget() is a STUB — full 5-mech logic implements ở Module 4.
 */
export class ThreatService {
  private tables = new Map<string, ThreatTable>();

  /** Tạo / lấy table cho encounter. */
  getOrCreate(encounterId: string): ThreatTable {
    let tbl = this.tables.get(encounterId);
    if (!tbl) {
      tbl = new ThreatTable();
      this.tables.set(encounterId, tbl);
    }
    return tbl;
  }

  /**
   * Apply action threat — wrap Layer 2 pure `calcThreatDelta`.
   * INT BP fixed-point (CLAUDE.md mục 14, R30): coef + roleMod expressed BP.
   */
  addThreat(
    encounterId: string,
    attackerId: string,
    action: ThreatAction,
    currentTurn: number,
    coefBP: number,
    roleModBP: number,
  ): number {
    const tbl = this.getOrCreate(encounterId);
    const entry = tbl.getOrCreate(attackerId, currentTurn);
    const delta = calcThreatDelta(action.amount, coefBP, roleModBP);
    entry.threat += delta;
    entry.lastActionTurn = currentTurn;

    if (action.type === 'damage' && action.isCrit) {
      entry.spikeUntilTurn = currentTurn + 2;
    }
    if (action.type === 'taunt') {
      entry.forcedUntilTurn = currentTurn + (action.tauntDuration ?? 2);
    }
    return delta;
  }

  /**
   * Decay tick all entries — wrap Layer 2 pure `decayValue`.
   * INT BP: decayBP (500 = 5%/turn).
   */
  decayAll(encounterId: string, currentTurn: number, decayBP: number): void {
    const tbl = this.tables.get(encounterId);
    if (!tbl) return;
    for (const entry of tbl.allEntries()) {
      const mutable = entry as ThreatEntry;
      mutable.threat = decayValue(mutable.threat, decayBP);
      if (mutable.spikeUntilTurn !== undefined && currentTurn > mutable.spikeUntilTurn) {
        mutable.spikeUntilTurn = undefined;
      }
      if (mutable.forcedUntilTurn !== undefined && currentTurn > mutable.forcedUntilTurn) {
        mutable.forcedUntilTurn = undefined;
      }
    }
  }

  /**
   * STUB — Module 4 implement đầy đủ 5 mech theo spec/06_THREAT_SYSTEM.md §II.
   * Phase 0/1: trả null hoặc top-threat đơn giản chỉ để integration test compile.
   */
  decideTarget(encounterId: string): string | null {
    const tbl = this.tables.get(encounterId);
    if (!tbl) return null;
    const entries = tbl.allEntries();
    if (entries.length === 0) return null;
    let topId: string | null = null;
    let topVal = -Infinity;
    for (const e of entries) {
      if (e.threat > topVal) {
        topVal = e.threat;
        topId = e.attackerId;
      }
    }
    return topId;
  }

  /** Cleanup encounter. */
  endEncounter(encounterId: string): void {
    this.tables.delete(encounterId);
  }
}

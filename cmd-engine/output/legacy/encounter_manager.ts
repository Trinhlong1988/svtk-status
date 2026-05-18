/**
 * ENCOUNTER MANAGER — combat session lifecycle (FIX PHASE 4 #1 CRITICAL).
 *
 * Owns ThreatEngineState per encounterId. Provides:
 *   - enter combat
 *   - leave combat (single entity)
 *   - wipe reset (party fully dead)
 *   - leash reset (boss far from origin)
 *   - boss disengage (no action N turn)
 *   - combat session boundary snapshot (for replay/recovery)
 *
 * Stateful — caller (server orchestration) holds 1 instance per encounterId
 * OR a registry-style EncounterRegistry. Pure logic — no I/O.
 */
import {
  createThreatEngineState,
  endThreatEncounter,
  snapshotEngine,
  restoreEngine,
  dropFromEngine,
  type ThreatEngineState,
} from './threat_engine.js';
import { ThreatConstants } from './threat_constants.js';

export type EncounterState = 'idle' | 'active' | 'wipe' | 'leashed' | 'disengaged' | 'ended';

export interface EncounterSnapshot {
  encounterId: string;
  state: EncounterState;
  startedAtTurn: number;
  endedAtTurn?: number;
  participantsAlive: string[];
  bossId?: string;
  threat: ReturnType<typeof snapshotEngine>;
}

export interface EncounterContext {
  /** Boss entity id (or undefined for non-boss encounter). */
  bossId?: string;
  /** Boss origin coordinate (for leash check). undefined = no leash check. */
  bossOriginDistance?: number;
  /** Last action turn (for disengage detection). */
  lastBossActionTurn?: number;
  /** Currently alive attackers in encounter. */
  aliveAttackers: Set<string>;
  /** Caller-provided per-attacker distance map (for leash). */
  attackerDistance?: Map<string, number>;
}

export class EncounterManager {
  readonly encounterId: string;
  readonly threat: ThreatEngineState;
  state: EncounterState = 'idle';
  startedAtTurn = 0;
  endedAtTurn?: number;
  context: EncounterContext = { aliveAttackers: new Set() };

  constructor(encounterId: string) {
    this.encounterId = encounterId;
    this.threat = createThreatEngineState(encounterId);
  }

  /** Enter combat — set state active, record start turn. */
  enterCombat(currentTurn: number, bossId?: string): void {
    this.state = 'active';
    this.startedAtTurn = currentTurn;
    if (bossId) this.context.bossId = bossId;
  }

  /** Mark attacker alive (joined). */
  addParticipant(attackerId: string): void {
    this.context.aliveAttackers.add(attackerId);
  }

  /** Mark attacker dead/left — drops from threat table per FIX #3. */
  removeParticipant(attackerId: string, reason: 'death' | 'disconnect' | 'leave'): boolean {
    const inSet = this.context.aliveAttackers.delete(attackerId);
    if (inSet) dropFromEngine(this.threat, attackerId);
    void reason;     // reserved for telemetry caller
    return inSet;
  }

  /** Wipe detection — all participants dead → wipe state. */
  detectWipe(currentTurn: number): boolean {
    if (this.state !== 'active') return false;
    if (this.context.aliveAttackers.size === 0) {
      this.state = 'wipe';
      this.endedAtTurn = currentTurn;
      return true;
    }
    return false;
  }

  /** Leash check — boss far from origin → reset. */
  detectLeash(): boolean {
    if (this.state !== 'active') return false;
    if (this.context.bossOriginDistance === undefined) return false;
    if (this.context.bossOriginDistance > ThreatConstants.ENCOUNTER_LEASH_DISTANCE) {
      this.state = 'leashed';
      return true;
    }
    return false;
  }

  /** Disengage check — boss inactive for N turn. */
  detectDisengage(currentTurn: number): boolean {
    if (this.state !== 'active') return false;
    if (this.context.lastBossActionTurn === undefined) return false;
    const idle = currentTurn - this.context.lastBossActionTurn;
    if (idle >= ThreatConstants.ENCOUNTER_DISENGAGE_TURNS) {
      this.state = 'disengaged';
      return true;
    }
    return false;
  }

  /** Reset encounter (after wipe/leash/disengage). Clears threat + state. */
  reset(currentTurn: number): { entriesRemoved: number } {
    const r = endThreatEncounter(this.threat);
    this.state = 'idle';
    this.endedAtTurn = currentTurn;
    this.context.aliveAttackers.clear();
    this.context.lastBossActionTurn = undefined;
    return r;
  }

  /** End encounter (boss killed / quest complete). */
  end(currentTurn: number): void {
    this.state = 'ended';
    this.endedAtTurn = currentTurn;
  }

  /** Snapshot full encounter state — replay/reconnect recovery. */
  snapshot(): EncounterSnapshot {
    return {
      encounterId: this.encounterId,
      state: this.state,
      startedAtTurn: this.startedAtTurn,
      endedAtTurn: this.endedAtTurn,
      participantsAlive: [...this.context.aliveAttackers].sort(),
      bossId: this.context.bossId,
      threat: snapshotEngine(this.threat),
    };
  }

  /** Restore from snapshot. Returns new manager instance. */
  static fromSnapshot(snap: EncounterSnapshot): EncounterManager {
    const mgr = new EncounterManager(snap.encounterId);
    mgr.state = snap.state;
    mgr.startedAtTurn = snap.startedAtTurn;
    mgr.endedAtTurn = snap.endedAtTurn;
    mgr.context.aliveAttackers = new Set(snap.participantsAlive);
    mgr.context.bossId = snap.bossId;
    const restored = restoreEngine(snap.threat);
    mgr.threat.table = restored.table;
    mgr.threat.taunt = restored.taunt;
    mgr.threat.currentTargetId = restored.currentTargetId;
    return mgr;
  }
}

/** Registry of EncounterManager per encounterId. */
export class EncounterRegistry {
  private managers = new Map<string, EncounterManager>();

  getOrCreate(encounterId: string): EncounterManager {
    let m = this.managers.get(encounterId);
    if (!m) {
      m = new EncounterManager(encounterId);
      this.managers.set(encounterId, m);
    }
    return m;
  }

  get(encounterId: string): EncounterManager | undefined {
    return this.managers.get(encounterId);
  }

  /** Cleanup — caller invoke after encounter persisted to replay. */
  drop(encounterId: string): boolean {
    return this.managers.delete(encounterId);
  }

  size(): number {
    return this.managers.size;
  }

  _reset(): void {
    this.managers.clear();
  }
}

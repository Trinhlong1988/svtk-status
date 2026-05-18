/**
 * ACTION LOCK — deterministic immutable lock (FIX PHASE 3 § VII).
 *
 * Player selects action → lock → server resolves.
 * After lock, action CANNOT be edited. Replay-safe.
 *
 * Lock storage: per-turn, per-team, per-actor. Server collects all locks before
 * resolve phase begins.
 *
 * Anti-cheat: lock writes timestamp + actor signature (server records); replay
 * verifies all locks present before turn resolve.
 */
import type { TurnAction } from './turn_action.js';
import { currentClock, type DeterministicClock } from './deterministic_clock.js';

export interface LockedAction {
  /** Sealed action — caller MUST NOT mutate after lock. */
  readonly action: TurnAction;
  /** Server lock timestamp ISO. */
  readonly lockedAt: string;
  /** Lock sequence within turn (anti-replay). */
  readonly lockSeq: number;
}

export class ActionLockError extends Error {
  constructor(
    public readonly code: 'already_locked' | 'wrong_turn' | 'no_lock_found',
    public readonly actorId: string,
    public readonly turn: number,
  ) {
    super(`[ActionLock] code=${code} actor=${actorId} turn=${turn}`);
    this.name = 'ActionLockError';
  }
}

/**
 * Per-turn lock manager. Caller (encounter manager) creates 1 instance per turn,
 * collects locks from each entity, then `seal()` to freeze + iterate for resolve.
 */
export class TurnLockManager {
  private locks = new Map<string, LockedAction>();    // actorId → LockedAction
  private sealed = false;
  private nextSeq = 0;

  constructor(public readonly turn: number) {}

  /**
   * Lock action for actor. Throws if actor already locked or sealed.
   */
  lock(action: TurnAction, lockedAt?: string, clock?: DeterministicClock): LockedAction {
    if (this.sealed) throw new ActionLockError('wrong_turn', action.actorEntityId, this.turn);
    if (action.submittedTurn !== this.turn) {
      throw new ActionLockError('wrong_turn', action.actorEntityId, this.turn);
    }
    if (this.locks.has(action.actorEntityId)) {
      throw new ActionLockError('already_locked', action.actorEntityId, this.turn);
    }
    const resolvedLockedAt = lockedAt ?? (clock ?? currentClock()).nowIso();
    const locked: LockedAction = {
      action: Object.freeze({ ...action }),     // shallow freeze — replay-safe
      lockedAt: resolvedLockedAt,
      lockSeq: this.nextSeq++,
    };
    this.locks.set(action.actorEntityId, locked);
    return locked;
  }

  /** Get lock by actor. Returns undefined if not locked. */
  getLock(actorId: string): LockedAction | undefined {
    return this.locks.get(actorId);
  }

  /** Has actor locked? */
  hasLock(actorId: string): boolean {
    return this.locks.has(actorId);
  }

  /** Count of locked actions. */
  count(): number {
    return this.locks.size;
  }

  /**
   * Seal manager — no further locks accepted. Returns ordered lock list
   * (sorted by lockSeq for replay determinism).
   */
  seal(): readonly LockedAction[] {
    this.sealed = true;
    const arr = [...this.locks.values()];
    arr.sort((a, b) => a.lockSeq - b.lockSeq);
    return arr;
  }

  isSealed(): boolean {
    return this.sealed;
  }
}

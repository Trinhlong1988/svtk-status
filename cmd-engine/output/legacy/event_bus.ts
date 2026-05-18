/**
 * EVENT BUS — central pub/sub cho mọi combat event (5-phase priority).
 *
 * 5 phase chạy theo thứ tự cứng:
 *   1. pre_validate  — anti-cheat / sanity check, có thể CANCEL event (return false)
 *   2. pre_resolve   — modifier listener, có thể MUTATE payload (return partial event)
 *   3. resolve       — combat logic chính, event frozen read-only
 *   4. post_resolve  — passive trigger (afterCast/afterHit/onDeath), event frozen
 *   5. post_log      — telemetry tap / replay recorder, event frozen
 *
 * Spec: CLAUDE.md mục 7G.
 *
 * Deterministic:
 *   - Sync emit (no async race)
 *   - Intra-phase order: priority lower → first; cùng priority → registration order (FIFO)
 *   - Mutated event mỗi pre_resolve listener clone (không in-place)
 *   - resolve/post_* nhận Object.freeze(...) — listener không mutate
 */
import type { CombatChar } from './types.js';
import { deepFreeze } from './deep_freeze.js';

// ───────── Event types (typed discriminated union) ─────────
export type CombatEvent =
  | { type: 'cast'; turn: number; casterId: string; skillId: string; targetId: string }
  | { type: 'hit'; turn: number; casterId: string; targetId: string; damage: number; isCrit: boolean }
  | { type: 'miss'; turn: number; casterId: string; targetId: string; reason: 'dodge' | 'accuracy' }
  | { type: 'heal'; turn: number; casterId: string; targetId: string; heal: number }
  | { type: 'effect_applied'; turn: number; targetId: string; effectType: string; duration: number }
  | { type: 'effect_expired'; turn: number; targetId: string; effectType: string }
  | { type: 'dot_tick'; turn: number; targetId: string; effectType: string; damage: number }
  | { type: 'hot_tick'; turn: number; targetId: string; effectType: string; heal: number }
  | { type: 'cc_applied'; turn: number; targetId: string; ccType: string; duration: number }
  | { type: 'cc_expired'; turn: number; targetId: string; ccType: string }
  | { type: 'threat_change'; turn: number; targetId: string; casterId: string; delta: number }
  | { type: 'shield_break'; turn: number; targetId: string }
  | { type: 'death'; turn: number; victimId: string; killerId: string }
  | { type: 'revive'; turn: number; targetId: string; reviverId: string }
  | { type: 'phase_change'; turn: number; bossId: string; fromPhase: number; toPhase: number }
  | { type: 'enrage'; turn: number; bossId: string }
  | { type: 'mana_drain'; turn: number; targetId: string; amount: number }
  | { type: 'cast_failed'; turn: number; casterId: string; reason: string };

export type CombatEventType = CombatEvent['type'];

/** Narrow CombatEvent to a specific variant by its `type` literal. */
export type EventOfType<K extends CombatEventType> = Extract<CombatEvent, { type: K }>;

// ───────── Phase + listener ─────────

export type EventPhase =
  | 'pre_validate'
  | 'pre_resolve'
  | 'resolve'
  | 'post_resolve'
  | 'post_log';

/**
 * Listener return contract per phase (runtime-enforced, return type is `unknown`
 * to keep ergonomic listeners — TS strict would reject `() => count++` otherwise):
 *
 *   - pre_validate: return `false` → cancel event; bất kỳ giá trị khác = continue
 *   - pre_resolve : return object (Partial<T>) → merged vào event (clone, không in-place); else no-op
 *   - resolve / post_resolve / post_log: return value IGNORED (event frozen)
 */
export type EventListener<T extends CombatEvent = CombatEvent> = (
  event: Readonly<T>,
) => unknown;

export interface ListenerOptions {
  /** Bắt buộc khai báo phase. Default = `post_log` nếu omit. */
  phase?: EventPhase;
  /** Tie-break trong cùng phase (lower = first). Default 0. */
  priority?: number;
}

export interface EmitResult<T extends CombatEvent = CombatEvent> {
  cancelled: boolean;
  finalEvent: Readonly<T>;
}

// Internal storage shape
interface Registration {
  type: CombatEventType | '*';
  phase: EventPhase;
  priority: number;
  order: number;
  listener: EventListener;
}

const PHASE_ORDER: readonly EventPhase[] = [
  'pre_validate',
  'pre_resolve',
  'resolve',
  'post_resolve',
  'post_log',
];

/**
 * Default max recursive emit depth — chống infinite loop khi listener emit event mới
 * trong post_resolve phase. Vd `onDeath → emit revive → onRevive → emit ...`.
 * Configurable per-encounter qua constructor.
 *
 * (FIX #3 — EVENT CHAIN DEPTH GUARD per SVTK.docx Phase 1 hardening.)
 */
export const DEFAULT_MAX_EMIT_DEPTH = 32;

/**
 * Whitelist các field được phép mutate ở pre_resolve phase (FIX #2 IMMUTABLE EVENT MUTATION).
 * Listener pre_resolve return Partial<Event> — CHỈ field nằm trong whitelist này được merge.
 * Mọi field khác → throw error (data integrity protection, replay-safe).
 *
 * Forbidden (cứng): type / casterId / targetId / turn / encounterId / victimId / killerId / skillId / reason.
 * Allowed: damage / heal / duration / delta / amount / isCrit / effectType / ccType / fromPhase / toPhase.
 */
export const ALLOWED_MUTATION_FIELDS: readonly string[] = [
  'damage',
  'heal',
  'duration',
  'delta',
  'amount',
  'isCrit',
  'effectType',
  'ccType',
  'fromPhase',
  'toPhase',
];

/**
 * Priority groups (FIX #5 EVENT PRIORITY GROUP) — namespaced offsets to avoid raw
 * numeric collision at scale. Listener priority = group_offset + intra_offset.
 *
 * Order: anti_cheat (0-999) → combat (1000-1999) → passive (2000-2999) → ai (3000-3999)
 *      → telemetry (4000-4999) → modding/plugin (5000-5999) → GM tools (6000-6999).
 */
export const EVENT_PRIORITY_GROUPS = {
  anti_cheat: 0,
  combat: 1000,
  passive: 2000,
  ai: 3000,
  telemetry: 4000,
  modding: 5000,
  gm: 6000,
} as const;
export type EventPriorityGroup = keyof typeof EVENT_PRIORITY_GROUPS;

/** Reserved offset range per group. */
export const PRIORITY_RANGE_SIZE = 1000;

export class PriorityCollisionError extends Error {
  constructor(public readonly priority: number, public readonly conflictWith: string) {
    super(`Priority collision at ${priority}: already registered by '${conflictWith}'`);
    this.name = 'PriorityCollisionError';
  }
}

/** Compose namespaced priority. Vd: makePriority('combat', 5) = 1005. Throws if offset ≥ range. */
export function makePriority(group: EventPriorityGroup, offset: number = 0): number {
  if (offset < 0 || offset >= PRIORITY_RANGE_SIZE) {
    throw new Error(`makePriority offset ${offset} out of range [0, ${PRIORITY_RANGE_SIZE}) for group '${group}'`);
  }
  return EVENT_PRIORITY_GROUPS[group] + offset;
}

/**
 * EventBus — singleton per encounter (không global).
 * Mỗi encounter có 1 bus riêng để replay/test deterministic.
 *
 * Hardening:
 *  - Emit depth limit (default 32) — chống infinite recursion via listener.emit chains
 *  - pre_resolve mutation guard — listener KHÔNG được đổi `type` field hoặc `turn` field
 *  - resolve / post_* event Object.freeze — listener KHÔNG mutate được
 */
export class EventBus {
  private regs: Registration[] = [];
  private orderCounter = 0;
  private buffer: CombatEvent[] = [];
  private emitDepth = 0;
  /** Per-event-type emit count tracking (FIX #3 hardening). */
  private emitTypeStack: string[] = [];
  /** Inject Zod validator (FIX #2 hardening) — called after pre_resolve merge. */
  zodValidate?: (event: CombatEvent) => void;
  readonly maxEmitDepth: number;

  constructor(opts: { maxEmitDepth?: number; zodValidate?: (e: CombatEvent) => void } = {}) {
    this.maxEmitDepth = opts.maxEmitDepth ?? DEFAULT_MAX_EMIT_DEPTH;
    if (opts.zodValidate) this.zodValidate = opts.zodValidate;
  }

  /** FIX #3 — chain path trace (parent→child event types) for debugging. */
  getCurrentChainPath(): readonly string[] {
    return [...this.emitTypeStack];
  }

  /**
   * Subscribe listener cho 1 event type hoặc `'*'` (all events).
   *
   * Generic overload narrows event variant theo `type` literal:
   *   bus.on('cast', e => e.skillId)  → e: Readonly<EventOfType<'cast'>>
   *
   * @returns unsubscribe function
   */
  on(type: '*', listener: EventListener<CombatEvent>, opts?: ListenerOptions): () => void;
  on<K extends CombatEventType>(
    type: K,
    listener: EventListener<EventOfType<K>>,
    opts?: ListenerOptions,
  ): () => void;
  on(
    type: CombatEventType | '*',
    listener: EventListener,
    opts: ListenerOptions = {},
  ): () => void {
    const reg: Registration = {
      type,
      phase: opts.phase ?? 'post_log',
      priority: opts.priority ?? 0,
      order: this.orderCounter++,
      listener,
    };
    this.regs.push(reg);
    return () => {
      const idx = this.regs.indexOf(reg);
      if (idx >= 0) this.regs.splice(idx, 1);
    };
  }

  /**
   * Emit event — sync, deterministic order.
   *
   * Chạy 5 phase tuần tự. Listener intra-phase sort theo (priority asc, order asc).
   * Buffer chỉ append finalEvent (sau pre_resolve mutation).
   *
   * Hardening:
   *  - Throws nếu emit depth ≥ maxEmitDepth (chống infinite loop)
   *  - Throws nếu pre_resolve listener đổi `type` hoặc `turn` field (data integrity)
   *  - resolve/post_* nhận Object.freeze event — runtime mutate sẽ throw strict mode
   */
  emit<T extends CombatEvent>(event: T): EmitResult<T> {
    if (this.emitDepth >= this.maxEmitDepth) {
      const chainPath = [...this.emitTypeStack, event.type].join('→');
      throw new Error(
        `EventBus emit depth exceeded ${this.maxEmitDepth} — possible infinite loop ` +
        `(event.type=${event.type}, chain_path=${chainPath}). Check post_resolve listeners for cyclic emits.`,
      );
    }
    this.emitDepth++;
    this.emitTypeStack.push(event.type);
    try {
      return this.emitInternal(event);
    } finally {
      this.emitDepth--;
      this.emitTypeStack.pop();
    }
  }

  private emitInternal<T extends CombatEvent>(event: T): EmitResult<T> {
    let cancelled = false;
    let mutableEvent: T = event;
    const originalType = (event as { type: string }).type;
    const originalTurn = (event as { turn?: number }).turn;

    for (const phase of PHASE_ORDER) {
      if (cancelled) break;

      const matched = this.regs
        .filter((r) => r.phase === phase && (r.type === '*' || r.type === mutableEvent.type))
        .sort((a, b) => a.priority - b.priority || a.order - b.order);

      if (matched.length === 0) continue;

      if (phase === 'pre_validate') {
        for (const r of matched) {
          const result = r.listener(mutableEvent as Readonly<CombatEvent>);
          if (result === false) {
            cancelled = true;
            break;
          }
        }
      } else if (phase === 'pre_resolve') {
        for (const r of matched) {
          const result = r.listener(mutableEvent as Readonly<CombatEvent>);
          if (result && typeof result === 'object' && !Array.isArray(result)) {
            const patch = result as Record<string, unknown>;
            // Mutation guard: cannot change `type` (would invalidate downstream listener type narrowing)
            if ('type' in patch && patch.type !== originalType) {
              throw new Error(
                `pre_resolve listener cannot change event.type: '${originalType}' → '${String(patch.type)}'`,
              );
            }
            // Mutation guard: cannot change `turn` (would corrupt replay timeline)
            if ('turn' in patch && patch.turn !== originalTurn) {
              throw new Error(
                `pre_resolve listener cannot change event.turn: ${originalTurn} → ${String(patch.turn)}`,
              );
            }
            // FIX #2 — whitelist guard: chỉ ALLOWED_MUTATION_FIELDS được merge
            for (const key of Object.keys(patch)) {
              if (key === 'type' || key === 'turn') continue; // already guarded above
              if (!ALLOWED_MUTATION_FIELDS.includes(key)) {
                throw new Error(
                  `pre_resolve listener cannot mutate forbidden field '${key}'. ` +
                  `Allowed: [${ALLOWED_MUTATION_FIELDS.join(', ')}]`,
                );
              }
            }
            mutableEvent = { ...mutableEvent, ...(patch as Partial<T>) };
          }
        }
        // FIX #2 hardening — Zod runtime validate AFTER all pre_resolve merges
        // Catches NaN/Infinity/wrong type that whitelist key check missed
        if (this.zodValidate) {
          this.zodValidate(mutableEvent as CombatEvent);
        }
      } else {
        // resolve / post_resolve / post_log — DEEP frozen event (FIX #8), return ignored
        const frozen = deepFreeze({ ...mutableEvent }) as Readonly<T>;
        for (const r of matched) {
          r.listener(frozen as Readonly<CombatEvent>);
        }
      }
    }

    if (!cancelled) this.buffer.push(mutableEvent);

    return { cancelled, finalEvent: mutableEvent };
  }

  /** All non-cancelled events emitted — dùng cho replay/test/telemetry export. */
  getBuffer(): readonly CombatEvent[] {
    return this.buffer;
  }

  /** Clear buffer (end of encounter). */
  clear(): void {
    this.buffer = [];
  }
}

// Re-export internal type so tests can reference if needed.
export type { CombatChar };

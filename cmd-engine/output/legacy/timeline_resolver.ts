/**
 * TIMELINE RESOLVER + PLAYBACK QUEUE + IMPACT FRAME SYNC + PROJECTILE TIMING +
 * BOSS WINDUP + STATUS PLAYBACK — TS feel orchestration (FIX PHASE 3 +).
 *
 * 6 system gộp 1 file tránh fragmentation:
 *
 * 1. TimelineResolver (CRITICAL)
 *    Multi-event timeline cho 1 action: cast_start → windup → projectile_launch →
 *    projectile_travel → impact → status_apply → death? → recovery
 *
 * 2. PlaybackQueue (CRITICAL)
 *    FIFO ordered TimelineEvent[], deterministic dequeue. Replay = re-enqueue same.
 *
 * 3. ImpactFrameSync (CRITICAL)
 *    Damage/heal apply at IMPACT_FRAME_DEFAULT (or skill custom impact_frame).
 *    SVTK: frame 12 / 30 FPS = 400ms in (responsive feel).
 *
 * 4. ProjectileTiming (HIGH)
 *    Distance-based travel time. Default 400ms; long-range bow = 600ms.
 *
 * 5. BossWindupSystem (HIGH)
 *    Boss telegraph: extra ~800ms before impact (dodge window).
 *
 * 6. StatusPlayback (HIGH)
 *    DOT/HOT tick visual cadence. Each stack tick = STATUS_TICK_VISUAL_MS apart.
 *
 * Pure data + functions. Caller (presentation layer) consumes timeline.
 */
import { SkillConstants } from './skill_constants.js';

// ─────────────────────────────────────────────────────────
// TimelineEvent
// ─────────────────────────────────────────────────────────

export type TimelineEventKind =
  | 'cast_start'           // animation begin
  | 'boss_windup'          // boss telegraph (HIGH)
  | 'projectile_launch'    // arrow/spell leave caster
  | 'projectile_travel'    // in-flight (visual marker)
  | 'impact_frame'         // damage moment (CRITICAL — F-1 calcDamage applied here)
  | 'status_apply'         // dot/hot/cc applied
  | 'death'                // target hp ≤ 0
  | 'recovery'             // animation end / actor returns idle
  | 'status_tick_visual'   // DOT/HOT tick popup (HIGH)
  | 'shield_consume'       // shield absorbed damage
  | 'overwrite_replace';   // shield strongest replace (FIX #6 transactional)

export interface TimelineEvent {
  /** Time offset from ACTION start (NOT turn start). Caller adds turn offset. */
  tMs: number;
  /** Duration of this event (0 = instant). */
  durationMs: number;
  kind: TimelineEventKind;
  actorEntityId: string;
  targetEntityId?: string;
  /** Damage/heal/status numeric payload (replay-safe INT). */
  amount?: number;
  /** Skill id reference. */
  skillId?: string;
  /** Free-form metadata (status type, projectile sprite id). */
  meta?: Record<string, string | number | boolean>;
}

// ─────────────────────────────────────────────────────────
// 1. TimelineResolver
// ─────────────────────────────────────────────────────────

export interface ResolveTimelineInput {
  actorEntityId: string;
  targetEntityId?: string;
  skillId: string;
  /** Damage/heal applied at impact (post-formula). */
  amount: number;
  /** Optional impact frame override (default IMPACT_FRAME_DEFAULT). */
  impactFrame?: number;
  /** Has projectile? (vd archer skill, magic bolt). */
  hasProjectile?: boolean;
  /** Caster is BOSS — adds windup. */
  isBossCaster?: boolean;
  /** Skill ends in target death? */
  causesDeath?: boolean;
  /** Status apply requests (for status_apply events). */
  statusKinds?: string[];
}

/**
 * Build timeline for 1 action. Returns TimelineEvent[] with deterministic order.
 *
 * Standard timeline:
 *   t=0:        cast_start (1 frame ~33ms)
 *   t=200:      boss_windup (if boss, lasts BOSS_WINDUP_MS_DEFAULT)
 *   t=W:        projectile_launch (W = windup end if boss, else 0)
 *   t=W+1:      projectile_travel (PROJECTILE_TRAVEL_MS if hasProjectile)
 *   t=W+P:      impact_frame (durationMs = ANIM_FRAME_DURATION_MS)
 *   t=W+P+1:    status_apply (per status, parallel)
 *   t=W+P+2:    death (if causesDeath)
 *   t=end:      recovery (~200ms tail)
 */
export function resolveTimeline(input: ResolveTimelineInput): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  let t = 0;

  out.push({
    tMs: t, durationMs: SkillConstants.ANIM_FRAME_DURATION_MS,
    kind: 'cast_start',
    actorEntityId: input.actorEntityId,
    targetEntityId: input.targetEntityId,
    skillId: input.skillId,
  });
  t += SkillConstants.ANIM_FRAME_DURATION_MS;

  // Boss windup
  if (input.isBossCaster) {
    out.push({
      tMs: t, durationMs: SkillConstants.BOSS_WINDUP_MS_DEFAULT,
      kind: 'boss_windup',
      actorEntityId: input.actorEntityId,
      skillId: input.skillId,
    });
    t += SkillConstants.BOSS_WINDUP_MS_DEFAULT;
  }

  // Projectile path
  if (input.hasProjectile) {
    out.push({
      tMs: t, durationMs: 0,
      kind: 'projectile_launch',
      actorEntityId: input.actorEntityId,
      targetEntityId: input.targetEntityId,
      skillId: input.skillId,
    });
    out.push({
      tMs: t, durationMs: SkillConstants.PROJECTILE_TRAVEL_MS_DEFAULT,
      kind: 'projectile_travel',
      actorEntityId: input.actorEntityId,
      targetEntityId: input.targetEntityId,
      skillId: input.skillId,
    });
    t += SkillConstants.PROJECTILE_TRAVEL_MS_DEFAULT;
  } else {
    // Melee — impact at impact_frame offset
    const impactOffsetMs = (input.impactFrame ?? SkillConstants.IMPACT_FRAME_DEFAULT) * SkillConstants.ANIM_FRAME_DURATION_MS;
    t += impactOffsetMs;
  }

  // Impact (CRITICAL — damage applied here)
  out.push({
    tMs: t, durationMs: SkillConstants.ANIM_FRAME_DURATION_MS,
    kind: 'impact_frame',
    actorEntityId: input.actorEntityId,
    targetEntityId: input.targetEntityId,
    amount: input.amount,
    skillId: input.skillId,
  });
  t += SkillConstants.ANIM_FRAME_DURATION_MS;

  // Status apply (parallel — same tMs)
  if (input.statusKinds && input.statusKinds.length > 0) {
    for (const kind of input.statusKinds) {
      out.push({
        tMs: t, durationMs: 0,
        kind: 'status_apply',
        actorEntityId: input.actorEntityId,
        targetEntityId: input.targetEntityId,
        skillId: input.skillId,
        meta: { statusKind: kind },
      });
    }
  }

  // Death
  if (input.causesDeath && input.targetEntityId) {
    out.push({
      tMs: t, durationMs: 600,    // typical death anim
      kind: 'death',
      actorEntityId: input.actorEntityId,
      targetEntityId: input.targetEntityId,
    });
    t += 600;
  }

  // Recovery tail
  out.push({
    tMs: t, durationMs: 200,
    kind: 'recovery',
    actorEntityId: input.actorEntityId,
    skillId: input.skillId,
  });

  // Cap timeline events per turn
  if (out.length > SkillConstants.TIMELINE_MAX_EVENTS_PER_TURN) {
    return out.slice(0, SkillConstants.TIMELINE_MAX_EVENTS_PER_TURN);
  }
  return out;
}

// ─────────────────────────────────────────────────────────
// 2. PlaybackQueue (FIFO deterministic)
// ─────────────────────────────────────────────────────────

export class PlaybackQueue {
  private items: TimelineEvent[] = [];
  private cursor = 0;

  enqueue(events: readonly TimelineEvent[]): void {
    if (this.items.length + events.length > SkillConstants.PLAYBACK_QUEUE_MAX_DEPTH) {
      throw new Error(`[PlaybackQueue] depth exceeded ${SkillConstants.PLAYBACK_QUEUE_MAX_DEPTH}`);
    }
    for (const e of events) this.items.push(e);
  }

  /** Peek next event without dequeue. */
  peek(): TimelineEvent | undefined {
    return this.items[this.cursor];
  }

  /** Dequeue next event. */
  dequeue(): TimelineEvent | undefined {
    const ev = this.items[this.cursor];
    if (ev) this.cursor++;
    return ev;
  }

  /** Get all events at specific tMs (for parallel events). */
  drainAt(tMs: number): TimelineEvent[] {
    const out: TimelineEvent[] = [];
    while (this.cursor < this.items.length && this.items[this.cursor]?.tMs === tMs) {
      out.push(this.items[this.cursor]!);
      this.cursor++;
    }
    return out;
  }

  size(): number {
    return this.items.length - this.cursor;
  }

  reset(): void {
    this.items = [];
    this.cursor = 0;
  }

  /** Snapshot remaining (for replay). */
  snapshot(): readonly TimelineEvent[] {
    return this.items.slice(this.cursor);
  }
}

// ─────────────────────────────────────────────────────────
// 3. ImpactFrameSync — utility
// ─────────────────────────────────────────────────────────

/**
 * Compute impact moment (ms from action start) for a skill.
 * Caller (server damage resolver) uses this to schedule mutation timing.
 *
 * Server can either:
 *   A. Apply damage IMMEDIATELY (current Phase 3 default — "instant resolve")
 *   B. Apply damage at impactMs (animation-locked — TS feel)
 *
 * Option A keeps R33 hot-path simple. Option B requires deferred apply queue.
 * Phase 4 networking will choose based on PvE (B) vs PvP (A for snappy).
 */
export function computeImpactMs(opts: {
  isBossCaster?: boolean;
  hasProjectile?: boolean;
  impactFrame?: number;
}): number {
  let t = SkillConstants.ANIM_FRAME_DURATION_MS;     // cast_start frame
  if (opts.isBossCaster) t += SkillConstants.BOSS_WINDUP_MS_DEFAULT;
  if (opts.hasProjectile) {
    t += SkillConstants.PROJECTILE_TRAVEL_MS_DEFAULT;
  } else {
    const f = opts.impactFrame ?? SkillConstants.IMPACT_FRAME_DEFAULT;
    t += f * SkillConstants.ANIM_FRAME_DURATION_MS;
  }
  return t;
}

// ─────────────────────────────────────────────────────────
// 4. ProjectileTiming
// ─────────────────────────────────────────────────────────

/** Compute projectile travel time based on distance (cell). 0 cell → 0 ms. */
export function computeProjectileTravelMs(distance: number): number {
  if (distance <= 0) return 0;
  // Linear: 1 cell = 100ms, capped at PROJECTILE_TRAVEL_MS_DEFAULT × 2.
  const ms = distance * 100;
  return Math.min(ms, SkillConstants.PROJECTILE_TRAVEL_MS_DEFAULT * 2);
}

// ─────────────────────────────────────────────────────────
// 5. BossWindupSystem
// ─────────────────────────────────────────────────────────

/** Ultimate windup multiplier in BP (15000 = ×1.5). */
const BOSS_WINDUP_ULT_MULT_BP = 15000;

/**
 * Compute boss windup ms — base default + skill-tier multiplier.
 * Tier multiplier: ultimate skill = 1.5×, normal = 1.0×, instant (utility) = 0.
 */
export function computeBossWindupMs(skillCategory: string, isUltimate: boolean = false): number {
  if (skillCategory === 'utility') return 0;     // instant
  const base = SkillConstants.BOSS_WINDUP_MS_DEFAULT;
  if (!isUltimate) return base;
  return Math.floor((base * BOSS_WINDUP_ULT_MULT_BP) / 10000);
}

// ─────────────────────────────────────────────────────────
// 6. StatusPlayback (DOT/HOT visual cadence)
// ─────────────────────────────────────────────────────────

/**
 * Build status_tick_visual events for DOT/HOT stack ticks at turn end.
 * Each stack ticks STATUS_TICK_VISUAL_MS apart for legibility.
 */
export function buildStatusTickVisuals(opts: {
  actorEntityId: string;
  targetEntityId: string;
  baseTimeMs: number;
  statusType: string;
  amountPerStack: number;
  stacks: number;
}): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (let i = 0; i < opts.stacks; i++) {
    out.push({
      tMs: opts.baseTimeMs + i * SkillConstants.STATUS_TICK_VISUAL_MS,
      durationMs: SkillConstants.STATUS_TICK_VISUAL_MS,
      kind: 'status_tick_visual',
      actorEntityId: opts.actorEntityId,
      targetEntityId: opts.targetEntityId,
      amount: opts.amountPerStack,
      meta: { statusType: opts.statusType, stackIndex: i },
    });
  }
  return out;
}

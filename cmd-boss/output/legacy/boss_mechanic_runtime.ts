/**
 * BOSS MECHANIC RUNTIME — high-level mechanic effects (Phase 6).
 *
 * Plug-in handlers consumed by encounter_manager when MechanicScheduler resolves
 * a PendingMechanic. Each handler implements one of the MechanicDef.kind values
 * declared in boss_script_registry.ts.
 *
 * Integrations:
 *   - FormationResetReason (CMD1 FIX #9)  — emitted on aggro_reset / wipe_check
 *   - PersistencePolicy   (CMD1 FIX #4)   — cinematic_lock sets policy
 *   - DistanceMap version (CMD1 FIX #5)   — forced_movement bumps version
 *
 * STRICT data-driven: handler dispatch is `Record<MechanicKind, Handler>`,
 * NO `if/switch` chain over bossId.
 *
 * Deterministic + replay-safe: every handler is pure relative to (state, input).
 */
import { z } from 'zod';
import type { PendingMechanic } from '../../../cmd-engine/output/legacy/mechanic_scheduler.js';
import type { MechanicDef } from './boss_script_registry.js';
import type { ThreatEngineState } from '../../../cmd-engine/output/legacy/threat_engine.js';
import { endThreatEncounter } from '../../../cmd-engine/output/legacy/threat_engine.js';
import type { FormationRuntimeState } from '../../../cmd-engine/output/legacy/formation_runtime.js';
import { resetFormation, type FormationResetReason } from '../../../cmd-engine/output/legacy/formation_runtime.js';
import type { WorldEntityRegistry, EntityPersistencePolicy } from '../../../cmd-engine/output/legacy/entity_lifecycle.js';
import type { SpatialLayerState } from '../../../cmd-engine/output/legacy/spatial_layer.js';
import {
  applyKnockback, applyPull, placeDelayedAoe,
  type DelayedAoeRegistry, type DelayedAoeShape, type GridBounds,
} from '../../../cmd-engine/output/legacy/spatial_combat_expansion.js';
import type { Position } from '../../../cmd-engine/output/legacy/spatial_threat.js';

// ─────────────────────────────────────────────────────────
// Cinematic lock
// ─────────────────────────────────────────────────────────

export const CinematicLockStateSchema = z.object({
  locked: z.boolean(),
  bossId: z.string().optional(),
  startedAtTurn: z.number().int().nonnegative().optional(),
  expiresAtTurn: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
});
export type CinematicLockState = z.infer<typeof CinematicLockStateSchema>;

export function createCinematicLock(): CinematicLockState {
  return { locked: false };
}

export function engageCinematicLock(
  state: CinematicLockState,
  bossId: string,
  currentTurn: number,
  durationTurns: number,
  reason: string = 'boss_cinematic',
): void {
  state.locked = true;
  state.bossId = bossId;
  state.startedAtTurn = currentTurn;
  state.expiresAtTurn = currentTurn + durationTurns;
  state.reason = reason;
}

export function releaseCinematicLock(state: CinematicLockState): void {
  state.locked = false;
  state.bossId = undefined;
  state.startedAtTurn = undefined;
  state.expiresAtTurn = undefined;
  state.reason = undefined;
}

export function tickCinematicLock(state: CinematicLockState, currentTurn: number): boolean {
  if (state.locked && state.expiresAtTurn !== undefined && currentTurn >= state.expiresAtTurn) {
    releaseCinematicLock(state);
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────
// Phase lock — boss invulnerable / damage-immune during transition
// ─────────────────────────────────────────────────────────

export interface PhaseLockState {
  locked: boolean;
  bossId?: string;
  startedAtTurn?: number;
  expiresAtTurn?: number;
}

export function createPhaseLock(): PhaseLockState {
  return { locked: false };
}

export function engagePhaseLock(
  state: PhaseLockState,
  bossId: string,
  currentTurn: number,
  durationTurns: number,
): void {
  state.locked = true;
  state.bossId = bossId;
  state.startedAtTurn = currentTurn;
  state.expiresAtTurn = currentTurn + durationTurns;
}

export function tickPhaseLock(state: PhaseLockState, currentTurn: number): boolean {
  if (state.locked && state.expiresAtTurn !== undefined && currentTurn >= state.expiresAtTurn) {
    state.locked = false;
    state.bossId = undefined;
    state.startedAtTurn = undefined;
    state.expiresAtTurn = undefined;
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────
// Aggro reset (mechanic — wipe boss threat table)
// ─────────────────────────────────────────────────────────

export function executeAggroReset(
  threat: ThreatEngineState,
  formation: FormationRuntimeState | undefined,
  currentTurn: number,
): { droppedAttackers: number; formationResetReason?: FormationResetReason } {
  const droppedAttackers = threat.table.size;
  endThreatEncounter(threat);
  if (formation) {
    resetFormation(formation, currentTurn, 'raid_mechanic');
    return { droppedAttackers, formationResetReason: 'raid_mechanic' };
  }
  return { droppedAttackers };
}

// ─────────────────────────────────────────────────────────
// Wipe check — fail-the-mechanic condition
// ─────────────────────────────────────────────────────────

export interface WipeCheckInput {
  /** Predicate: returns true if mechanic was failed (all party should wipe). */
  failed: () => boolean;
  /** Formation runtime (for reset tagging). */
  formation?: FormationRuntimeState;
  /** Threat engine (for clear on wipe). */
  threat?: ThreatEngineState;
  currentTurn: number;
}

export interface WipeCheckResult {
  wiped: boolean;
  threatCleared: number;
  formationResetReason?: FormationResetReason;
}

export function executeWipeCheck(input: WipeCheckInput): WipeCheckResult {
  if (!input.failed()) return { wiped: false, threatCleared: 0 };
  let threatCleared = 0;
  if (input.threat) {
    threatCleared = input.threat.table.size;
    endThreatEncounter(input.threat);
  }
  let reason: FormationResetReason | undefined;
  if (input.formation) {
    reason = 'wipe';
    resetFormation(input.formation, input.currentTurn, reason);
  }
  return { wiped: true, threatCleared, formationResetReason: reason };
}

// ─────────────────────────────────────────────────────────
// Region trigger — bind entity entry/exit to mechanic
// ─────────────────────────────────────────────────────────

export interface RoomRegion {
  regionId: string;
  bounds: GridBounds;
  /** Optional door positions (entry checkpoint). */
  doors?: readonly Position[];
}

export interface RegionMembership {
  inside: Set<string>;
}

export function createRegionMembership(): RegionMembership {
  return { inside: new Set() };
}

export interface RegionScanResult {
  entered: readonly string[];
  exited: readonly string[];
  inside: readonly string[];
}

/**
 * Scan layer vs region bounds, diff against previous membership. Returns enter/exit lists.
 * Deterministic order (sorted by entityId LEX).
 */
export function scanRegionMembership(
  region: RoomRegion,
  layer: SpatialLayerState,
  prev: RegionMembership,
): RegionScanResult {
  const current = new Set<string>();
  for (const [id, pos] of layer.positions) {
    const b = region.bounds;
    if (pos.x >= b.minX && pos.x <= b.maxX && pos.y >= b.minY && pos.y <= b.maxY) {
      current.add(id);
    }
  }
  const entered: string[] = [];
  const exited: string[] = [];
  for (const id of current) if (!prev.inside.has(id)) entered.push(id);
  for (const id of prev.inside) if (!current.has(id)) exited.push(id);
  entered.sort();
  exited.sort();
  prev.inside = current;
  const inside = [...current].sort();
  return { entered, exited, inside };
}

// ─────────────────────────────────────────────────────────
// Room mechanic — combined geometry + behavior
// ─────────────────────────────────────────────────────────

export interface RoomMechanicState {
  roomId: string;
  region: RoomRegion;
  membership: RegionMembership;
  /** PersistencePolicy applied to entities in room (CMD1 FIX #4). */
  insidePolicy: EntityPersistencePolicy;
  /** PersistencePolicy applied to entities outside room. */
  outsidePolicy: EntityPersistencePolicy;
}

export function createRoomMechanic(
  roomId: string,
  region: RoomRegion,
  insidePolicy: EntityPersistencePolicy = 'encounter_bound',
  outsidePolicy: EntityPersistencePolicy = 'temporary',
): RoomMechanicState {
  return {
    roomId,
    region,
    membership: createRegionMembership(),
    insidePolicy,
    outsidePolicy,
  };
}

/**
 * Apply room policy to all currently-inside/outside entities in the world registry.
 * Called each tick after `scanRegionMembership`.
 */
export function applyRoomPolicies(
  room: RoomMechanicState,
  registry: WorldEntityRegistry,
  scanResult: RegionScanResult,
): { changed: number } {
  let changed = 0;
  for (const id of scanResult.entered) {
    const e = registry.get(id);
    if (e && e.persistencePolicy !== room.insidePolicy) {
      e.persistencePolicy = room.insidePolicy;
      changed++;
    }
  }
  for (const id of scanResult.exited) {
    const e = registry.get(id);
    if (e && e.persistencePolicy !== room.outsidePolicy) {
      e.persistencePolicy = room.outsidePolicy;
      changed++;
    }
  }
  return { changed };
}

// ─────────────────────────────────────────────────────────
// Mechanic handler registry — plug-in dispatch
// ─────────────────────────────────────────────────────────

export interface MechanicHandlerContext {
  /** Resolving pending entry. */
  entry: PendingMechanic;
  /** Definition from BossScript. */
  def: MechanicDef;
  /** Current turn. */
  currentTurn: number;
  /** Spatial layer (forced movement / AoE marker placement). */
  layer?: SpatialLayerState;
  /** Delayed AoE registry (for spatial_aoe / line / cone mechanics). */
  aoeRegistry?: DelayedAoeRegistry;
  /** Threat engine (for aggro_reset). */
  threat?: ThreatEngineState;
  /** Formation runtime (for raid_mechanic reset). */
  formation?: FormationRuntimeState;
  /** Cinematic lock state. */
  cinematicLock?: CinematicLockState;
  /** Origin position (for spatial mechanic). */
  origin?: Position;
  /** Targets affected (for forced_movement). */
  targetIds?: readonly string[];
  /** Grid bounds (for raid-safe clamping). */
  bounds?: GridBounds;
  /** Other positions (for collision check on forced movement). */
  occupied?: ReadonlyMap<string, Position>;
}

export type MechanicHandler = (ctx: MechanicHandlerContext) => MechanicResolveOutcome;

export interface MechanicResolveOutcome {
  ok: boolean;
  reason?: string;
  /** Telemetry payload (cause/effect for replay event stream). */
  details?: Record<string, unknown>;
}

export class MechanicHandlerRegistry {
  private handlers = new Map<string, MechanicHandler>();

  register(kind: string, handler: MechanicHandler): void {
    if (this.handlers.has(kind)) {
      throw new Error(`[MechanicHandlerRegistry] dup handler for kind='${kind}'`);
    }
    this.handlers.set(kind, handler);
  }

  resolve(ctx: MechanicHandlerContext): MechanicResolveOutcome {
    const handler = this.handlers.get(ctx.def.kind);
    if (!handler) {
      return { ok: false, reason: `no_handler_for_kind:${ctx.def.kind}` };
    }
    return handler(ctx);
  }

  has(kind: string): boolean {
    return this.handlers.has(kind);
  }

  _reset(): void { this.handlers.clear(); }
}

// ─────────────────────────────────────────────────────────
// Built-in handlers (data-driven dispatch)
// ─────────────────────────────────────────────────────────

export function registerDefaultMechanicHandlers(reg: MechanicHandlerRegistry): void {
  reg.register('spatial_aoe', handleSpatialAoe);
  reg.register('spatial_line', (ctx) => handleSpatialAoeShape(ctx, 'line'));
  reg.register('spatial_cone', (ctx) => handleSpatialAoeShape(ctx, 'cone'));
  reg.register('forced_movement', handleForcedMovement);
  reg.register('wipe_check', handleWipeCheck);
  reg.register('aggro_reset', handleAggroReset);
  reg.register('summon', handleSummon);
  reg.register('cinematic_lock', handleCinematicLock);
  reg.register('enrage_buff', handleEnrageBuff);
  reg.register('custom', handleCustom);
}

function handleSpatialAoe(ctx: MechanicHandlerContext): MechanicResolveOutcome {
  return handleSpatialAoeShape(ctx, 'circle');
}

function handleSpatialAoeShape(
  ctx: MechanicHandlerContext,
  shape: DelayedAoeShape,
): MechanicResolveOutcome {
  if (!ctx.aoeRegistry || !ctx.origin) {
    return { ok: false, reason: 'missing_layer_or_origin' };
  }
  const payload = ctx.def.payload ?? {};
  const range = numProp(payload, 'range', 3);
  const width = numProp(payload, 'width', 1);
  const marker = placeDelayedAoe(ctx.aoeRegistry, {
    shape,
    origin: ctx.origin,
    range,
    width,
    direction: strProp(payload, 'direction') as never,
    scheduledAtTurn: ctx.currentTurn,
    resolveTurn: ctx.entry.resolveTurn,
    bossId: ctx.entry.bossId,
    mechanicId: ctx.entry.mechanicId,
  });
  return { ok: true, details: { markerId: marker.markerId, shape, range, width } };
}

function handleForcedMovement(ctx: MechanicHandlerContext): MechanicResolveOutcome {
  if (!ctx.layer || !ctx.origin || !ctx.targetIds) {
    return { ok: false, reason: 'missing_layer_or_targets' };
  }
  const payload = ctx.def.payload ?? {};
  const distance = numProp(payload, 'distance', 2);
  const direction = strProp(payload, 'direction', 'knockback');
  const apply = direction === 'pull' ? applyPull : applyKnockback;
  const results = [];
  for (const targetId of ctx.targetIds) {
    const r = apply(ctx.layer, targetId, {
      origin: ctx.origin,
      distance,
      bounds: ctx.bounds,
      occupied: ctx.occupied,
    });
    if (r) results.push(r);
  }
  return {
    ok: true,
    details: {
      direction,
      distance,
      affected: results.map((r) => ({ id: r.entityId, actualDistance: r.actualDistance, clamped: r.clamped })),
    },
  };
}

function handleWipeCheck(ctx: MechanicHandlerContext): MechanicResolveOutcome {
  const payload = ctx.def.payload ?? {};
  const failed = boolProp(payload, 'failed', false);
  if (!ctx.threat || !ctx.formation) {
    return { ok: false, reason: 'missing_threat_or_formation' };
  }
  const r = executeWipeCheck({
    failed: () => failed,
    threat: ctx.threat,
    formation: ctx.formation,
    currentTurn: ctx.currentTurn,
  });
  return { ok: true, details: { wiped: r.wiped, threatCleared: r.threatCleared, reason: r.formationResetReason } };
}

function handleAggroReset(ctx: MechanicHandlerContext): MechanicResolveOutcome {
  if (!ctx.threat) return { ok: false, reason: 'missing_threat' };
  const r = executeAggroReset(ctx.threat, ctx.formation, ctx.currentTurn);
  return { ok: true, details: { droppedAttackers: r.droppedAttackers, formationResetReason: r.formationResetReason } };
}

function handleSummon(ctx: MechanicHandlerContext): MechanicResolveOutcome {
  // Implementation deferred to encounter_manager — emit telemetry only.
  return { ok: true, details: { mechanicKind: 'summon', mechanicId: ctx.entry.mechanicId } };
}

function handleCinematicLock(ctx: MechanicHandlerContext): MechanicResolveOutcome {
  if (!ctx.cinematicLock) return { ok: false, reason: 'missing_cinematic_lock' };
  const payload = ctx.def.payload ?? {};
  const duration = numProp(payload, 'duration', 3);
  engageCinematicLock(ctx.cinematicLock, ctx.entry.bossId, ctx.currentTurn, duration);
  return { ok: true, details: { lockedUntil: ctx.currentTurn + duration } };
}

function handleEnrageBuff(ctx: MechanicHandlerContext): MechanicResolveOutcome {
  // Buff application deferred to combat engine — emit telemetry only.
  return { ok: true, details: { mechanicKind: 'enrage_buff' } };
}

function handleCustom(ctx: MechanicHandlerContext): MechanicResolveOutcome {
  return { ok: true, details: { mechanicKind: 'custom', payload: ctx.def.payload ?? {} } };
}

// ─────────────────────────────────────────────────────────
// Payload helpers
// ─────────────────────────────────────────────────────────

function numProp(payload: Record<string, unknown>, key: string, dflt: number): number {
  const v = payload[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : dflt;
}

function strProp(payload: Record<string, unknown>, key: string, dflt: string = ''): string {
  const v = payload[key];
  return typeof v === 'string' ? v : dflt;
}

function boolProp(payload: Record<string, unknown>, key: string, dflt: boolean): boolean {
  const v = payload[key];
  return typeof v === 'boolean' ? v : dflt;
}

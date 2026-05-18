/**
 * SPATIAL COMBAT EXPANSION — boss mechanics primitives (Phase 6).
 *
 * Extends spatial_layer with:
 *   - cone attack resolver
 *   - delayed AoE (telegraph + ground marker)
 *   - proximity trigger (auto-fire when entity enters radius)
 *   - knockback (push away from origin)
 *   - pull (pull toward origin)
 *   - raid-safe collision (clamp to grid bounds + no-stack)
 *
 * All INT cell-based. NO float math. NO Math.random — caller passes rng.
 *
 * Deterministic replay: every spatial transformation is pure function of
 * (input, layer.version). Caller bumps layer.version via setPosition (FIX #5).
 */
import { z } from 'zod';
import type { Position } from './spatial_threat.js';
import { chebyshevDistance } from './spatial_threat.js';
import type { SpatialLayerState } from './spatial_layer.js';
import { setPosition, getPosition } from './spatial_layer.js';

// ─────────────────────────────────────────────────────────
// Cone attack
// ─────────────────────────────────────────────────────────

export const ConeDirectionSchema = z.enum(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);
export type ConeDirection = z.infer<typeof ConeDirectionSchema>;

export interface ConeCastInput {
  origin: Position;
  direction: ConeDirection;
  /** Forward range cell. */
  range: number;
  /** Half-angle in cell — width grows linearly along forward axis. */
  halfWidthAtMax: number;
}

/**
 * Find entities inside cone. Cone is a triangle from origin → width=halfWidthAtMax*2 at range.
 *
 * Deterministic order: distance ASC, then entityId LEX.
 */
export function resolveConeHits(layer: SpatialLayerState, cone: ConeCastInput): string[] {
  const dir = dirVec(cone.direction);
  const hits: { id: string; d: number }[] = [];
  for (const [id, pos] of layer.positions) {
    const dx = pos.x - cone.origin.x;
    const dy = pos.y - cone.origin.y;
    const forward = dx * dir.x + dy * dir.y;
    if (forward <= 0 || forward > cone.range) continue;
    // Perpendicular distance (Chebyshev approx).
    const perpX = dx - forward * dir.x;
    const perpY = dy - forward * dir.y;
    const perpDist = Math.max(Math.abs(perpX), Math.abs(perpY));
    // Cone half-width at this forward distance: scales linearly to halfWidthAtMax.
    const allowed = Math.floor((forward * cone.halfWidthAtMax) / Math.max(1, cone.range));
    if (perpDist <= allowed) hits.push({ id, d: forward });
  }
  hits.sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hits.map((h) => h.id);
}

// ─────────────────────────────────────────────────────────
// Delayed AoE — ground marker w/ telegraph
// ─────────────────────────────────────────────────────────

export const DelayedAoeShapeSchema = z.enum(['circle', 'line', 'cone']);
export type DelayedAoeShape = z.infer<typeof DelayedAoeShapeSchema>;

export interface DelayedAoeMarker {
  markerId: string;
  shape: DelayedAoeShape;
  origin: Position;
  /** Circle: radius. Line/Cone: range. */
  range: number;
  /** Line: width. Cone: halfWidthAtMax. */
  width?: number;
  /** Direction (for line / cone). */
  direction?: ConeDirection;
  /** Turn scheduled. */
  scheduledAtTurn: number;
  /** Turn resolved. */
  resolveTurn: number;
  /** Source mechanic + boss. */
  bossId: string;
  mechanicId: string;
  /** Sequence id for stable order. */
  scheduledSeq: number;
}

export interface DelayedAoeRegistry {
  markers: Map<string, DelayedAoeMarker>;
  nextSeq: number;
}

export function createDelayedAoeRegistry(): DelayedAoeRegistry {
  return { markers: new Map(), nextSeq: 0 };
}

export function placeDelayedAoe(
  reg: DelayedAoeRegistry,
  partial: Omit<DelayedAoeMarker, 'markerId' | 'scheduledSeq'>,
): DelayedAoeMarker {
  const seq = reg.nextSeq++;
  const markerId = `aoe_${partial.bossId}_${partial.mechanicId}_${seq}`;
  const marker: DelayedAoeMarker = { ...partial, markerId, scheduledSeq: seq };
  reg.markers.set(markerId, marker);
  return marker;
}

/**
 * Drain markers whose resolveTurn <= currentTurn. Deterministic order.
 */
export function drainReadyAoeMarkers(
  reg: DelayedAoeRegistry,
  currentTurn: number,
): readonly DelayedAoeMarker[] {
  const ready: DelayedAoeMarker[] = [];
  for (const m of reg.markers.values()) {
    if (m.resolveTurn <= currentTurn) ready.push(m);
  }
  ready.sort(compareMarker);
  for (const m of ready) reg.markers.delete(m.markerId);
  return ready;
}

function compareMarker(a: DelayedAoeMarker, b: DelayedAoeMarker): number {
  if (a.resolveTurn !== b.resolveTurn) return a.resolveTurn - b.resolveTurn;
  if (a.scheduledSeq !== b.scheduledSeq) return a.scheduledSeq - b.scheduledSeq;
  if (a.markerId < b.markerId) return -1;
  if (a.markerId > b.markerId) return 1;
  return 0;
}

export function listAoeMarkers(reg: DelayedAoeRegistry): readonly DelayedAoeMarker[] {
  return [...reg.markers.values()].sort(compareMarker);
}

// ─────────────────────────────────────────────────────────
// Proximity trigger — auto-fire when entity enters radius
// ─────────────────────────────────────────────────────────

export interface ProximityTrigger {
  triggerId: string;
  center: Position;
  /** Radius cell. */
  radius: number;
  /** Trigger fires once if true. */
  oneShot: boolean;
  /** Turn placed. */
  placedAtTurn: number;
  /** Source. */
  bossId: string;
  mechanicId: string;
  /** Set of entityIds that already fired (avoid re-trigger). */
  firedFor: Set<string>;
}

export interface ProximityTriggerRegistry {
  triggers: Map<string, ProximityTrigger>;
  nextSeq: number;
}

export function createProximityRegistry(): ProximityTriggerRegistry {
  return { triggers: new Map(), nextSeq: 0 };
}

export function placeProximityTrigger(
  reg: ProximityTriggerRegistry,
  partial: Omit<ProximityTrigger, 'triggerId' | 'firedFor'>,
): ProximityTrigger {
  const seq = reg.nextSeq++;
  const triggerId = `prox_${partial.bossId}_${partial.mechanicId}_${seq}`;
  const trigger: ProximityTrigger = { ...partial, triggerId, firedFor: new Set() };
  reg.triggers.set(triggerId, trigger);
  return trigger;
}

export interface ProximityFireEvent {
  triggerId: string;
  entityId: string;
  bossId: string;
  mechanicId: string;
  turn: number;
}

/**
 * Scan all proximity triggers vs entities in spatial layer.
 * Returns fire events for entities that just entered radius (per-trigger one-shot).
 *
 * Deterministic order: triggerId LEX → entityId LEX.
 */
export function scanProximityTriggers(
  reg: ProximityTriggerRegistry,
  layer: SpatialLayerState,
  currentTurn: number,
): readonly ProximityFireEvent[] {
  const events: ProximityFireEvent[] = [];
  const sortedTriggers = [...reg.triggers.values()].sort((a, b) =>
    a.triggerId < b.triggerId ? -1 : a.triggerId > b.triggerId ? 1 : 0,
  );
  for (const t of sortedTriggers) {
    const sortedEntities = [...layer.positions.entries()].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    );
    for (const [id, pos] of sortedEntities) {
      if (t.firedFor.has(id)) continue;
      const d = chebyshevDistance(t.center, pos);
      if (d <= t.radius) {
        events.push({
          triggerId: t.triggerId,
          entityId: id,
          bossId: t.bossId,
          mechanicId: t.mechanicId,
          turn: currentTurn,
        });
        if (t.oneShot) {
          t.firedFor.add(id);
        }
      }
    }
  }
  return events;
}

export function removeProximityTrigger(reg: ProximityTriggerRegistry, triggerId: string): boolean {
  return reg.triggers.delete(triggerId);
}

// ─────────────────────────────────────────────────────────
// Knockback / Pull — forced movement
// ─────────────────────────────────────────────────────────

export interface GridBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface ForcedMovementInput {
  /** Source origin (knockback away from / pull toward this point). */
  origin: Position;
  /** Distance cell to move (clamped to bounds + occupancy). */
  distance: number;
  /** Bounds for clamping. */
  bounds?: GridBounds;
  /** Other entity positions (for no-stack collision). undefined = no collision check. */
  occupied?: ReadonlyMap<string, Position>;
}

export interface ForcedMovementResult {
  entityId: string;
  from: Position;
  to: Position;
  /** Actual cells moved (≤ requested distance if clamped). */
  actualDistance: number;
  clamped: 'bounds' | 'collision' | 'none';
}

/**
 * Knockback — move entity AWAY from origin by `distance` cell along the
 * vector (entity - origin) normalized to dominant axis (Chebyshev / king-move).
 */
export function applyKnockback(
  layer: SpatialLayerState,
  entityId: string,
  input: ForcedMovementInput,
): ForcedMovementResult | undefined {
  const from = getPosition(layer, entityId);
  if (!from) return undefined;
  return applyForcedMove(layer, entityId, from, input, +1);
}

/**
 * Pull — move entity TOWARD origin by `distance` cell along king-move vector.
 */
export function applyPull(
  layer: SpatialLayerState,
  entityId: string,
  input: ForcedMovementInput,
): ForcedMovementResult | undefined {
  const from = getPosition(layer, entityId);
  if (!from) return undefined;
  return applyForcedMove(layer, entityId, from, input, -1);
}

function applyForcedMove(
  layer: SpatialLayerState,
  entityId: string,
  from: Position,
  input: ForcedMovementInput,
  sign: 1 | -1,
): ForcedMovementResult {
  const dx0 = from.x - input.origin.x;
  const dy0 = from.y - input.origin.y;
  if (dx0 === 0 && dy0 === 0) {
    return { entityId, from, to: { ...from }, actualDistance: 0, clamped: 'none' };
  }
  // Dominant-axis unit step (king move): sign of dx, dy. If on diagonal use both.
  const stepX = sign * Math.sign(dx0);
  const stepY = sign * Math.sign(dy0);

  let cur: Position = { x: from.x, y: from.y };
  let actual = 0;
  let clamped: 'bounds' | 'collision' | 'none' = 'none';

  for (let i = 0; i < input.distance; i++) {
    const next: Position = { x: cur.x + stepX, y: cur.y + stepY };
    if (input.bounds) {
      if (next.x < input.bounds.minX || next.x > input.bounds.maxX ||
        next.y < input.bounds.minY || next.y > input.bounds.maxY) {
        clamped = 'bounds';
        break;
      }
    }
    if (input.occupied) {
      let blocked = false;
      for (const [otherId, otherPos] of input.occupied) {
        if (otherId === entityId) continue;
        if (otherPos.x === next.x && otherPos.y === next.y) {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        clamped = 'collision';
        break;
      }
    }
    cur = next;
    actual += 1;
  }

  if (actual > 0) setPosition(layer, entityId, cur);
  return { entityId, from, to: cur, actualDistance: actual, clamped };
}

// ─────────────────────────────────────────────────────────
// Raid-safe placement — grid clamp + no-stack
// ─────────────────────────────────────────────────────────

/**
 * Attempt to place entity at preferred position. If occupied/out-of-bounds,
 * scan outward in deterministic spiral for nearest free cell.
 *
 * Returns the actual placement (or undefined if no free cell within maxScan).
 */
export function placeRaidSafe(
  layer: SpatialLayerState,
  entityId: string,
  preferred: Position,
  bounds: GridBounds,
  maxScan: number = 32,
): Position | undefined {
  if (isCellFree(layer, preferred, entityId) && inBounds(preferred, bounds)) {
    setPosition(layer, entityId, preferred);
    return preferred;
  }
  // Spiral scan — deterministic order.
  for (let r = 1; r <= maxScan; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;     // ring only
        const candidate: Position = { x: preferred.x + dx, y: preferred.y + dy };
        if (!inBounds(candidate, bounds)) continue;
        if (isCellFree(layer, candidate, entityId)) {
          setPosition(layer, entityId, candidate);
          return candidate;
        }
      }
    }
  }
  return undefined;
}

function isCellFree(layer: SpatialLayerState, cell: Position, exceptId: string): boolean {
  for (const [id, pos] of layer.positions) {
    if (id === exceptId) continue;
    if (pos.x === cell.x && pos.y === cell.y) return false;
  }
  return true;
}

function inBounds(pos: Position, b: GridBounds): boolean {
  return pos.x >= b.minX && pos.x <= b.maxX && pos.y >= b.minY && pos.y <= b.maxY;
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function dirVec(d: ConeDirection): { x: number; y: number } {
  switch (d) {
    case 'N':  return { x: 0, y: -1 };
    case 'S':  return { x: 0, y: 1 };
    case 'E':  return { x: 1, y: 0 };
    case 'W':  return { x: -1, y: 0 };
    case 'NE': return { x: 1, y: -1 };
    case 'NW': return { x: -1, y: -1 };
    case 'SE': return { x: 1, y: 1 };
    case 'SW': return { x: -1, y: 1 };
  }
}

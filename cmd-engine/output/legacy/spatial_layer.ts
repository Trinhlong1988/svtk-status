/**
 * SPATIAL LAYER — combat positioning runtime (Phase 5).
 *
 * Build on spatial_threat (Phase 4 hardening) — adds:
 *   - line attack resolver (skill line traversal)
 *   - AoE circle/cone resolver
 *   - distance map per entity
 *   - proximity resolver (near/far)
 *
 * CMD1 FIX #5 — distance map version + dirty invalidation:
 *   - SpatialLayerState carries `version` (monotonic).
 *   - setPosition / removeEntity bump version (mutation = stale cache).
 *   - Caller caches `(version, originKey) → distanceMap` and re-uses while version stable.
 *   - Boss mechanics (Phase 6) WILL move entities mid-encounter → version check is the only safe pattern.
 *
 * Pure helpers + lightweight state. Caller (encounter manager) maintains
 * SpatialLayerState per encounter.
 */
import type { Position } from './spatial_threat.js';
import { chebyshevDistance } from './spatial_threat.js';
import { NpcConstants } from './npc_constants.js';

// ─────────────────────────────────────────────────────────
// SpatialLayerState (CMD1 FIX #5 — version invalidation)
// ─────────────────────────────────────────────────────────

export interface SpatialLayerState {
  positions: Map<string, Position>;
  /** CMD1 FIX #5 — monotonic version. Bumped on every position mutation. */
  version: number;
}

export function createSpatialLayer(): SpatialLayerState {
  return { positions: new Map(), version: 0 };
}

/** CMD1 FIX #5 — version accessor for cache validation. */
export function getSpatialVersion(layer: SpatialLayerState): number {
  return layer.version;
}

export function setPosition(layer: SpatialLayerState, entityId: string, pos: Position): void {
  const prev = layer.positions.get(entityId);
  if (prev && prev.x === pos.x && prev.y === pos.y) return;     // no-op, don't bump version
  layer.positions.set(entityId, { ...pos });
  layer.version += 1;
}

export function getPosition(layer: SpatialLayerState, entityId: string): Position | undefined {
  return layer.positions.get(entityId);
}

export function removeEntity(layer: SpatialLayerState, entityId: string): boolean {
  const removed = layer.positions.delete(entityId);
  if (removed) layer.version += 1;
  return removed;
}

// ─────────────────────────────────────────────────────────
// Distance map cache (CMD1 FIX #5)
// ─────────────────────────────────────────────────────────

/**
 * Versioned distance map — caller stashes this in encounter context and
 * checks `version` before re-using. Mismatch = recompute via `buildLayerDistanceMap`.
 */
export interface VersionedDistanceMap {
  /** Version of SpatialLayerState at build time. */
  version: number;
  /** Origin key (caller-defined — typically `${x},${y}`). */
  originKey: string;
  /** entityId → chebyshev distance. */
  distances: ReadonlyMap<string, number>;
}

export function originKeyOf(origin: Position): string {
  return `${origin.x},${origin.y}`;
}

/**
 * Cache hit check — returns true if cache is still consistent with layer.
 * Caller pattern:
 *   if (!cache || !isDistanceMapFresh(cache, layer, origin)) cache = buildVersionedDistanceMap(layer, origin);
 */
export function isDistanceMapFresh(
  cache: VersionedDistanceMap,
  layer: SpatialLayerState,
  origin: Position,
): boolean {
  return cache.version === layer.version && cache.originKey === originKeyOf(origin);
}

export function buildVersionedDistanceMap(
  layer: SpatialLayerState,
  origin: Position,
  entityIds?: readonly string[],
): VersionedDistanceMap {
  const distances = buildLayerDistanceMap(layer, origin, entityIds);
  return {
    version: layer.version,
    originKey: originKeyOf(origin),
    distances,
  };
}

// ─────────────────────────────────────────────────────────
// Line resolver — skill line (single direction)
// ─────────────────────────────────────────────────────────

export interface LineCastInput {
  origin: Position;
  direction: 'N' | 'S' | 'E' | 'W' | 'NE' | 'NW' | 'SE' | 'SW';
  length: number;
  width?: number;
}

/**
 * Find entity ids on a line from origin in direction × length.
 *
 * Deterministic: sorted by distance ASC, ties by entityId lex.
 */
export function resolveLineHits(layer: SpatialLayerState, line: LineCastInput): string[] {
  const dir = directionToVec(line.direction);
  const width = line.width ?? NpcConstants.SPATIAL_LINE_WIDTH_DEFAULT;
  const hits: { id: string; d: number }[] = [];

  for (const [id, pos] of layer.positions) {
    // Project (pos - origin) onto dir
    const dx = pos.x - line.origin.x;
    const dy = pos.y - line.origin.y;
    const t = dx * dir.x + dy * dir.y;     // distance along line
    if (t <= 0 || t > line.length) continue;
    // Perpendicular distance (Chebyshev approximation).
    // 2 * perpDist <= width + 1 (integer-only avoid float literal 0.5).
    const perpX = dx - t * dir.x;
    const perpY = dy - t * dir.y;
    const perpDist = Math.max(Math.abs(perpX), Math.abs(perpY));
    if (perpDist * 2 <= width + 1) {
      hits.push({ id, d: t });
    }
  }
  hits.sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hits.map((h) => h.id);
}

function directionToVec(d: LineCastInput['direction']): { x: number; y: number } {
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

// ─────────────────────────────────────────────────────────
// AoE resolver — circle
// ─────────────────────────────────────────────────────────

export interface AoeCastInput {
  center: Position;
  radius: number;
  maxHits?: number;
}

export function resolveAoeHits(layer: SpatialLayerState, aoe: AoeCastInput): string[] {
  const radius = Math.max(1, aoe.radius);
  const hits: { id: string; d: number }[] = [];
  for (const [id, pos] of layer.positions) {
    const d = chebyshevDistance(aoe.center, pos);
    if (d <= radius) hits.push({ id, d });
  }
  hits.sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (aoe.maxHits !== undefined && aoe.maxHits > 0) {
    return hits.slice(0, aoe.maxHits).map((h) => h.id);
  }
  return hits.map((h) => h.id);
}

// ─────────────────────────────────────────────────────────
// Proximity resolver — near/far classification
// ─────────────────────────────────────────────────────────

export type ProximityClass = 'near' | 'mid' | 'far';

export interface ProximityReport {
  entityId: string;
  distance: number;
  cls: ProximityClass;
}

export function classifyProximity(
  layer: SpatialLayerState,
  origin: Position,
  entityIds?: readonly string[],
): ProximityReport[] {
  const ids = entityIds ?? [...layer.positions.keys()];
  const out: ProximityReport[] = [];
  for (const id of ids) {
    const pos = layer.positions.get(id);
    if (!pos) continue;
    const d = chebyshevDistance(origin, pos);
    let cls: ProximityClass = 'mid';
    if (d <= NpcConstants.SPATIAL_PROXIMITY_NEAR_THRESHOLD) cls = 'near';
    else if (d > NpcConstants.SPATIAL_PROXIMITY_FAR_THRESHOLD) cls = 'far';
    out.push({ entityId: id, distance: d, cls });
  }
  out.sort((a, b) => a.distance - b.distance || (a.entityId < b.entityId ? -1 : 1));
  return out;
}

// ─────────────────────────────────────────────────────────
// Distance map — for threat resolver hot-path
// ─────────────────────────────────────────────────────────

export function buildLayerDistanceMap(
  layer: SpatialLayerState,
  origin: Position,
  entityIds?: readonly string[],
): Map<string, number> {
  const ids = entityIds ?? [...layer.positions.keys()];
  const out = new Map<string, number>();
  for (const id of ids) {
    const pos = layer.positions.get(id);
    if (pos) out.set(id, chebyshevDistance(origin, pos));
  }
  return out;
}

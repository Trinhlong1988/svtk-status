/**
 * SPAWN SYSTEM — region + rule + density + lifecycle + registry (Phase 5).
 *
 * 5 spawn type: static / timed / event / regional / wave / boss.
 * Density control + respawn policy. Server authoritative.
 *
 * RNG (CMD1 FIX #1): caller MUST pass `rng_spawn` substream.
 * DO NOT pass `rng_loot` — sharing substream creates replay desync risk
 * when loot consumption order changes.
 *
 * All gộp 1 file (avoid fragmentation).
 */
import { z } from 'zod';
import { npcRegistry } from './npc_registry.js';
import { NpcConstants } from './npc_constants.js';
import type { RNG } from './rng.js';
import type { TeamId } from './combat_entity.js';
import type { Position } from './spatial_threat.js';

// ─────────────────────────────────────────────────────────
// Spawn rule
// ─────────────────────────────────────────────────────────

export const SpawnTypeSchema = z.enum([
  'static',
  'timed',
  'event',
  'regional',
  'wave',
  'boss',
]);
export type SpawnType = z.infer<typeof SpawnTypeSchema>;

export const SpawnRuleSchema = z.object({
  ruleId: z.string().min(1).max(64),
  type: SpawnTypeSchema,
  /** NPC ids that may spawn (weighted random pick from list). */
  npcIds: z.array(z.string()).min(1),
  /** Region id this rule belongs to. */
  regionId: z.string().min(1),
  /** Max concurrent NPCs from this rule. */
  maxConcurrent: z.number().int().positive().optional(),
  /** Respawn cooldown turn (after kill). */
  respawnCooldownTurns: z.number().int().nonnegative().optional(),
  /** Wave size (for wave type). */
  waveSize: z.number().int().positive().optional(),
  /** Wave interval turn (for wave type). */
  waveIntervalTurns: z.number().int().positive().optional(),
  /** Event trigger id (for event type — caller fires). */
  eventTriggerId: z.string().optional(),
  /** Spawn weight (for weighted random pool). */
  weight: z.number().int().positive().optional(),
});
export type SpawnRule = z.infer<typeof SpawnRuleSchema>;

// ─────────────────────────────────────────────────────────
// Spawn region
// ─────────────────────────────────────────────────────────

export const SpawnRegionSchema = z.object({
  regionId: z.string().min(1),
  name: z.string().optional(),
  /** Center/origin position. */
  origin: z.object({ x: z.number().int(), y: z.number().int() }),
  /** Radius cell. */
  radius: z.number().int().positive(),
  /** Max NPCs total in region. */
  maxNpcs: z.number().int().positive().optional(),
});
export type SpawnRegion = z.infer<typeof SpawnRegionSchema>;

// ─────────────────────────────────────────────────────────
// Spawn lifecycle entry
// ─────────────────────────────────────────────────────────

export interface SpawnedEntry {
  instanceId: string;
  npcId: string;
  regionId: string;
  ruleId: string;
  spawnedAtTurn: number;
  /** CMD1 FIX #6 — monotonic spawn sequence id (replay/rollback/debug). */
  spawnSequenceId: number;
  position: Position;
  /** turn at which respawn becomes eligible (after kill). undefined = alive. */
  respawnEligibleTurn?: number;
  /** Alive flag. */
  alive: boolean;
  teamId: TeamId;
}

// ─────────────────────────────────────────────────────────
// Spawn registry — region + rule + active entries
// ─────────────────────────────────────────────────────────

export class WorldSpawnRegistry {
  private regions = new Map<string, SpawnRegion>();
  private rules = new Map<string, SpawnRule>();
  private rulesByRegion = new Map<string, Set<string>>();
  private active = new Map<string, SpawnedEntry>();        // instanceId → entry
  private activeByRule = new Map<string, Set<string>>();
  private activeByRegion = new Map<string, Set<string>>();
  private nextInstanceSeq = 0;

  registerRegion(region: SpawnRegion): void {
    const r = SpawnRegionSchema.parse(region);
    if (this.regions.has(r.regionId)) throw new Error(`[Spawn] dup region '${r.regionId}'`);
    this.regions.set(r.regionId, r);
  }

  registerRule(rule: SpawnRule): void {
    const r = SpawnRuleSchema.parse(rule);
    if (!this.regions.has(r.regionId)) {
      throw new Error(`[Spawn] rule '${r.ruleId}' refers unknown region '${r.regionId}'`);
    }
    for (const npcId of r.npcIds) {
      if (!npcRegistry.has(npcId)) {
        throw new Error(`[Spawn] rule '${r.ruleId}' refers unknown npcId '${npcId}'`);
      }
    }
    if (this.rules.has(r.ruleId)) throw new Error(`[Spawn] dup rule '${r.ruleId}'`);
    this.rules.set(r.ruleId, r);
    addToBucket(this.rulesByRegion, r.regionId, r.ruleId);
  }

  /**
   * Spawn 1 NPC from rule. Caller may invoke per tick / event.
   * Returns spawned entry, or null if cap reached.
   *
   * Deterministic: picks npcId from rule.npcIds by rng()% length (weighted).
   */
  spawn(ruleId: string, currentTurn: number, rng: RNG, teamId: TeamId = 'team_b'): SpawnedEntry | null {
    const rule = this.rules.get(ruleId);
    if (!rule) return null;
    const region = this.regions.get(rule.regionId);
    if (!region) return null;

    // Cap checks
    const regionCap = region.maxNpcs ?? NpcConstants.SPAWN_REGION_MAX_NPC_DEFAULT;
    const regionCount = this.activeByRegion.get(rule.regionId)?.size ?? 0;
    if (regionCount >= regionCap) return null;
    if (rule.maxConcurrent !== undefined) {
      const ruleCount = this.activeByRule.get(ruleId)?.size ?? 0;
      if (ruleCount >= rule.maxConcurrent) return null;
    }

    // Pick NPC weighted (deterministic via rng)
    const npcId = pickNpc(rule.npcIds, rng);
    if (!npcId) return null;

    const spawnSeq = this.nextInstanceSeq++;
    const instanceId = `spawn_${spawnSeq}_${npcId}`;
    const entry: SpawnedEntry = {
      instanceId,
      npcId,
      regionId: rule.regionId,
      ruleId,
      spawnedAtTurn: currentTurn,
      spawnSequenceId: spawnSeq,
      position: pickPosition(region, rng),
      alive: true,
      teamId,
    };
    this.active.set(instanceId, entry);
    addToBucket(this.activeByRule, ruleId, instanceId);
    addToBucket(this.activeByRegion, rule.regionId, instanceId);
    return entry;
  }

  /** Mark dead — schedule respawn cooldown. */
  markDead(instanceId: string, currentTurn: number): boolean {
    const e = this.active.get(instanceId);
    if (!e) return false;
    e.alive = false;
    const rule = this.rules.get(e.ruleId);
    const cd = rule?.respawnCooldownTurns ?? NpcConstants.SPAWN_RESPAWN_MIN_TURNS;
    e.respawnEligibleTurn = currentTurn + cd;
    return true;
  }

  /** Despawn — fully remove (cleanup). */
  despawn(instanceId: string): boolean {
    const e = this.active.get(instanceId);
    if (!e) return false;
    this.active.delete(instanceId);
    removeFromBucket(this.activeByRule, e.ruleId, instanceId);
    removeFromBucket(this.activeByRegion, e.regionId, instanceId);
    return true;
  }

  /** Eligible for respawn at currentTurn (callable per spawn tick). */
  eligibleRespawnIds(currentTurn: number): string[] {
    const out: string[] = [];
    for (const e of this.active.values()) {
      if (!e.alive && e.respawnEligibleTurn !== undefined && currentTurn >= e.respawnEligibleTurn) {
        out.push(e.instanceId);
      }
    }
    out.sort();
    return out;
  }

  getEntry(instanceId: string): SpawnedEntry | undefined {
    return this.active.get(instanceId);
  }

  getRegion(regionId: string): SpawnRegion | undefined { return this.regions.get(regionId); }
  getRule(ruleId: string): SpawnRule | undefined { return this.rules.get(ruleId); }

  size(): { regions: number; rules: number; active: number } {
    return { regions: this.regions.size, rules: this.rules.size, active: this.active.size };
  }

  /** Stats for telemetry. */
  metrics(): {
    activeByRegion: Record<string, number>;
    activeByRule: Record<string, number>;
    totalActive: number;
  } {
    const byRegion: Record<string, number> = {};
    for (const [k, v] of this.activeByRegion) byRegion[k] = v.size;
    const byRule: Record<string, number> = {};
    for (const [k, v] of this.activeByRule) byRule[k] = v.size;
    return { activeByRegion: byRegion, activeByRule: byRule, totalActive: this.active.size };
  }

  _reset(): void {
    this.regions.clear();
    this.rules.clear();
    this.rulesByRegion.clear();
    this.active.clear();
    this.activeByRule.clear();
    this.activeByRegion.clear();
    this.nextInstanceSeq = 0;
  }
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function pickNpc(npcIds: readonly string[], rng: RNG): string | undefined {
  if (npcIds.length === 0) return undefined;
  const idx = Math.floor(rng() * npcIds.length);
  const safe = Math.min(idx, npcIds.length - 1);
  return npcIds[safe];
}

function pickPosition(region: SpawnRegion, rng: RNG): Position {
  // Deterministic offset within radius — INT only (avoid float literal in hot-path).
  // Map rng() [0..1) → integer BP [0..10000), then center to [-5000..5000] and scale by radius.
  const rxBP = Math.floor(rng() * 10000);
  const ryBP = Math.floor(rng() * 10000);
  const dx = Math.floor(((rxBP - 5000) * region.radius) / 5000);
  const dy = Math.floor(((ryBP - 5000) * region.radius) / 5000);
  return { x: region.origin.x + dx, y: region.origin.y + dy };
}

function addToBucket<K>(map: Map<K, Set<string>>, key: K, value: string): void {
  let set = map.get(key);
  if (!set) { set = new Set(); map.set(key, set); }
  set.add(value);
}

function removeFromBucket<K>(map: Map<K, Set<string>>, key: K, value: string): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) map.delete(key);
}


/**
 * ENTITY LIFECYCLE — full world entity state machine (Phase 5).
 *
 * Gộp 4 module: entity_lifecycle + orphan_guard + world_entity_state + faction.
 *
 * Lifecycle states:
 *   spawned → combat_enter → (active) → combat_leave → out_of_combat → despawned
 *                          ↘ death → despawned (after grace)
 *                          ↘ encounter_reset → out_of_combat
 *
 * CMD1 hardening (Phase 6 readiness):
 *   - FIX #4  entity_persistence_policy — sweep MUST respect policy
 *   - FIX #8  back-pressure register() — soft reject + evict, NOT hard throw
 *   - FIX #10 ENTITY_SCHEMA_VERSION — schema versioning for snapshot/restore
 */
import { z } from 'zod';
import { NpcConstants } from './npc_constants.js';

/**
 * CMD1 FIX #10 — schema version stamped on every world entity.
 * Bump when WorldEntityState shape changes (added/removed/typed fields).
 * Snapshot/restore MUST check version compatibility before mutating entity shape.
 */
export const ENTITY_SCHEMA_VERSION = 1 as const;

export type LifecycleState =
  | 'spawned'
  | 'combat_active'
  | 'combat_leaving'
  | 'out_of_combat'
  | 'dead'
  | 'despawned';

export const FactionRelationSchema = z.enum([
  'hostile',
  'neutral',
  'ally',
  'summon_owner',
  'companion_owner',
]);
export type FactionRelation = z.infer<typeof FactionRelationSchema>;

/**
 * CMD1 FIX #4 — persistence policy. Sweep MUST respect this.
 *
 *   - persistent         : never sweep (vendor, quest giver, named NPC, world boss alive)
 *   - cinematic_locked   : never sweep while scene/script holds lock
 *   - encounter_bound    : sweep ONLY when owner encounter ends
 *   - world_static       : never sweep (ambient world geometry/NPC)
 *   - temporary          : default rules (dead > 10t, OOC > 60t → despawn)
 */
export const EntityPersistencePolicySchema = z.enum([
  'persistent',
  'cinematic_locked',
  'encounter_bound',
  'world_static',
  'temporary',
]);
export type EntityPersistencePolicy = z.infer<typeof EntityPersistencePolicySchema>;

export interface WorldEntityState {
  entityId: string;
  lifecycle: LifecycleState;
  spawnedAtTurn: number;
  lastTurnSeen: number;
  faction: string;
  /** Owner id (for companion/summon). */
  ownerEntityId?: string;
  /** Death turn (for despawn cleanup). */
  deathTurn?: number;
  /** OOC turn (for orphan sweep). */
  oocTurn?: number;
  /** CMD1 FIX #4 — persistence policy (default `temporary`). */
  persistencePolicy?: EntityPersistencePolicy;
  /** CMD1 FIX #8 — eviction priority (higher = keep longer). Default 0. */
  evictionPriority?: number;
  /** CMD1 FIX #10 — schema version snapshot stamp. */
  schemaVersion?: number;
}

/**
 * CMD1 FIX #8 — back-pressure outcome (replaces hard throw on overflow).
 *
 *   - accepted          : added to registry
 *   - rejected_capacity : registry full + caller is low priority → spawn cancelled
 *   - accepted_evicted  : registry full but evicted a lower-priority entity → added
 */
export type RegisterOutcome =
  | { status: 'accepted' }
  | { status: 'rejected_capacity'; reason: string }
  | { status: 'accepted_evicted'; evictedEntityId: string };

// ─────────────────────────────────────────────────────────
// World registry
// ─────────────────────────────────────────────────────────

export class WorldEntityRegistry {
  private entities = new Map<string, WorldEntityState>();
  private byFaction = new Map<string, Set<string>>();
  private byOwner = new Map<string, Set<string>>();

  /**
   * Legacy hard-throw register — kept for backward compat with existing call sites
   * that treat register failures as programmer error (test setup, fixed-roster fixtures).
   * Production caller SHOULD use `tryRegister()` which returns a RegisterOutcome
   * and applies back-pressure (CMD1 FIX #8).
   */
  register(state: WorldEntityState): void {
    if (this.entities.size >= NpcConstants.MAX_WORLD_ENTITIES) {
      throw new Error(`[WorldEntityRegistry] MAX_WORLD_ENTITIES exceeded`);
    }
    this.insertEntity(state);
  }

  /**
   * CMD1 FIX #8 — back-pressure register. Returns outcome instead of throwing.
   *
   * Policy on overflow:
   *   1. Find lowest-priority `temporary` entity with priority < incoming priority
   *   2. If found → evict it, accept incoming (status `accepted_evicted`)
   *   3. Else → reject incoming (status `rejected_capacity`)
   *
   * Persistent / cinematic_locked / world_static / encounter_bound entities
   * are NEVER eligible for eviction (only `temporary` may be evicted).
   */
  tryRegister(state: WorldEntityState): RegisterOutcome {
    if (this.entities.size < NpcConstants.MAX_WORLD_ENTITIES) {
      this.insertEntity(state);
      return { status: 'accepted' };
    }

    const incomingPriority = state.evictionPriority ?? 0;
    let evictTarget: WorldEntityState | undefined;
    let evictTargetPriority = Infinity;

    for (const e of this.entities.values()) {
      const policy = e.persistencePolicy ?? 'temporary';
      if (policy !== 'temporary') continue;
      const prio = e.evictionPriority ?? 0;
      if (prio >= incomingPriority) continue;
      if (prio < evictTargetPriority) {
        evictTarget = e;
        evictTargetPriority = prio;
      }
    }

    if (evictTarget) {
      const evictedId = evictTarget.entityId;
      this.drop(evictedId);
      this.insertEntity(state);
      return { status: 'accepted_evicted', evictedEntityId: evictedId };
    }

    return {
      status: 'rejected_capacity',
      reason: `MAX_WORLD_ENTITIES=${NpcConstants.MAX_WORLD_ENTITIES} reached; no evictable temporary entity below priority ${incomingPriority}`,
    };
  }

  private insertEntity(state: WorldEntityState): void {
    if (state.schemaVersion === undefined) state.schemaVersion = ENTITY_SCHEMA_VERSION;
    if (state.persistencePolicy === undefined) state.persistencePolicy = 'temporary';
    this.entities.set(state.entityId, state);
    addBucket(this.byFaction, state.faction, state.entityId);
    if (state.ownerEntityId) addBucket(this.byOwner, state.ownerEntityId, state.entityId);
  }

  get(entityId: string): WorldEntityState | undefined {
    return this.entities.get(entityId);
  }

  transitionTo(entityId: string, state: LifecycleState, currentTurn: number): boolean {
    const e = this.entities.get(entityId);
    if (!e) return false;
    e.lifecycle = state;
    e.lastTurnSeen = currentTurn;
    if (state === 'dead') e.deathTurn = currentTurn;
    if (state === 'out_of_combat') e.oocTurn = currentTurn;
    return true;
  }

  drop(entityId: string): boolean {
    const e = this.entities.get(entityId);
    if (!e) return false;
    this.entities.delete(entityId);
    removeBucket(this.byFaction, e.faction, entityId);
    if (e.ownerEntityId) removeBucket(this.byOwner, e.ownerEntityId, entityId);
    return true;
  }

  size(): number { return this.entities.size; }

  /** All entities in faction. */
  inFaction(faction: string): readonly string[] {
    const ids = this.byFaction.get(faction);
    return ids ? [...ids].sort() : [];
  }

  /** Companions/summons of owner. */
  ownedBy(ownerId: string): readonly string[] {
    const ids = this.byOwner.get(ownerId);
    return ids ? [...ids].sort() : [];
  }

  /** Iterate all entities (read-only). */
  all(): readonly Readonly<WorldEntityState>[] {
    return [...this.entities.values()];
  }

  _reset(): void {
    this.entities.clear();
    this.byFaction.clear();
    this.byOwner.clear();
  }
}

// ─────────────────────────────────────────────────────────
// Faction relation resolver
// ─────────────────────────────────────────────────────────

export interface FactionRelationEntry {
  fromFaction: string;
  toFaction: string;
  relation: FactionRelation;
}

export class FactionRuntime {
  private relations = new Map<string, FactionRelation>();    // "from|to" → relation

  setRelation(from: string, to: string, relation: FactionRelation): void {
    this.relations.set(`${from}|${to}`, relation);
  }

  getRelation(from: string, to: string): FactionRelation {
    return this.relations.get(`${from}|${to}`) ?? 'neutral';
  }

  isHostile(from: string, to: string): boolean {
    return this.getRelation(from, to) === 'hostile';
  }

  isAlly(from: string, to: string): boolean {
    const r = this.getRelation(from, to);
    return r === 'ally' || r === 'summon_owner' || r === 'companion_owner';
  }

  registerAll(entries: readonly FactionRelationEntry[]): void {
    for (const e of entries) this.setRelation(e.fromFaction, e.toFaction, e.relation);
  }

  _reset(): void {
    this.relations.clear();
  }

  size(): number {
    return this.relations.size;
  }
}

// ─────────────────────────────────────────────────────────
// Orphan guard — sweep dead/despawned references
// ─────────────────────────────────────────────────────────

export interface OrphanSweepReport {
  orphansRemoved: string[];
  longDeadRemoved: string[];
  oocExpiredRemoved: string[];
  totalSwept: number;
}

/**
 * CMD1 FIX #4 — does this entity's persistence policy allow time-based sweep?
 *
 *   - persistent / cinematic_locked / world_static : NO  (immune to dead-grace / OOC sweep)
 *   - encounter_bound : NO (caller cleans up when encounter ends, not here)
 *   - temporary       : YES (default)
 *
 * Orphan sweep (owner-missing) STILL applies regardless of policy — orphan implies
 * already invalid state from external mutation.
 */
function isPolicyEligibleForSweep(state: WorldEntityState): boolean {
  const policy = state.persistencePolicy ?? 'temporary';
  return policy === 'temporary';
}

/**
 * Sweep orphan + long-dead + OOC-expired entities.
 *
 * Rules (CMD1 FIX #4 — respects entity_persistence_policy):
 *   - dead > 10 turn → despawn (only `temporary` policy)
 *   - OOC > COMPANION_PERSISTENCE_OUT_OF_COMBAT_TURNS → despawn (only `temporary` policy)
 *   - owner-bound entity but owner not in registry → orphan (all policies — invalid state)
 */
export function sweepOrphans(
  registry: WorldEntityRegistry,
  currentTurn: number,
): OrphanSweepReport {
  const orphans: string[] = [];
  const longDead: string[] = [];
  const oocExpired: string[] = [];

  for (const e of registry.all()) {
    // Orphan sweep ignores policy — orphan = invalid state, always remove.
    if (e.ownerEntityId && !registry.get(e.ownerEntityId)) {
      orphans.push(e.entityId);
      continue;
    }
    if (!isPolicyEligibleForSweep(e)) continue;
    if (e.lifecycle === 'dead' && e.deathTurn !== undefined && currentTurn - e.deathTurn > 10) {
      longDead.push(e.entityId);
      continue;
    }
    if (e.lifecycle === 'out_of_combat' && e.oocTurn !== undefined &&
      currentTurn - e.oocTurn > NpcConstants.COMPANION_PERSISTENCE_OUT_OF_COMBAT_TURNS) {
      oocExpired.push(e.entityId);
      continue;
    }
  }

  for (const id of orphans) registry.drop(id);
  for (const id of longDead) registry.drop(id);
  for (const id of oocExpired) registry.drop(id);

  return {
    orphansRemoved: orphans,
    longDeadRemoved: longDead,
    oocExpiredRemoved: oocExpired,
    totalSwept: orphans.length + longDead.length + oocExpired.length,
  };
}

function addBucket<K>(map: Map<K, Set<string>>, key: K, id: string): void {
  let set = map.get(key);
  if (!set) { set = new Set(); map.set(key, set); }
  set.add(id);
}

function removeBucket<K>(map: Map<K, Set<string>>, key: K, id: string): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(id);
  if (set.size === 0) map.delete(key);
}

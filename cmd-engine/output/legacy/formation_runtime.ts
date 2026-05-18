/**
 * FORMATION RUNTIME — state machine + slot exposure + distance (Phase 5).
 *
 * Extends battle_formation + formation_threat with runtime state:
 *   - active formation per team (front/back/companion/reserve slot)
 *   - line relation (slot N exposed when line passes through)
 *   - exposure score per slot (front more exposed than back)
 *   - formation reset (leash trigger / wipe)
 */
import { z } from 'zod';
import type { BattleField, TeamId } from './combat_entity.js';
import { aliveEntitiesInTeam, companionOf } from './battle_formation.js';
import { classifyFormation } from './formation_threat.js';
import { NpcConstants } from './npc_constants.js';

export const FormationProfileSchema = z.enum([
  'standard_5v5',
  'tank_wall',
  'mage_back',
  'dispersed',
  'turtle',
]);
export type FormationProfile = z.infer<typeof FormationProfileSchema>;

/**
 * CMD1 FIX #9 — reasons a formation gets reset.
 *
 * Telemetry + boss-mechanic dispatcher MUST tag every reset with a reason
 * so analytics + replay can distinguish leash from raid mechanic.
 *
 *   - leash             : leash trigger snap-back (NPC chase exit)
 *   - wipe              : team wipe → next encounter restart
 *   - knockback         : skill-driven knockback
 *   - forced_movement   : forced reposition (push/pull/teleport)
 *   - formation_collapse: line broke (tank wall fell, etc.)
 *   - raid_mechanic     : boss mechanic (phase shift, room move, scripted move)
 *   - manual            : operator/admin reset
 */
export const FormationResetReasonSchema = z.enum([
  'leash',
  'wipe',
  'knockback',
  'forced_movement',
  'formation_collapse',
  'raid_mechanic',
  'manual',
]);
export type FormationResetReason = z.infer<typeof FormationResetReasonSchema>;

export interface FormationRuntimeState {
  teamId: TeamId;
  profile: FormationProfile;
  /** Cell offset of formation origin (for movement). */
  origin: { x: number; y: number };
  /** Last time formation reset. */
  lastResetTurn: number;
  /** CMD1 FIX #9 — reason for last reset (undefined = never reset). */
  lastResetReason?: FormationResetReason;
  /** CMD1 FIX #9 — monotonic reset count for telemetry. */
  resetCount: number;
}

export function createFormationRuntime(
  teamId: TeamId,
  profile: FormationProfile = 'standard_5v5',
): FormationRuntimeState {
  return {
    teamId,
    profile,
    origin: { x: 0, y: 0 },
    lastResetTurn: 0,
    resetCount: 0,
  };
}

/**
 * Reset formation. `reason` is REQUIRED (CMD1 FIX #9) — telemetry MUST distinguish
 * leash vs raid mechanic vs knockback vs manual operator reset.
 */
export function resetFormation(
  state: FormationRuntimeState,
  currentTurn: number,
  reason: FormationResetReason,
): void {
  state.lastResetTurn = currentTurn;
  state.lastResetReason = reason;
  state.resetCount += 1;
  state.profile = 'standard_5v5';
}

// ─────────────────────────────────────────────────────────
// Slot exposure
// ─────────────────────────────────────────────────────────

export interface SlotExposureReport {
  slot: number;
  row: 'front' | 'mid' | 'back';
  edge: 'edge' | 'center';
  /** Exposure score 0..100 (higher = more exposed). */
  exposure: number;
}

export function reportSlotExposure(slot: number): SlotExposureReport {
  const c = classifyFormation(slot);
  // Convert mult BP to exposure score (range ~80-150 BP → 0-100 score)
  // front edge ~13200 → max exposure; back center ~8000 → low exposure
  const norm = Math.max(0, c.multBP - 8000);
  const score = Math.min(100, Math.floor(norm / 70));    // 0..100 approx
  return { slot, row: c.row, edge: c.edge, exposure: score };
}

// ─────────────────────────────────────────────────────────
// Formation distance — slot-to-slot helper
// ─────────────────────────────────────────────────────────

/**
 * Cell distance between 2 slots in 5v5 layout.
 *
 * Layout (team A view):
 *   Front row: slot 0 (left), 1 (center), 2 (right)
 *   Mid row:   slot 3 (left-mid), 4 (right-mid)
 *   Back row:  slot 5, 6, 7, 8, 9
 *
 * Returns Chebyshev distance assuming standard 3-cell wide × 3-row layout.
 */
export function slotDistance(a: number, b: number): number {
  const pa = slotToCell(a);
  const pb = slotToCell(b);
  return Math.max(Math.abs(pa.x - pb.x), Math.abs(pa.y - pb.y));
}

function slotToCell(slot: number): { x: number; y: number } {
  if (slot >= 0 && slot <= 2) return { x: slot, y: 0 };         // front
  if (slot >= 3 && slot <= 4) return { x: slot - 3, y: 1 };     // mid
  if (slot >= 5 && slot <= 7) return { x: slot - 5, y: 2 };     // back row
  return { x: slot - 8, y: 3 };                                  // back-back (slot 8,9)
}

// ─────────────────────────────────────────────────────────
// Line relation — does line AoE expose slot N?
// ─────────────────────────────────────────────────────────

export function slotsOnLine(originSlot: number, direction: 'horizontal' | 'vertical'): readonly number[] {
  const o = slotToCell(originSlot);
  const out: number[] = [];
  for (let s = 0; s < NpcConstants.SPATIAL_GRID_SIZE * 10 && s < 10; s++) {
    const p = slotToCell(s);
    if (direction === 'horizontal' && p.y === o.y) out.push(s);
    if (direction === 'vertical' && p.x === o.x) out.push(s);
  }
  return out;
}

/**
 * Active formation summary — for telemetry + UI.
 */
export interface FormationSummary {
  teamId: TeamId;
  aliveMain: string[];
  aliveCompanion: string[];
  emptySlots: number[];
}

export function summarizeFormation(state: FormationRuntimeState, field: BattleField): FormationSummary {
  const alive = aliveEntitiesInTeam(field, state.teamId);
  const aliveMain: string[] = [];
  const aliveComp: string[] = [];
  for (const id of alive) {
    const e = field.entitiesById.get(id);
    if (!e) continue;
    if (e.companionTag === 'companion') aliveComp.push(id);
    else aliveMain.push(id);
  }
  // Empty slots
  const empty: number[] = [];
  const slots = field.bySlot.get(state.teamId);
  if (slots) {
    for (let s = 0; s < 10; s++) {
      if (!slots.has(s)) empty.push(s);
    }
  }
  return { teamId: state.teamId, aliveMain, aliveCompanion: aliveComp, emptySlots: empty };
}

void companionOf;

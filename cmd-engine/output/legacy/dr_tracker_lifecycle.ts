/**
 * DR TRACKER LIFECYCLE — memory hardening (FIX #5).
 *
 * DR tracker là Map<targetId, Map<DRGroup, DRTrackerEntry>> owned by encounter.
 * Long-running raid (45 phút world boss) có thể accumulate 100+ target → memory leak
 * nếu không cleanup khi:
 *   - target died và despawned khỏi encounter
 *   - DR entry expired vượt reset window
 *   - encounter end (post-combat assertion)
 *
 * Pure helpers — caller (encounter manager) call mỗi turn end.
 */
import type { DRTrackerEntry, DRGroup } from './status_types.js';
import { StatusConstants } from './status_constants.js';

/** Reset turns lookup (mirror of diminishing_return.ts). */
function resetTurnsFor(group: DRGroup): number {
  switch (group) {
    case 'hard_cc': return StatusConstants.DR_RESET_TURNS_HARD_CC;
    case 'soft_cc': return StatusConstants.DR_RESET_TURNS_SOFT_CC;
    case 'dot':     return StatusConstants.DR_RESET_TURNS_DOT;
    case 'hot':     return StatusConstants.DR_RESET_TURNS_HOT;
    case 'none':    return 0;
  }
}

export interface DRTrackerCleanupReport {
  staleEntriesRemoved: number;
  emptyTargetsRemoved: number;
  totalEntriesRemaining: number;
}

/**
 * Sweep stale tracker entries. Call mỗi N turn (vd 10 turn) hoặc on-demand.
 *
 * Stale = (currentTurn - lastTriggerTurn) > resetTurns + RESET_BUFFER
 * Buffer = 2× resetTurns để đảm bảo không xóa entry vẫn còn ý nghĩa cho fresh apply
 * (vì fresh apply cần biết rằng "DR đã reset" — sau buffer mới chắc chắn an toàn xóa).
 */
export function sweepDRTrackers(
  trackers: Map<string, Map<string, DRTrackerEntry>>,
  currentTurn: number,
): DRTrackerCleanupReport {
  let staleRemoved = 0;
  let emptyRemoved = 0;
  for (const [targetId, byGroup] of trackers) {
    for (const [group, entry] of byGroup) {
      const reset = resetTurnsFor(entry.group);
      if (reset === 0) continue;     // 'none' group never expires
      const elapsed = currentTurn - entry.lastTriggerTurn;
      if (elapsed > reset * 2) {
        byGroup.delete(group);
        staleRemoved++;
      }
    }
    if (byGroup.size === 0) {
      trackers.delete(targetId);
      emptyRemoved++;
    }
  }
  let total = 0;
  for (const byGroup of trackers.values()) total += byGroup.size;
  return {
    staleEntriesRemoved: staleRemoved,
    emptyTargetsRemoved: emptyRemoved,
    totalEntriesRemaining: total,
  };
}

/**
 * Drop tracker for a specific target. Call when target despawns / dies / leaves zone.
 */
export function dropDRTrackersFor(
  trackers: Map<string, Map<string, DRTrackerEntry>>,
  targetId: string,
): boolean {
  return trackers.delete(targetId);
}

/**
 * Encounter-end assertion. Caller invoke khi combat resolved.
 * Returns metric để telemetry log; ALSO clears all entries (encounter is dead).
 */
export function assertAndClearOnEncounterEnd(
  trackers: Map<string, Map<string, DRTrackerEntry>>,
): { entriesAtEnd: number; targetsAtEnd: number } {
  const targetsAtEnd = trackers.size;
  let entriesAtEnd = 0;
  for (const byGroup of trackers.values()) entriesAtEnd += byGroup.size;
  trackers.clear();
  return { entriesAtEnd, targetsAtEnd };
}

/**
 * Tracker growth metric — for telemetry watchdog (alert nếu > threshold).
 */
export function measureDRTrackerSize(
  trackers: Map<string, Map<string, DRTrackerEntry>>,
): { targets: number; entries: number; maxGroupsPerTarget: number } {
  let entries = 0;
  let maxGroups = 0;
  for (const byGroup of trackers.values()) {
    entries += byGroup.size;
    if (byGroup.size > maxGroups) maxGroups = byGroup.size;
  }
  return { targets: trackers.size, entries, maxGroupsPerTarget: maxGroups };
}

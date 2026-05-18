/**
 * STATUS POOL — object pool + shallow freeze fast path (FIX #9).
 *
 * Goal: world boss raid 30+ phút × 50 effect/sec = 90k StatusEffect alloc/min →
 * GC spike. Pool reuses object slot; frozen instances eliminate accidental
 * mutation outside whitelist.
 *
 * Two layer:
 *   - Pool: acquire() returns mutable StatusEffect (or fresh); release(eff) returns
 *     to pool. Caller MUST release on expire/cleanse/overwrite.
 *   - Freeze: shallowFreezeStatus(eff) → Object.freeze. Used khi pass to listener
 *     read-only context (telemetry / passive observe).
 *
 * Backward compat: pool optional. apply_effect.ts dùng plain alloc khi pool undefined.
 */
import type { StatusEffect } from './status_types.js';

/** Default initial pool capacity — sized cho world-boss raid 100 char × 5 effect avg. */
const DEFAULT_POOL_CAPACITY = 512;
/** Hard cap — anti-OOM nếu caller forget release. */
const HARD_CAP = 8192;

export interface StatusPoolMetrics {
  totalAcquired: number;
  totalReleased: number;
  totalAllocated: number;
  currentInUse: number;
  currentFree: number;
  highWaterMark: number;
}

export class StatusPool {
  private free: StatusEffect[] = [];
  private inUseCount = 0;
  private metrics: StatusPoolMetrics = {
    totalAcquired: 0,
    totalReleased: 0,
    totalAllocated: 0,
    currentInUse: 0,
    currentFree: 0,
    highWaterMark: 0,
  };

  constructor(private readonly capacity: number = DEFAULT_POOL_CAPACITY) {}

  /** Acquire a slot. Caller fills all required fields. */
  acquire(template: StatusEffect): StatusEffect {
    let slot = this.free.pop();
    if (!slot) {
      if (this.metrics.totalAllocated >= HARD_CAP) {
        throw new Error(`[StatusPool] HARD_CAP exceeded (${HARD_CAP}) — leak suspected`);
      }
      slot = { ...template };
      this.metrics.totalAllocated++;
    } else {
      // Reuse — copy fields from template
      Object.assign(slot, template);
    }
    this.inUseCount++;
    this.metrics.totalAcquired++;
    this.metrics.currentInUse = this.inUseCount;
    this.metrics.currentFree = this.free.length;
    if (this.inUseCount > this.metrics.highWaterMark) {
      this.metrics.highWaterMark = this.inUseCount;
    }
    return slot;
  }

  /** Release a slot back to pool. Caller MUST not retain reference. */
  release(eff: StatusEffect): void {
    if (this.free.length >= this.capacity) {
      // Pool already at capacity — drop slot (GC-able).
      this.inUseCount = Math.max(0, this.inUseCount - 1);
      this.metrics.totalReleased++;
      this.metrics.currentInUse = this.inUseCount;
      this.metrics.currentFree = this.free.length;
      return;
    }
    this.free.push(eff);
    this.inUseCount = Math.max(0, this.inUseCount - 1);
    this.metrics.totalReleased++;
    this.metrics.currentInUse = this.inUseCount;
    this.metrics.currentFree = this.free.length;
  }

  getMetrics(): Readonly<StatusPoolMetrics> {
    return this.metrics;
  }

  /** For test cleanup. */
  _reset(): void {
    this.free = [];
    this.inUseCount = 0;
    this.metrics = {
      totalAcquired: 0,
      totalReleased: 0,
      totalAllocated: 0,
      currentInUse: 0,
      currentFree: 0,
      highWaterMark: 0,
    };
  }
}

/**
 * Shallow freeze — caller wraps StatusEffect when handed to read-only listener.
 * Object.freeze cheap (~50ns), prevents accidental mutation of identity field.
 *
 * Hot path: ONLY freeze nếu OPTION debug. Default skip cho perf.
 */
export function shallowFreezeStatus(eff: StatusEffect): Readonly<StatusEffect> {
  Object.freeze(eff);
  return eff;
}

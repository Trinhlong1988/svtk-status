/**
 * Deterministic RNG wrapper (R6 — Deterministic Combat).
 *
 * Mọi RNG trong Layer 2 Logic PHẢI đi qua đây.
 * KHÔNG dùng Math.random() trong logic — lint rule cấm.
 *
 * Same seed → same sequence. Replay-able cho test + telemetry + anti-cheat.
 */
import seedrandom from 'seedrandom';

/**
 * RNG type — function trả về number trong [0, 1).
 * Truyền qua param, không global.
 */
export type RNG = () => number;

/**
 * Tạo RNG từ seed string.
 *
 * @example
 * const rng = createRNG('encounter_001_turn_5_player_a');
 * const roll = rng();  // 0.xxxxx, deterministic
 */
export function createRNG(seed: string): RNG {
  return seedrandom(seed);
}

/**
 * Tạo seed chuẩn cho encounter — combine encounter ID + turn + action index.
 * Cho phép replay từng action riêng biệt.
 */
export function makeEncounterSeed(encounterId: string, turn: number, actionIndex: number): string {
  return `${encounterId}|t${turn}|a${actionIndex}`;
}

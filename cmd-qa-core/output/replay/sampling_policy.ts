/**
 * R68.4 Sampling Policy — SVTK Foundation v2.8.0
 *
 * 100% replay verification is too expensive at scale. Foundation policy:
 *   PvP battles  : 100% (exploit-critical)
 *   PvE normal   : 5% random sample
 *   Raid boss    : 100% (endgame-critical)
 *   Flagged player: 100% (suspect cheater)
 *
 * Deterministic sampling via injected RNG so audits are reproducible.
 */

export type BattleKind = 'pvp' | 'pve_normal' | 'raid_boss';

export interface SamplingConfig {
  pvpRate?: number; // default 1.0
  pveNormalRate?: number; // default 0.05
  raidBossRate?: number; // default 1.0
  flaggedPlayerOverride?: boolean; // default true (always verify flagged players)
}

export interface BattleMeta {
  battleId: string;
  kind: BattleKind;
  hasFlaggedPlayer: boolean;
}

export const DEFAULT_SAMPLING: Required<SamplingConfig> = {
  pvpRate: 1.0,
  pveNormalRate: 0.05,
  raidBossRate: 1.0,
  flaggedPlayerOverride: true,
};

export type RNG = () => number; // returns [0, 1)

export class SamplingPolicy {
  private readonly cfg: Required<SamplingConfig>;

  constructor(cfg: SamplingConfig = {}) {
    this.cfg = {
      pvpRate: validateRate(cfg.pvpRate ?? DEFAULT_SAMPLING.pvpRate, 'pvpRate'),
      pveNormalRate: validateRate(
        cfg.pveNormalRate ?? DEFAULT_SAMPLING.pveNormalRate,
        'pveNormalRate',
      ),
      raidBossRate: validateRate(cfg.raidBossRate ?? DEFAULT_SAMPLING.raidBossRate, 'raidBossRate'),
      flaggedPlayerOverride: cfg.flaggedPlayerOverride ?? DEFAULT_SAMPLING.flaggedPlayerOverride,
    };
  }

  /**
   * Returns true if the battle should be verified.
   * `rng` is injected for deterministic replay; production callers can
   * pass `() => Math.random()` (R68 verification path is OFF the combat
   * deterministic hot-path, so Math.random IS acceptable here per
   * Foundation R67.1 wall-clock-for-audit rule).
   */
  shouldVerify(battle: BattleMeta, rng: RNG): boolean {
    if (this.cfg.flaggedPlayerOverride && battle.hasFlaggedPlayer) return true;
    const rate = this.rateFor(battle.kind);
    if (rate >= 1) return true;
    if (rate <= 0) return false;
    const v = rng();
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v >= 1) {
      throw new RangeError(`SamplingPolicy.shouldVerify: rng() returned invalid ${v}`);
    }
    return v < rate;
  }

  rateFor(kind: BattleKind): number {
    switch (kind) {
      case 'pvp':
        return this.cfg.pvpRate;
      case 'pve_normal':
        return this.cfg.pveNormalRate;
      case 'raid_boss':
        return this.cfg.raidBossRate;
    }
  }

  getConfig(): Required<SamplingConfig> {
    return { ...this.cfg };
  }
}

function validateRate(r: number, field: string): number {
  if (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r > 1) {
    throw new RangeError(`SamplingPolicy.${field}: must be finite in [0, 1] (got ${r})`);
  }
  return r;
}

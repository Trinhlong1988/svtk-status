-- SVTK Phase 13 Tuần 1 — CMD3 persistence addendum.
-- Adds progression_snapshots table for composite world snapshot envelopes.
-- schema_version DEFAULT 2 per DETERMINISM SWEEP 2026-05-15 (R32 codepoint sort rollover).
-- Stores opaque canonical wire_bytes produced by saveSnapshot() in progression_persistence_adapter.
-- Loader rejects schema_version < 2 unless progression_migration_registry promotes the row.

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- progression_snapshots — composite world snapshot envelopes.
-- segment_id is primary addressing key (UNIQUE), ordinal is monotonic
-- write index for "latest snapshot" lookups + chronological list.
-- wire_bytes is canonical-JSON envelope produced by saveSnapshot().
-- content_checksum is FNV-1a 8-hex over inner snapshot canonical JSON.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS progression_snapshots (
  segment_id        TEXT         PRIMARY KEY,
  char_id           BIGINT       REFERENCES characters(id) ON DELETE CASCADE,
  ordinal           BIGINT       NOT NULL,
  content_checksum  TEXT         NOT NULL,
  wire_bytes        TEXT         NOT NULL,
  schema_version    INTEGER      NOT NULL DEFAULT 2,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT progression_snapshots_ordinal_nonneg CHECK (ordinal >= 0),
  CONSTRAINT progression_snapshots_schema_v2_or_above CHECK (schema_version >= 2),
  CONSTRAINT progression_snapshots_checksum_8hex CHECK (content_checksum ~ '^[0-9a-f]{8}$')
);

CREATE INDEX IF NOT EXISTS idx_progression_snapshots_ordinal ON progression_snapshots(ordinal DESC);
CREATE INDEX IF NOT EXISTS idx_progression_snapshots_char_id ON progression_snapshots(char_id) WHERE char_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- companion_affinity — per-character companion bond state.
-- Persisted on every applyDelta change; loaded on character login.
-- Matches CompanionAffinity shape: tier ∈ {stranger, familiar, trusted, bonded, soulbound}.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companion_affinity (
  char_id              BIGINT       NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  companion_id         TEXT         NOT NULL,
  tier                 TEXT         NOT NULL,
  points               BIGINT       NOT NULL DEFAULT 0,
  next_tier_threshold  BIGINT       NOT NULL DEFAULT 0,
  last_bond_ordinal    BIGINT       NOT NULL DEFAULT 0,
  schema_version       INTEGER      NOT NULL DEFAULT 2,
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (char_id, companion_id),
  CONSTRAINT affinity_tier_known CHECK (tier IN ('stranger','familiar','trusted','bonded','soulbound')),
  CONSTRAINT affinity_points_nonneg CHECK (points >= 0),
  CONSTRAINT affinity_threshold_nonneg CHECK (next_tier_threshold >= 0),
  CONSTRAINT affinity_ordinal_nonneg CHECK (last_bond_ordinal >= 0)
);

CREATE INDEX IF NOT EXISTS idx_companion_affinity_char_id ON companion_affinity(char_id);

-- ─────────────────────────────────────────────────────────────
-- save_rate_limit — per-character save rate-limit tracking.
-- Enforced 1 save / 30s in /api/save endpoint.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS save_rate_limit (
  char_id          BIGINT       PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  last_save_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMIT;

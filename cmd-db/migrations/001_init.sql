-- SVTK Phase 13 Tuần 1 — initial schema (CMD2 Postgres wiring).
-- schema_version = 2 per DETERMINISM SWEEP 2026-05-15 (codepoint sort rollover).
-- All numeric ratio fields stored as INT _BP (×10000, per CLAUDE.md §14).
-- All monetary fields stored as BIGINT to avoid INT32 overflow at endgame wealth scale.

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- 1. players — account-level (1 row per account).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS players (
  id              BIGSERIAL    PRIMARY KEY,
  username        TEXT         NOT NULL UNIQUE,
  email           TEXT         NOT NULL UNIQUE,
  password_hash   TEXT         NOT NULL,
  zalo_id         TEXT         UNIQUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_login      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_players_zalo_id ON players(zalo_id) WHERE zalo_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_players_last_login ON players(last_login DESC) WHERE last_login IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- 2. characters — per-account game character (multi-char per account).
-- linh_chau + luong = SVTK premium currencies.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS characters (
  id              BIGSERIAL    PRIMARY KEY,
  player_id       BIGINT       NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  name            TEXT         NOT NULL,
  class           TEXT         NOT NULL,
  level           INTEGER      NOT NULL DEFAULT 1,
  exp             BIGINT       NOT NULL DEFAULT 0,
  gold            BIGINT       NOT NULL DEFAULT 0,
  linh_chau       BIGINT       NOT NULL DEFAULT 0,
  luong           BIGINT       NOT NULL DEFAULT 0,
  schema_version  INTEGER      NOT NULL DEFAULT 2,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT characters_level_positive CHECK (level >= 1),
  CONSTRAINT characters_exp_nonneg     CHECK (exp >= 0),
  CONSTRAINT characters_gold_nonneg    CHECK (gold >= 0),
  CONSTRAINT characters_linh_nonneg    CHECK (linh_chau >= 0),
  CONSTRAINT characters_luong_nonneg   CHECK (luong >= 0),
  UNIQUE (player_id, name)
);

CREATE INDEX IF NOT EXISTS idx_characters_player_id ON characters(player_id);
CREATE INDEX IF NOT EXISTS idx_characters_level     ON characters(level DESC);

-- ─────────────────────────────────────────────────────────────
-- 3. inventory_items — per-character item instances.
-- instance_id stable per item (snapshot canonical sort key).
-- affixes_jsonb sorted lex ASC by id on save (R32 canonical).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_items (
  id                     BIGSERIAL    PRIMARY KEY,
  char_id                BIGINT       NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  instance_id            TEXT         NOT NULL,
  item_id                TEXT         NOT NULL,
  qty                    INTEGER      NOT NULL DEFAULT 1,
  slot                   TEXT,
  rarity                 TEXT,
  stats_jsonb            JSONB        NOT NULL DEFAULT '{}'::jsonb,
  affixes_jsonb          JSONB        NOT NULL DEFAULT '[]'::jsonb,
  set_id                 TEXT,
  equipped_on_companion  TEXT,
  upgrade_tier           INTEGER      NOT NULL DEFAULT 0,
  acquired_tick          BIGINT       NOT NULL DEFAULT 0,
  schema_version         INTEGER      NOT NULL DEFAULT 2,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT inventory_qty_positive       CHECK (qty >= 1),
  CONSTRAINT inventory_upgrade_nonneg     CHECK (upgrade_tier >= 0),
  CONSTRAINT inventory_acquired_nonneg    CHECK (acquired_tick >= 0),
  UNIQUE (char_id, instance_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_items_char_id ON inventory_items(char_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_item_id ON inventory_items(item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_set_id  ON inventory_items(set_id) WHERE set_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- 4. quest_progress — per-character quest state (CMD3 coord, CMD2 owns DDL).
-- objectives_jsonb shape defined by CMD3 progression schema.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quest_progress (
  id                BIGSERIAL    PRIMARY KEY,
  char_id           BIGINT       NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  quest_id          TEXT         NOT NULL,
  step              INTEGER      NOT NULL DEFAULT 0,
  objectives_jsonb  JSONB        NOT NULL DEFAULT '{}'::jsonb,
  completed_at      TIMESTAMPTZ,
  schema_version    INTEGER      NOT NULL DEFAULT 2,
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT quest_step_nonneg CHECK (step >= 0),
  UNIQUE (char_id, quest_id)
);

CREATE INDEX IF NOT EXISTS idx_quest_progress_char_id    ON quest_progress(char_id);
CREATE INDEX IF NOT EXISTS idx_quest_progress_completed  ON quest_progress(char_id, completed_at) WHERE completed_at IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- 5. combat_replays — encounter snapshot for replay/audit/anti-cheat.
-- hash = FNV-1a32 of canonical snapshot (cross-instance parity).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS combat_replays (
  id              BIGSERIAL    PRIMARY KEY,
  encounter_id    TEXT         NOT NULL,
  char_id         BIGINT       REFERENCES characters(id) ON DELETE SET NULL,
  snapshot_jsonb  JSONB        NOT NULL,
  hash            TEXT         NOT NULL,
  schema_version  INTEGER      NOT NULL DEFAULT 2,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (encounter_id, hash)
);

CREATE INDEX IF NOT EXISTS idx_combat_replays_encounter_id ON combat_replays(encounter_id);
CREATE INDEX IF NOT EXISTS idx_combat_replays_char_id      ON combat_replays(char_id) WHERE char_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_combat_replays_created      ON combat_replays(created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- 6. economy_transactions — gold sink + faucet ledger (anti-inflation audit).
-- amount signed: positive = faucet (gain), negative = sink (spend).
-- sink_type NULL when faucet, populated when sink (repair/upgrade/tax/craft/destination/inflation).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS economy_transactions (
  id              BIGSERIAL    PRIMARY KEY,
  char_id         BIGINT       NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  amount          BIGINT       NOT NULL,
  currency        TEXT         NOT NULL,
  sink_type       TEXT,
  related_action  TEXT,
  schema_version  INTEGER      NOT NULL DEFAULT 2,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT economy_currency_known CHECK (currency IN ('gold', 'linh_chau', 'luong')),
  CONSTRAINT economy_sink_when_negative CHECK (
    (amount >= 0 AND sink_type IS NULL) OR (amount < 0 AND sink_type IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_economy_txn_char_id           ON economy_transactions(char_id);
CREATE INDEX IF NOT EXISTS idx_economy_txn_currency_created  ON economy_transactions(currency, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_economy_txn_sink_type         ON economy_transactions(sink_type) WHERE sink_type IS NOT NULL;

COMMIT;

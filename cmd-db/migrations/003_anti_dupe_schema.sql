-- ════════════════════════════════════════════════════════════════
-- CMD2 Phase 14 Week 2 Day 1 — R44 anti-dupe schema
-- Per CMD_DB v2.4.2 § P1.1-P1.5 + R44 5-wrapper requirement
-- Adds: pending_actions, gm_action_log, transaction_log, item_instances,
--       item_transfer_log, currency_change_log, inventory (slot 0-29)
-- ════════════════════════════════════════════════════════════════

-- ── R7 v4 bug-hunt fix (ordering): players.player_id MUST exist + be
--    UNIQUE before inventory CREATE TABLE FK can target it. 001 only has
--    players.id BIGSERIAL; spec CMD_DB v2.4.2 references player_id
--    VARCHAR throughout. ALTER + backfill + UNIQUE constraint here at
--    the top so subsequent CREATE TABLE inventory ... REFERENCES
--    players(player_id) resolves cleanly.
ALTER TABLE players
    ADD COLUMN IF NOT EXISTS player_id VARCHAR(64);
UPDATE players
    SET player_id = username
    WHERE player_id IS NULL;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'players_player_id_uq'
    ) THEN
        ALTER TABLE players ADD CONSTRAINT players_player_id_uq UNIQUE (player_id);
    END IF;
END $$;
ALTER TABLE players
    ADD COLUMN IF NOT EXISTS gold BIGINT NOT NULL DEFAULT 0;

-- ── pending_actions (P1.1 idempotency cache + P1.5 stale recovery) ──
CREATE TABLE IF NOT EXISTS pending_actions (
    nonce           VARCHAR(64) PRIMARY KEY,
    action_type     VARCHAR(32) NOT NULL,
    player_id       VARCHAR(64) NOT NULL,
    payload         JSONB NOT NULL,
    payload_hash    CHAR(64) NOT NULL,                -- sha256 hex
    status          VARCHAR(24) NOT NULL DEFAULT 'pending',
    result          JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL,
    completed_at    TIMESTAMPTZ,
    CHECK (status IN ('pending', 'committed', 'failed', 'duplicate_rejected', 'rolled_back'))
);

CREATE INDEX IF NOT EXISTS idx_pending_actions_expires
    ON pending_actions (expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pending_actions_player
    ON pending_actions (player_id, created_at DESC);

-- ── gm_action_log (P1.4 AD12 rollback audit) ──
CREATE TABLE IF NOT EXISTS gm_action_log (
    log_id              BIGSERIAL PRIMARY KEY,
    gm_id               VARCHAR(64) NOT NULL,
    action_type         VARCHAR(32) NOT NULL,
    target_player_id    VARCHAR(64),
    target_uuid         UUID,
    reason              TEXT,
    payload             JSONB,
    timestamp           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gm_action_log_target
    ON gm_action_log (target_uuid, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_gm_action_log_action_target
    ON gm_action_log (action_type, target_uuid, timestamp DESC);

-- ── transaction_log (AD12 rollback source) ──
CREATE TABLE IF NOT EXISTS transaction_log (
    txn_id              UUID PRIMARY KEY,
    txn_type            VARCHAR(32) NOT NULL,
    player_id           VARCHAR(64),
    target_type         VARCHAR(32) NOT NULL,
    target_uuid         UUID,
    source_state        JSONB,
    target_state        JSONB,
    status              VARCHAR(24) NOT NULL DEFAULT 'committed',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    rolled_back_at      TIMESTAMPTZ,
    error_msg           TEXT,
    CHECK (status IN ('pending', 'committed', 'failed', 'rolled_back'))
);

CREATE INDEX IF NOT EXISTS idx_transaction_log_player
    ON transaction_log (player_id, created_at DESC);

-- ── item_instances (AD12 + pickupItem) ──
CREATE TABLE IF NOT EXISTS item_instances (
    item_uuid           UUID PRIMARY KEY,
    item_id             VARCHAR(64) NOT NULL,
    current_owner_id    VARCHAR(64),
    location            VARCHAR(24) NOT NULL DEFAULT 'inventory',
    in_transfer         BOOLEAN NOT NULL DEFAULT FALSE,
    version             INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ,
    CHECK (location IN ('inventory', 'dropped', 'auction', 'mail', 'destroyed'))
);

CREATE INDEX IF NOT EXISTS idx_item_instances_owner
    ON item_instances (current_owner_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_item_instances_location
    ON item_instances (location) WHERE deleted_at IS NULL;

-- ── item_transfer_log (AD12 compensation trail) ──
CREATE TABLE IF NOT EXISTS item_transfer_log (
    log_id              BIGSERIAL PRIMARY KEY,
    item_uuid           UUID NOT NULL REFERENCES item_instances(item_uuid),
    from_player_id      VARCHAR(64),
    to_player_id        VARCHAR(64),
    transfer_type       VARCHAR(24) NOT NULL,
    txn_nonce           VARCHAR(64) NOT NULL,
    snapshot_before     JSONB,
    snapshot_after      JSONB,
    timestamp           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (transfer_type IN ('trade', 'pickup', 'drop', 'admin', 'mail', 'auction'))
);

-- ── currency_change_log (AD12 gold compensation trail) ──
CREATE TABLE IF NOT EXISTS currency_change_log (
    log_id              BIGSERIAL PRIMARY KEY,
    player_id           VARCHAR(64) NOT NULL,
    currency_type       VARCHAR(16) NOT NULL,
    delta               BIGINT NOT NULL,
    balance_before      BIGINT NOT NULL,
    balance_after       BIGINT NOT NULL,
    reason              VARCHAR(64) NOT NULL,
    txn_nonce           VARCHAR(64) NOT NULL,
    source_action       VARCHAR(32) NOT NULL,
    timestamp           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_currency_change_log_player
    ON currency_change_log (player_id, timestamp DESC);

-- ── inventory (P1.3 slot capacity 0-29) ──
-- Note: separate from inventory_items (snapshot-based, 001_init) — this is slot-aware live state.
CREATE TABLE IF NOT EXISTS inventory (
    player_id           VARCHAR(64) NOT NULL REFERENCES players(player_id),
    item_uuid           UUID NOT NULL REFERENCES item_instances(item_uuid),
    slot_index          SMALLINT NOT NULL,
    quantity            INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (player_id, item_uuid),
    UNIQUE (player_id, slot_index),
    -- P1.3: slot_index whitelist 0-29 (30 slot max)
    CHECK (slot_index BETWEEN 0 AND 29),
    CHECK (quantity > 0)
);

-- ── P1.3 helper: find_free_inventory_slot ──
CREATE OR REPLACE FUNCTION find_free_inventory_slot(p_player_id VARCHAR(64))
RETURNS SMALLINT AS $$
DECLARE
    free_slot SMALLINT;
BEGIN
    SELECT s.slot INTO free_slot
    FROM generate_series(0, 29) s(slot)
    WHERE NOT EXISTS (
        SELECT 1 FROM inventory
        WHERE player_id = p_player_id AND slot_index = s.slot
    )
    ORDER BY s.slot LIMIT 1;

    RETURN free_slot;  -- NULL nếu đầy
END;
$$ LANGUAGE plpgsql;

-- (R7 v4 ALTER players ADD COLUMN player_id + gold moved to top of file
--  so inventory FK target exists at CREATE TABLE time — see line 8-29.)

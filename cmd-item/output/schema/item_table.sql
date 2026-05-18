-- CMD ITEM v1.2 — Foundation v2.8.0 R44/R45/R74 anti-dupe + R79 element
CREATE TABLE IF NOT EXISTS item_templates (
    template_id         INTEGER PRIMARY KEY,
    id                  VARCHAR(64) NOT NULL UNIQUE,
    name_vi             VARCHAR(128) NOT NULL,
    category            VARCHAR(16) NOT NULL,
    slot                VARCHAR(32),
    rarity              VARCHAR(16) NOT NULL,
    tier                VARCHAR(16),
    era                 VARCHAR(32),
    era_code            VARCHAR(16),
    region              VARCHAR(64),
    element             VARCHAR(8),
    heal_amount         INTEGER DEFAULT 0,
    level_min           INTEGER DEFAULT 1,
    stackable           BOOLEAN DEFAULT FALSE,
    max_stack           INTEGER DEFAULT 1,
    sell_price_gold     INTEGER DEFAULT 0,
    is_quest_locked     BOOLEAN DEFAULT FALSE,
    is_lore_locked      BOOLEAN DEFAULT FALSE,
    is_immutable_seed   BOOLEAN DEFAULT FALSE,
    author              VARCHAR(128),
    lore                TEXT,
    material            VARCHAR(64),
    cultural_tag        VARCHAR(32) DEFAULT 'viet_pure',
    stats_json          JSONB,
    affixes_json        JSONB,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    CHECK (category IN ('weapon','armor','consumable','material','quest_item','lore_item')),
    CHECK (rarity   IN ('common','uncommon','rare','epic','legendary','mythic')),
    CHECK (cultural_tag IN ('viet_pure','viet_legendary','viet_modern')),
    CHECK (element IS NULL OR element IN ('KIM','MOC','THUY','HOA','THO','TAM')),
    CHECK (max_stack >= 1),
    CHECK (level_min >= 1)
);
CREATE INDEX IF NOT EXISTS idx_items_category ON item_templates(category);
CREATE INDEX IF NOT EXISTS idx_items_rarity   ON item_templates(rarity);
CREATE INDEX IF NOT EXISTS idx_items_era_code ON item_templates(era_code);
CREATE INDEX IF NOT EXISTS idx_items_slot     ON item_templates(slot);

-- R45/R74 anti-dupe: instance UUID runtime, NOT shipped
CREATE TABLE IF NOT EXISTS item_instances (
    item_uuid           UUID PRIMARY KEY,
    template_id         INTEGER NOT NULL REFERENCES item_templates(template_id),
    owner_player_id     UUID,
    source              VARCHAR(64),
    source_log_id       BIGINT,
    quantity            INTEGER NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    CHECK (quantity > 0),
    UNIQUE(item_uuid)
);
CREATE INDEX IF NOT EXISTS idx_instances_template ON item_instances(template_id);
CREATE INDEX IF NOT EXISTS idx_instances_owner    ON item_instances(owner_player_id);

-- R74.B: transaction log per item action (pickup/drop/trade/store/transfer/spawn/destroy)
CREATE TABLE IF NOT EXISTS item_transactions (
    tx_id               UUID PRIMARY KEY,
    item_uuid           UUID NOT NULL REFERENCES item_instances(item_uuid),
    action              VARCHAR(16) NOT NULL,
    actor_player_id     UUID,
    evidence_json       JSONB,
    occurred_at         TIMESTAMPTZ DEFAULT NOW(),
    CHECK (action IN ('spawn','pickup','drop','trade','store','transfer','destroy'))
);
CREATE INDEX IF NOT EXISTS idx_tx_item       ON item_transactions(item_uuid);
CREATE INDEX IF NOT EXISTS idx_tx_occurred   ON item_transactions(occurred_at DESC);

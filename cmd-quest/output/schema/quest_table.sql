-- Quest schema — CMD_QUEST v1.1 / SVTK Foundation v2.8.0
CREATE TABLE IF NOT EXISTS quests (
    quest_id            INTEGER PRIMARY KEY,
    category            VARCHAR(16) NOT NULL,
    title               VARCHAR(256) NOT NULL,
    description         TEXT,
    era                 VARCHAR(32) NOT NULL,
    objective_type      VARCHAR(16) NOT NULL,
    level_min           INTEGER NOT NULL DEFAULT 1,
    giver_npc_id        INTEGER NOT NULL REFERENCES npcs(npc_id),
    reward_gold         INTEGER DEFAULT 0,
    reward_exp          INTEGER DEFAULT 0,
    reward_items        JSONB DEFAULT '[]'::jsonb,
    reward_reputation   INTEGER DEFAULT 0,
    is_protagonist_arc  BOOLEAN DEFAULT FALSE,
    event_window_days   INTEGER,
    min_party_size      INTEGER DEFAULT 1,
    resets_stats        BOOLEAN DEFAULT FALSE,
    unlocks_codex       BOOLEAN DEFAULT FALSE,
    chain_id            VARCHAR(64),
    chain_position      INTEGER,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    CHECK (category IN ('main','side','lore','event','raid','reborn','generated')),
    CHECK (objective_type IN ('kill','collect','deliver','escort','talk','explore')),
    CHECK (era IN ('ly','tran','le','tay_son','nguyen')),
    CHECK (level_min >= 1),
    CHECK (reward_gold >= 0),
    CHECK (reward_exp >= 0),
    UNIQUE (quest_id)
);

CREATE INDEX IF NOT EXISTS idx_quests_era ON quests(era);
CREATE INDEX IF NOT EXISTS idx_quests_giver ON quests(giver_npc_id);
CREATE INDEX IF NOT EXISTS idx_quests_category ON quests(category);
CREATE INDEX IF NOT EXISTS idx_quests_chain ON quests(chain_id) WHERE chain_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS quest_chains (
    chain_id            VARCHAR(64) PRIMARY KEY,
    name                VARCHAR(256) NOT NULL,
    era                 VARCHAR(32) NOT NULL,
    quest_ids           INTEGER[] NOT NULL,
    unlocks_next_era    BOOLEAN DEFAULT FALSE,
    CHECK (era IN ('ly','tran','le','tay_son','nguyen')),
    UNIQUE (chain_id)
);

-- Quest instance (anti-dupe R45): each player accept = 1 UUID instance
CREATE TABLE IF NOT EXISTS quest_instances (
    instance_uuid       UUID PRIMARY KEY,
    quest_id            INTEGER NOT NULL REFERENCES quests(quest_id),
    player_id           UUID NOT NULL,
    accepted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    status              VARCHAR(16) NOT NULL DEFAULT 'in_progress',
    CHECK (status IN ('in_progress','completed','failed','abandoned')),
    UNIQUE (quest_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_quest_instances_player ON quest_instances(player_id);

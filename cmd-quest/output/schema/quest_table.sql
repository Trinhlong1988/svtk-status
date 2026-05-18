-- Quest schema — CMD_QUEST v1.2 / SVTK Foundation v2.8.0 (R45/R50/R74)
-- ============================================================
-- TEMPLATE: định nghĩa quest (immutable, shared across players)
-- ============================================================
CREATE TABLE IF NOT EXISTS quests (
    quest_id            INTEGER PRIMARY KEY,
    quest_uid_legacy    VARCHAR(64),
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
    prerequisites       INTEGER[] DEFAULT '{}',
    chain_id            VARCHAR(64),
    chain_position      INTEGER,
    is_protagonist_arc  BOOLEAN DEFAULT FALSE,
    event_window_days   INTEGER,
    min_party_size      INTEGER DEFAULT 1,
    resets_stats        BOOLEAN DEFAULT FALSE,
    unlocks_codex       BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    CHECK (category IN ('main','side','lore','event','raid','reborn','generated')),
    CHECK (objective_type IN ('kill','collect','deliver','escort','talk','explore')),
    CHECK (era IN ('g1','f1','f2','f3','f4','f5','ly','tran','le','tay_son','nguyen')),
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
    CHECK (era IN ('g1','f1','f2','f3','f4','f5','ly','tran','le','tay_son','nguyen')),
    UNIQUE (chain_id)
);

-- ============================================================
-- INSTANCE: per-player quest progress (R74 anti-dupe)
-- ============================================================
CREATE TABLE IF NOT EXISTS quest_instances (
    instance_uuid       UUID PRIMARY KEY,
    quest_id            INTEGER NOT NULL REFERENCES quests(quest_id),
    player_id           UUID NOT NULL,
    status              VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    progress            INTEGER NOT NULL DEFAULT 0,
    reward_claimed      BOOLEAN NOT NULL DEFAULT FALSE,
    accepted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    CHECK (status IN ('ACTIVE','COMPLETED','FAILED','ABANDONED')),
    CHECK (progress >= 0 AND progress <= 100),
    UNIQUE (quest_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_quest_instances_player ON quest_instances(player_id);
CREATE INDEX IF NOT EXISTS idx_quest_instances_status ON quest_instances(status);

-- ============================================================
-- TRANSACTION LOG (R74 audit trail)
-- ============================================================
CREATE TABLE IF NOT EXISTS quest_transaction_log (
    txn_uuid            UUID PRIMARY KEY,
    actor_uuid          UUID NOT NULL,
    action              VARCHAR(32) NOT NULL,
    player_id           UUID,
    metadata            JSONB DEFAULT '{}'::jsonb,
    ts                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (action IN ('quest_accept','quest_complete','quest_abandon',
                      'quest_rollback','reward_grant','progress_update'))
);
CREATE INDEX IF NOT EXISTS idx_quest_txn_actor ON quest_transaction_log(actor_uuid);
CREATE INDEX IF NOT EXISTS idx_quest_txn_player ON quest_transaction_log(player_id);

-- ============================================================
-- REWARD UUID LOG (R74 anti-dupe reward grants)
-- ============================================================
CREATE TABLE IF NOT EXISTS reward_uuid_log (
    reward_uuid         UUID PRIMARY KEY,
    quest_id            INTEGER REFERENCES quests(quest_id),
    quest_instance_uuid UUID REFERENCES quest_instances(instance_uuid),
    player_id           UUID NOT NULL,
    reward_type         VARCHAR(16) NOT NULL,
    amount              INTEGER,
    item_template_id    INTEGER,
    granted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (reward_type IN ('gold','exp','item','reputation')),
    UNIQUE (reward_uuid)
);
CREATE INDEX IF NOT EXISTS idx_reward_log_player ON reward_uuid_log(player_id);
CREATE INDEX IF NOT EXISTS idx_reward_log_quest ON reward_uuid_log(quest_id);

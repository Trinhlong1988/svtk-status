-- NPC schema - SVTK Foundation v2.8.0
-- R45: UUID per instance, template separation
-- R46: Pet lifestate tracking
CREATE TABLE IF NOT EXISTS npc_templates (
    npc_index           INTEGER PRIMARY KEY,
    uuid                UUID NOT NULL,
    name                VARCHAR(96) NOT NULL,
    era                 VARCHAR(32) NOT NULL,
    npc_type            VARCHAR(32) NOT NULL,
    class_hierarchy     VARCHAR(16) NOT NULL,                -- R80
    dmg_taken_multi     NUMERIC(3,2) NOT NULL DEFAULT 1.00,  -- R80
    scene_id            INTEGER NOT NULL,
    spawn_x             INTEGER NOT NULL,
    spawn_y             INTEGER NOT NULL,
    tier                SMALLINT NOT NULL,
    level               SMALLINT NOT NULL,
    element             VARCHAR(8) NOT NULL,
    hp                  INTEGER NOT NULL,
    sp                  INTEGER NOT NULL,
    atk                 INTEGER NOT NULL,
    def_                INTEGER NOT NULL,
    int_                INTEGER NOT NULL,
    mdef                INTEGER NOT NULL,
    agi                 INTEGER NOT NULL,
    luck                INTEGER NOT NULL,
    hit                 INTEGER NOT NULL,
    dodge               INTEGER NOT NULL,
    crit                INTEGER NOT NULL,
    skill_ids           JSONB DEFAULT '[]',
    ai_behavior         VARCHAR(16) NOT NULL,
    aggro_range         SMALLINT DEFAULT 0,
    pettable            BOOLEAN DEFAULT FALSE,
    rebirthable         BOOLEAN DEFAULT FALSE,
    can_give_quest      BOOLEAN DEFAULT FALSE,
    can_train_skill     BOOLEAN DEFAULT FALSE,
    can_farm            BOOLEAN DEFAULT FALSE,
    can_event           BOOLEAN DEFAULT FALSE,
    sprite_template_id  SMALLINT NOT NULL,
    palette_seed        SMALLINT DEFAULT 0,
    -- R31 fix Round 31-40: add 14 missing columns + appropriate CHECKs
    recolor_index       SMALLINT DEFAULT 0,             -- R21 alias for palette_seed
    is_raid_extreme     BOOLEAN DEFAULT FALSE,          -- R29 marker tier 9 (thần class)
    -- Pet template fields (brief CMD_NPC line 826-838) — null for non-pettable
    pet_base_hp         INTEGER,
    pet_base_atk        INTEGER,
    pet_loyalty_init    SMALLINT,
    pet_evolution_path  JSONB,
    -- Protagonist-only metadata (null for most NPCs)
    mentor              VARCHAR(96),
    background          TEXT,
    starting_class      VARCHAR(32),
    is_player           BOOLEAN DEFAULT FALSE,
    is_protagonist      BOOLEAN DEFAULT FALSE,
    -- Historical figure metadata
    is_historical_figure BOOLEAN DEFAULT FALSE,
    era_start_year      INTEGER,
    -- R73 fix Round 71-80: add 2 missing JSONL fields
    mentor_npc_idx      INTEGER,                                -- R53 canonical mentor ref
    pet_evolution_path_note TEXT,                               -- R39 deferred expansion note
    gender              VARCHAR(8) DEFAULT 'male',
    cultural_tag        VARCHAR(32) DEFAULT 'viet_pure',
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    CHECK (tier BETWEEN 0 AND 9),
    CHECK (level BETWEEN 1 AND 120),
    CHECK (sprite_template_id BETWEEN 1 AND 158),
    CHECK (palette_seed BETWEEN 0 AND 63),
    CHECK (recolor_index BETWEEN 0 AND 63),                 -- R31
    -- R14 fix Round 11-20: scene_id range CHECK removed because 59 existing R71-immutable
    -- entries have sceneId > 7817. Validator enforces range for generated; existing
    -- alerts LEAD HIGH (cmd-lead/alerts/HIGH-*-npc_existing_scene_id_orphan_R75.json).
    CHECK (element IN ('kim','mộc','thủy','hỏa','thổ','tâm')),
    CHECK (npc_type IN ('townsmen','shopkeeper','quest_giver','monster','boss',
                        'guard','trainer','pet_master','event_npc','lore_npc')),
    CHECK (class_hierarchy IN ('regular','elite','mini_boss','boss','thanh','than')),
    CHECK (dmg_taken_multi BETWEEN 0.30 AND 1.00),
    -- R36 fix Round 31-40: cultural_tag + aggro_range + gender CHECK constraints
    CHECK (cultural_tag IN ('viet_pure', 'viet_modern', 'viet_legendary')),
    CHECK (aggro_range BETWEEN 0 AND 32),                   -- R28 TIER_AGGRO max 16, allow margin
    CHECK (gender IN ('male', 'female', 'M', 'F')),         -- backward compat M/F
    CHECK (starting_class IS NULL OR starting_class IN
        ('novice', 'warrior', 'mage', 'ranger', 'priest', 'assassin')),
    UNIQUE (uuid),
    UNIQUE (npc_index)
);

CREATE INDEX IF NOT EXISTS idx_npc_era ON npc_templates(era);
CREATE INDEX IF NOT EXISTS idx_npc_type ON npc_templates(npc_type);
CREATE INDEX IF NOT EXISTS idx_npc_tier ON npc_templates(tier);
CREATE INDEX IF NOT EXISTS idx_npc_scene ON npc_templates(scene_id);
CREATE INDEX IF NOT EXISTS idx_npc_questgiver ON npc_templates(can_give_quest)
    WHERE can_give_quest = TRUE;

-- R45 anti-dupe: pet instance separate from NPC template
CREATE TABLE IF NOT EXISTS pet_instances (
    instance_uuid       UUID PRIMARY KEY,
    template_index      INTEGER NOT NULL REFERENCES npc_templates(npc_index),
    owner_id            UUID,
    birth_owner_id      UUID,
    current_owner_id    UUID,
    lifestate           VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    level               SMALLINT DEFAULT 1,
    loyalty             SMALLINT DEFAULT 50,
    exp                 INTEGER DEFAULT 0,
    bond_score          INTEGER DEFAULT 0,
    transfer_history    JSONB DEFAULT '[]',
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    CHECK (lifestate IN ('ACTIVE','STORED','DEAD','IN_TRANSFER')),
    UNIQUE (instance_uuid)
);

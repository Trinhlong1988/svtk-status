-- CMD_BOSS v1.4 schema (R45/R47/R50/R67/R86)
CREATE TABLE IF NOT EXISTS boss (
    boss_id INT PRIMARY KEY,
    uuid VARCHAR(36) NOT NULL,
    name VARCHAR(128) NOT NULL,
    era VARCHAR(32) NOT NULL,
    tier VARCHAR(16) NOT NULL,
    level INT NOT NULL,
    element VARCHAR(8) NOT NULL,                  -- R86: 6 ngũ hành
    path VARCHAR(8) NOT NULL DEFAULT 'none',      -- R86: none|BACH|HAC (RB3)
    archetype VARCHAR(32) NOT NULL,
    faction VARCHAR(32) NOT NULL,
    historical TEXT,
    hp BIGINT NOT NULL,
    sp INT NOT NULL,
    atk INT NOT NULL,
    def_stat INT NOT NULL,
    int_stat INT NOT NULL,
    mdef INT NOT NULL,
    agi INT NOT NULL,
    luck INT NOT NULL,
    hit INT NOT NULL,
    dodge INT NOT NULL,
    crit INT NOT NULL,
    is_named BOOLEAN DEFAULT FALSE,
    lore_quote TEXT,
    UNIQUE(name, era),
    UNIQUE(uuid)
);
CREATE INDEX IF NOT EXISTS idx_boss_tier ON boss(tier);
CREATE INDEX IF NOT EXISTS idx_boss_element ON boss(element);
CREATE INDEX IF NOT EXISTS idx_boss_path ON boss(path);
CREATE INDEX IF NOT EXISTS idx_boss_faction ON boss(faction);
CREATE INDEX IF NOT EXISTS idx_boss_named ON boss(is_named);

CREATE TABLE IF NOT EXISTS skill_items (
    id INT PRIMARY KEY,
    natural_key VARCHAR(64) NOT NULL,
    name VARCHAR(128) NOT NULL,
    element VARCHAR(8) NOT NULL,
    tier_int SMALLINT NOT NULL,
    tier_label VARCHAR(16) NOT NULL,
    skill_type VARCHAR(16) NOT NULL,
    power INT NOT NULL,
    cost_sp INT NOT NULL,
    cooldown_sec SMALLINT NOT NULL,
    target_type VARCHAR(16) NOT NULL,
    range_tiles SMALLINT NOT NULL,
    era_lore VARCHAR(16) NOT NULL,
    tso_skill_id INT NULL,
    valid_classes TEXT NOT NULL,
    description TEXT NOT NULL,
    UNIQUE(natural_key)
);
CREATE INDEX idx_skill_element ON skill_items(element);
CREATE INDEX idx_skill_tier_label ON skill_items(tier_label);
CREATE INDEX idx_skill_era ON skill_items(era_lore);

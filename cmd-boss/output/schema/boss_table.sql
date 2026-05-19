-- CMD_BOSS v1.0 schema (R45/R47/R50/R67 anti-dupe)
CREATE TABLE IF NOT EXISTS boss_items (
    id INT PRIMARY KEY,
    natural_key VARCHAR(64) NOT NULL,
    uuid VARCHAR(36) NOT NULL,
    name VARCHAR(128) NOT NULL,
    display_name VARCHAR(256),
    era VARCHAR(16) NOT NULL,
    tier INT NOT NULL,
    boss_tier_class VARCHAR(16) NOT NULL,
    npc_class VARCHAR(16) NOT NULL,
    level INT NOT NULL,
    hp INT NOT NULL,
    atk INT NOT NULL,
    def_stat INT NOT NULL,
    dmg_taken_multi REAL NOT NULL,
    element VARCHAR(16) NOT NULL,
    phase_count INT NOT NULL,
    map_zone VARCHAR(32),
    respawn_min INT,
    raid_window_hours INT,
    UNIQUE(natural_key),
    UNIQUE(uuid)
);
CREATE INDEX IF NOT EXISTS idx_boss_key ON boss_items(natural_key);
CREATE INDEX IF NOT EXISTS idx_boss_class ON boss_items(boss_tier_class);
CREATE INDEX IF NOT EXISTS idx_boss_era ON boss_items(era);

CREATE TABLE IF NOT EXISTS boss_drop_table (
    drop_id INTEGER PRIMARY KEY AUTOINCREMENT,
    boss_id INT NOT NULL,
    item_template_id INT NOT NULL,
    drop_rate REAL NOT NULL,
    UNIQUE(boss_id, item_template_id),
    FOREIGN KEY(boss_id) REFERENCES boss_items(id)
);

CREATE TABLE IF NOT EXISTS boss_transaction_log (
    tx_id VARCHAR(36) PRIMARY KEY,
    entity_uuid VARCHAR(36) NOT NULL,
    action VARCHAR(32) NOT NULL,
    actor VARCHAR(64) NOT NULL,
    timestamp VARCHAR(32) NOT NULL,
    evidence_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_tx_entity ON boss_transaction_log(entity_uuid);

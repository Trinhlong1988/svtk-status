-- SVTK CMD_EVENT v1.0 schema
CREATE TABLE IF NOT EXISTS event_items (
    event_id INT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    category VARCHAR(32) NOT NULL,
    era VARCHAR(16) NOT NULL,
    trigger_type VARCHAR(32) NOT NULL,
    trigger_condition JSONB,
    duration_min INT NOT NULL,
    reward_tier VARCHAR(16) NOT NULL,
    reward_gold INT NOT NULL DEFAULT 0,
    reward_exp INT NOT NULL DEFAULT 0,
    reward_items JSONB,
    reward_reputation INT NOT NULL DEFAULT 0,
    min_level INT NOT NULL DEFAULT 1,
    max_participants INT NOT NULL DEFAULT 0,
    cross_ref JSONB,
    description TEXT,
    source VARCHAR(64),
    seed_origin VARCHAR(128),
    UNIQUE(category, name)
);
CREATE INDEX idx_event_category ON event_items(category);
CREATE INDEX idx_event_era ON event_items(era);
CREATE INDEX idx_event_trigger ON event_items(trigger_type);
CREATE INDEX idx_event_min_level ON event_items(min_level);

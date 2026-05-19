-- CMD_BOSS v1.4 AI behavior (R84)
CREATE TABLE IF NOT EXISTS boss_ai_behavior (
    boss_id INT PRIMARY KEY REFERENCES boss(boss_id),
    behavior_tree TEXT NOT NULL,        -- JSONB content
    phases_count INT NOT NULL,
    enrage_sec INT NOT NULL,
    has_class_counter BOOLEAN NOT NULL,
    has_add_waves BOOLEAN NOT NULL,
    event_scaling VARCHAR(16) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_boss_ai_phases ON boss_ai_behavior(phases_count);
CREATE INDEX IF NOT EXISTS idx_boss_ai_scaling ON boss_ai_behavior(event_scaling);

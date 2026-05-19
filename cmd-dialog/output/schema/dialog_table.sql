-- DIALOG table (CMD_DIALOG v1.1, Foundation v2.8.0, R8.3 UNIQUE)
CREATE TABLE IF NOT EXISTS dialogs (
    dialog_id    INT PRIMARY KEY,
    speaker_id   INT NOT NULL,
    speaker_name VARCHAR(128) NOT NULL,
    era          VARCHAR(32) NOT NULL CHECK (era IN ('ly','tran','le','tay_son','nguyen','f1','f2','f3','f4','f5','g1')),
    dialog_type  VARCHAR(32) NOT NULL CHECK (dialog_type IN ('greeting','quest','lore','bark','combat','trade','story')),
    text         TEXT NOT NULL,
    cultural_lock_pass BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE(dialog_id)
);
CREATE INDEX IF NOT EXISTS idx_dialog_speaker ON dialogs(speaker_id);
CREATE INDEX IF NOT EXISTS idx_dialog_era ON dialogs(era);
CREATE INDEX IF NOT EXISTS idx_dialog_type ON dialogs(dialog_type);

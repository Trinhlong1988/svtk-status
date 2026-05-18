CREATE TABLE IF NOT EXISTS qa_content_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    natural_key VARCHAR(64) NOT NULL,
    verdict VARCHAR(16) NOT NULL,
    count INTEGER NOT NULL,
    target INTEGER NOT NULL,
    UNIQUE(natural_key)
);
CREATE INDEX IF NOT EXISTS idx_qa_content_key ON qa_content_items(natural_key);

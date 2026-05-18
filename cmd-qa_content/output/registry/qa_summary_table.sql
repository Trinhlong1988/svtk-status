CREATE TABLE IF NOT EXISTS qa_content_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    natural_key VARCHAR(64) NOT NULL,
    verdict VARCHAR(16) NOT NULL,
    count INTEGER NOT NULL,
    target INTEGER NOT NULL,
    UNIQUE(natural_key)
);
CREATE INDEX IF NOT EXISTS idx_qa_content_key ON qa_content_items(natural_key);

INSERT INTO qa_content_items (natural_key, verdict, count, target) VALUES ('npc','PASS',10000,7817);
INSERT INTO qa_content_items (natural_key, verdict, count, target) VALUES ('quest','FAIL',150,2262);
INSERT INTO qa_content_items (natural_key, verdict, count, target) VALUES ('item','NEED_REVIEW',0,1000);
INSERT INTO qa_content_items (natural_key, verdict, count, target) VALUES ('dialog','FAIL',150,42297);
INSERT INTO qa_content_items (natural_key, verdict, count, target) VALUES ('boss','NEED_REVIEW',0,1200);
INSERT INTO qa_content_items (natural_key, verdict, count, target) VALUES ('skill','PASS',306,300);
INSERT INTO qa_content_items (natural_key, verdict, count, target) VALUES ('event','NEED_REVIEW',0,600);

CREATE TABLE IF NOT EXISTS qa_content_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    natural_key VARCHAR(64) NOT NULL,
    verdict VARCHAR(16) NOT NULL,
    count INTEGER NOT NULL,
    target INTEGER NOT NULL,
    UNIQUE(natural_key)
);
CREATE INDEX IF NOT EXISTS idx_qa_content_key ON qa_content_items(natural_key);

INSERT INTO qa_content_items (natural_key, verdict, count, target) VALUES ('npc','FAIL',10000,7817);
INSERT INTO qa_content_items (natural_key, verdict, count, target) VALUES ('quest','PASS',3000,2262);
INSERT INTO qa_content_items (natural_key, verdict, count, target) VALUES ('item','FAIL',4006,1000);
INSERT INTO qa_content_items (natural_key, verdict, count, target) VALUES ('dialog','FAIL',50000,42297);
INSERT INTO qa_content_items (natural_key, verdict, count, target) VALUES ('boss','PASS',1200,1200);
INSERT INTO qa_content_items (natural_key, verdict, count, target) VALUES ('skill','PASS',300,300);
INSERT INTO qa_content_items (natural_key, verdict, count, target) VALUES ('event','PASS',600,600);

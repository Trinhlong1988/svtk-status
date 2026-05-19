-- CMD_PLACE v1.0 schema
-- R8.3 UNIQUE constraints / R45 anti-dupe / R50 schema-strict 1..10000 (extended from 7047 — orphan fix v1.0.1)
CREATE TABLE IF NOT EXISTS place_items (
    id INT PRIMARY KEY,
    map_id INT NOT NULL,
    uuid VARCHAR(36) NOT NULL,
    natural_key VARCHAR(64) NOT NULL,
    name VARCHAR(128) NOT NULL,
    era VARCHAR(16) NOT NULL,
    biome VARCHAR(16) NOT NULL,
    shard_id INT NOT NULL,
    f_prefix VARCHAR(4) NOT NULL,
    coord_x INT NOT NULL,
    coord_y INT NOT NULL,
    UNIQUE(map_id),
    UNIQUE(natural_key),
    UNIQUE(uuid),
    CHECK (map_id BETWEEN 1 AND 10000),
    CHECK (era IN ('ly','tran','le','tay_son','nguyen')),
    CHECK (biome IN ('forest','mountain','river','plain','sea','capital','village')),
    CHECK (shard_id BETWEEN 0 AND 63)
);
CREATE INDEX idx_place_key ON place_items(natural_key);
CREATE INDEX idx_place_era ON place_items(era);
CREATE INDEX idx_place_biome ON place_items(biome);
CREATE INDEX idx_place_shard ON place_items(shard_id);

CREATE TABLE IF NOT EXISTS place_region (
    shard_id INT PRIMARY KEY,
    shard_code VARCHAR(8) NOT NULL,
    name VARCHAR(64) NOT NULL,
    primary_era VARCHAR(16) NOT NULL,
    biome_focus VARCHAR(16) NOT NULL,
    expected_map_count INT NOT NULL,
    actual_map_count INT NOT NULL,
    natural_key VARCHAR(64) NOT NULL,
    UNIQUE(shard_code),
    UNIQUE(natural_key),
    CHECK (shard_id BETWEEN 0 AND 63)
);

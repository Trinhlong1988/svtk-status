-- CMD_MAP v1.1 schema (R8.3 unique + R50 strict + R45 anti-dupe)
CREATE TABLE IF NOT EXISTS map_items (
    id                  INTEGER PRIMARY KEY,
    map_id_at_0x00      INTEGER NOT NULL,
    mark_id_at_0x104    INTEGER NOT NULL,
    image_filename      VARCHAR(64) NOT NULL,
    name                VARCHAR(128) NOT NULL,
    biome               VARCHAR(32) NOT NULL,
    era                 VARCHAR(16) NOT NULL,
    region              VARCHAR(16) NOT NULL,
    element_primary     VARCHAR(8) NOT NULL,
    width_tiles         INTEGER NOT NULL,
    height_tiles        INTEGER NOT NULL,
    image_resolution_w  INTEGER NOT NULL,
    image_resolution_h  INTEGER NOT NULL,
    image_quality       INTEGER NOT NULL,
    target_size_kb      INTEGER NOT NULL,
    npc_density_min     INTEGER NOT NULL,
    npc_density_max     INTEGER NOT NULL,
    seed                VARCHAR(64) NOT NULL,
    uuid                CHAR(36) NOT NULL,
    UNIQUE(map_id_at_0x00),
    UNIQUE(image_filename),
    UNIQUE(uuid)
);
CREATE INDEX IF NOT EXISTS idx_map_biome ON map_items(biome);
CREATE INDEX IF NOT EXISTS idx_map_era   ON map_items(era);
CREATE INDEX IF NOT EXISTS idx_map_region ON map_items(region);

-- CMD_MAP v1.1.0 — schema map_layouts
CREATE TABLE map_layouts (
    map_id INT PRIMARY KEY,
    uuid VARCHAR(36) NOT NULL,      -- copy từ CMD_PLACE
    layout_version INT NOT NULL,
    layout_hash VARCHAR(64) NOT NULL,
    source_place_hash VARCHAR(64) NOT NULL,
    source_build_rule_hash VARCHAR(64) NOT NULL,
    topology_version INT NOT NULL,
    natural_key VARCHAR(64) NOT NULL,
    biome VARCHAR(32) NOT NULL,
    era VARCHAR(16) NOT NULL,
    zone VARCHAR(16) NOT NULL,
    tier INT NOT NULL,
    safe_zone BOOLEAN NOT NULL,     -- vùng an toàn (không quái)
    grid_w INT NOT NULL,
    grid_h INT NOT NULL,
    art_group VARCHAR(48) NOT NULL,
    walk_mask TEXT NOT NULL,        -- JSON: {encoding,width,height,data}
    portal_points TEXT NOT NULL,    -- JSON array
    anchor_points TEXT NOT NULL,    -- JSON array
    spawn_zones TEXT NOT NULL,      -- JSON array (vùng — KHÔNG quái)
    spawn_zone_status TEXT NOT NULL, -- JSON: {requested,generated,reason}
    UNIQUE(uuid),
    UNIQUE(natural_key),
    UNIQUE(layout_hash),
    CHECK (map_id BETWEEN 1 AND 10102),
    CHECK (tier BETWEEN 1 AND 5)
);
CREATE INDEX idx_layout_biome ON map_layouts(biome);
CREATE INDEX idx_layout_era ON map_layouts(era);
CREATE INDEX idx_layout_art_group ON map_layouts(art_group);
CREATE INDEX idx_layout_tier ON map_layouts(tier);

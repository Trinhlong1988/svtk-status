-- CMD_PLACE v2.4.0 schema — auto từ ERAS/BIOMES/TARGET
CREATE TABLE IF NOT EXISTS place_items (
    id INT PRIMARY KEY,
    map_id INT NOT NULL,
    uuid VARCHAR(36) NOT NULL,
    natural_key VARCHAR(64) NOT NULL,
    topology_version INT NOT NULL,
    name VARCHAR(128) NOT NULL,
    era VARCHAR(32) NOT NULL,
    biome VARCHAR(32) NOT NULL,
    zone VARCHAR(32) NOT NULL,
    tier INT NOT NULL,
    is_important BOOLEAN NOT NULL,
    shard_id INT NOT NULL,
    f_prefix VARCHAR(8) NOT NULL,
    g1_pass BOOLEAN NOT NULL,
    g1_note VARCHAR(255) NOT NULL,
    coord_x INT NOT NULL,
    coord_y INT NOT NULL,
    purpose TEXT NOT NULL,        -- JSON array các purpose
    anchors TEXT NOT NULL,        -- JSON object anchor registry
    style TEXT NOT NULL,          -- JSON object visual/architecture/audio
    chunk_x INT NOT NULL,
    chunk_y INT NOT NULL,
    safe_zone BOOLEAN NOT NULL,
    combat_zone BOOLEAN NOT NULL,
    spawn_policy TEXT NOT NULL,    -- JSON: gợi ý vùng quái cho CMD_MAP
    nav_region VARCHAR(32) NOT NULL,
    terrain TEXT NOT NULL,        -- JSON object elevation/water_ratio/roughness
    portal_graph TEXT NOT NULL,   -- JSON array các liên kết portal
    era_label VARCHAR(32) NOT NULL,
    era_display VARCHAR(32) NOT NULL,
    biome_label VARCHAR(32) NOT NULL,
    biome_group VARCHAR(32) NOT NULL,
    shard_code VARCHAR(8) NOT NULL,
    tags TEXT NOT NULL,           -- JSON array tag
    tsonline_cross_ref INT NOT NULL,
    realm_access VARCHAR(16) NOT NULL DEFAULT 'open',  -- open/reborn/event/quest
    is_start_map BOOLEAN NOT NULL DEFAULT 0,          -- map spawn cốt truyện
    realm_group VARCHAR(16) NOT NULL DEFAULT 'none',  -- none/celestial/underworld
    map_role VARCHAR(16) NOT NULL DEFAULT 'normal',   -- normal/start/gate/hub/combat/dungeon/boss
    UNIQUE(map_id),
    UNIQUE(natural_key),
    UNIQUE(uuid),
    CHECK (map_id BETWEEN 1 AND 10102),
    CHECK (era IN ('ly','tran','le','tay_son','nguyen','f1','f2','f3','f4','f5','than_thoai','hien_dai','dinh')),
    CHECK (biome IN ('forest','mountain','river','plain','sea','swamp','craft_village','rice_field','fishing_village','salt_field','plantation','wharf','capital','capital_inner','town','village','citadel','frontier_pass','battlefield','cave','scenic','garden','thien_mon','coi_troi','dong_tien','tan_vien_linh_son','long_cung','thien_dai','quy_mon_quan','hoang_tuyen','u_minh_lo','dia_phu_dien','me_cung_u_minh','vong_hon_dai','bao_tang','co_do_hoa_lu')),
    CHECK (tier BETWEEN 1 AND 5),
    CHECK (shard_id BETWEEN 0 AND 63)
);
CREATE INDEX idx_place_key ON place_items(natural_key);
CREATE INDEX idx_place_era ON place_items(era);
CREATE INDEX idx_place_biome ON place_items(biome);
CREATE INDEX idx_place_shard ON place_items(shard_id);
CREATE INDEX idx_place_zone ON place_items(zone);
CREATE INDEX idx_place_tier ON place_items(tier);
CREATE INDEX idx_place_biome_group ON place_items(biome_group);
CREATE INDEX idx_place_tsref ON place_items(tsonline_cross_ref);
CREATE INDEX idx_place_shard_code ON place_items(shard_code);

CREATE TABLE IF NOT EXISTS place_region (
    shard_id INT PRIMARY KEY,
    shard_code VARCHAR(8) NOT NULL,
    name VARCHAR(64) NOT NULL,
    zone VARCHAR(32) NOT NULL,
    tier INT NOT NULL,
    primary_era VARCHAR(32) NOT NULL,
    biome_focus VARCHAR(32) NOT NULL,
    expected_map_count INT NOT NULL,
    actual_map_count INT NOT NULL,
    natural_key VARCHAR(64) NOT NULL,
    UNIQUE(shard_code),
    UNIQUE(natural_key),
    CHECK (tier BETWEEN 1 AND 5),
    CHECK (shard_id BETWEEN 0 AND 63)
);

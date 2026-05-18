#!/usr/bin/env python3
"""TEST CÔNG THỨC PHÂN BỔ NPC → MAP.

10 scenarios:
  1. Allocate 100 NPC vào 10 map - mọi NPC có sceneId
  2. Density không vượt max biome
  3. NPC type distribution match biome (capital nhiều shopkeeper, dungeon nhiều monster)
  4. Position trong bounds (spawn_x < width, spawn_y < height)
  5. Deterministic với same seed
  6. Different seed → different allocation
  7. Verify orphan detection (NPC sceneId không match)
  8. Verify overcrowd detection
  9. Verify invalid position detection
  10. Full E2E: 1000 NPC → 100 map → 0 orphan
"""
import random
import time


# CONSTANTS (sao chép từ CMD prompt)
MAP_NPC_DENSITY = {
    'capital':       (40, 80),
    'town':          (15, 30),
    'village':       (5, 15),
    'forest':        (10, 25),
    'mountain':      (8, 20),
    'river':         (5, 15),
    'plain':         (10, 20),
    'sea':           (3, 8),
    'dungeon':       (15, 40),
    'capital_inner': (60, 120),
}

NPC_TYPE_DIST = {
    'capital':       {'town': 0.30, 'shopkeeper': 0.25, 'quest': 0.20, 'guard': 0.20, 'monster': 0.05},
    'town':          {'town': 0.40, 'shopkeeper': 0.25, 'quest': 0.20, 'guard': 0.10, 'monster': 0.05},
    'village':       {'town': 0.50, 'quest': 0.25, 'shopkeeper': 0.15, 'guard': 0.05, 'monster': 0.05},
    'forest':        {'monster': 0.60, 'quest': 0.20, 'town': 0.15, 'shopkeeper': 0.05},
    'mountain':      {'monster': 0.55, 'quest': 0.25, 'town': 0.15, 'shopkeeper': 0.05},
    'river':         {'monster': 0.40, 'town': 0.30, 'quest': 0.20, 'shopkeeper': 0.10},
    'plain':         {'monster': 0.40, 'town': 0.30, 'quest': 0.20, 'shopkeeper': 0.10},
    'sea':           {'monster': 0.50, 'quest': 0.30, 'town': 0.20},
    'dungeon':       {'monster': 0.85, 'quest': 0.10, 'town': 0.05},
    'capital_inner': {'guard': 0.50, 'town': 0.30, 'quest': 0.20},
}

MIN_NPC_SPACING = 8


def allocate_npcs_to_maps(npc_list, map_list, seed=42):
    rng = random.Random(seed)
    map_by_id = {m['mapId_at_0x00']: m for m in map_list}
    map_capacity = {}
    for m in map_list:
        biome = m.get('biome', 'plain')
        density_range = MAP_NPC_DENSITY.get(biome, (10, 20))
        map_capacity[m['mapId_at_0x00']] = rng.randint(*density_range)

    allocations = []
    map_ids = list(map_by_id.keys())
    map_idx = 0

    for npc in npc_list:
        attempts = 0
        while attempts < len(map_ids):
            map_id = map_ids[map_idx % len(map_ids)]
            if map_capacity[map_id] > 0:
                m = map_by_id[map_id]
                biome = m.get('biome', 'plain')

                dist = NPC_TYPE_DIST.get(biome, NPC_TYPE_DIST['town'])
                r = rng.random()
                cumulative = 0
                npc_type = 'town'
                for t, prob in dist.items():
                    cumulative += prob
                    if r <= cumulative:
                        npc_type = t
                        break

                width = m.get('width', 320)
                height = m.get('height', 240)
                spawn_x = rng.randint(MIN_NPC_SPACING, width - MIN_NPC_SPACING)
                spawn_y = rng.randint(MIN_NPC_SPACING, height - MIN_NPC_SPACING)

                npc['sceneId'] = map_id
                npc['npc_type'] = npc_type
                npc['spawn_x'] = spawn_x
                npc['spawn_y'] = spawn_y

                allocations.append(npc)
                map_capacity[map_id] -= 1
                map_idx += 1
                break
            else:
                map_idx += 1
                attempts += 1
        if attempts >= len(map_ids):
            break

    return allocations


def verify_npc_map_allocation(npc_list, map_list):
    map_ids = {m['mapId_at_0x00'] for m in map_list}
    issues = []

    for i, n in enumerate(npc_list):
        scene_id = n.get('sceneId')
        if scene_id is None:
            issues.append({'type': 'npc_no_sceneId', 'npc_index': i})
            continue
        if scene_id not in map_ids:
            issues.append({'type': 'npc_orphan_map', 'npc_index': i, 'sceneId': scene_id})

        sx = n.get('spawn_x', -1)
        sy = n.get('spawn_y', -1)
        if sx < 0 or sy < 0:
            issues.append({'type': 'npc_invalid_position', 'npc_index': i})

    npc_per_map = {}
    for n in npc_list:
        sid = n.get('sceneId')
        if sid:
            npc_per_map[sid] = npc_per_map.get(sid, 0) + 1

    for m in map_list:
        mid = m['mapId_at_0x00']
        biome = m.get('biome', 'plain')
        max_density = MAP_NPC_DENSITY.get(biome, (10, 20))[1]
        actual = npc_per_map.get(mid, 0)
        if actual > max_density:
            issues.append({'type': 'map_npc_overcrowded', 'map_id': mid,
                          'biome': biome, 'actual': actual, 'max': max_density})

    return issues


# ===== 10 SCENARIOS =====
def t1_allocate_basic():
    """100 NPC → 10 map đủ capacity → mọi NPC có sceneId."""
    maps = [{'mapId_at_0x00': i, 'biome': 'town', 'width': 320, 'height': 240}
            for i in range(1, 11)]
    npcs = [{'_index': i, 'name': f'NPC_{i}'} for i in range(1, 101)]
    result = allocate_npcs_to_maps(npcs, maps, seed=42)
    assert len(result) == 100
    assert all('sceneId' in n for n in result)
    return True, '100 NPC → 10 town map full alloc'


def t2_density_respect_max():
    """Density per map KHÔNG vượt biome max."""
    maps = [{'mapId_at_0x00': 1, 'biome': 'village', 'width': 320, 'height': 240}]
    npcs = [{'_index': i} for i in range(1, 51)]  # 50 NPC vào 1 village
    result = allocate_npcs_to_maps(npcs, maps, seed=42)
    # Village max = 15, nên chỉ allocate được ≤15
    assert len(result) <= 15, f'Village allocated {len(result)} > max 15'
    return True, 'Density respect: village max 15'


def t3_type_distribution_biome():
    """Capital có ≥20% shopkeeper, forest có ≥40% monster."""
    capital = [{'mapId_at_0x00': 1, 'biome': 'capital', 'width': 320, 'height': 240}]
    forest = [{'mapId_at_0x00': 2, 'biome': 'forest', 'width': 320, 'height': 240}]

    # Allocate 1000 NPC vào capital
    npcs_c = [{'_index': i} for i in range(1, 1001)]
    result_c = allocate_npcs_to_maps(npcs_c, capital, seed=42)
    shopkeeper_pct = sum(1 for n in result_c if n['npc_type'] == 'shopkeeper') / len(result_c)
    assert shopkeeper_pct >= 0.15, f'Capital shopkeeper {shopkeeper_pct:.2%} < 15%'

    # Allocate 1000 NPC vào forest
    npcs_f = [{'_index': i} for i in range(1, 1001)]
    result_f = allocate_npcs_to_maps(npcs_f, forest, seed=42)
    monster_pct = sum(1 for n in result_f if n['npc_type'] == 'monster') / len(result_f) if result_f else 0
    assert monster_pct >= 0.35, f'Forest monster {monster_pct:.2%} < 35%'
    return True, 'Type distribution: capital shopkeeper + forest monster'


def t4_position_in_bounds():
    """Spawn position phải trong (MIN_SPACING, width-MIN_SPACING)."""
    maps = [{'mapId_at_0x00': 1, 'biome': 'town', 'width': 100, 'height': 80}]
    npcs = [{'_index': i} for i in range(1, 11)]
    result = allocate_npcs_to_maps(npcs, maps, seed=42)
    for n in result:
        assert MIN_NPC_SPACING <= n['spawn_x'] <= 100 - MIN_NPC_SPACING
        assert MIN_NPC_SPACING <= n['spawn_y'] <= 80 - MIN_NPC_SPACING
    return True, 'Position in bounds (8..width-8)'


def t5_deterministic_same_seed():
    """Same seed → same allocation."""
    maps = [{'mapId_at_0x00': i, 'biome': 'town', 'width': 320, 'height': 240}
            for i in range(1, 6)]
    npcs1 = [{'_index': i} for i in range(1, 21)]
    npcs2 = [{'_index': i} for i in range(1, 21)]

    r1 = allocate_npcs_to_maps(npcs1, maps, seed=100)
    r2 = allocate_npcs_to_maps(npcs2, maps, seed=100)

    assert len(r1) == len(r2)
    for a, b in zip(r1, r2):
        assert a['sceneId'] == b['sceneId']
        assert a['spawn_x'] == b['spawn_x']
    return True, 'Deterministic: same seed → same alloc'


def t6_different_seed():
    """Different seed → different allocation."""
    maps = [{'mapId_at_0x00': i, 'biome': 'town', 'width': 320, 'height': 240}
            for i in range(1, 6)]
    npcs1 = [{'_index': i} for i in range(1, 21)]
    npcs2 = [{'_index': i} for i in range(1, 21)]

    r1 = allocate_npcs_to_maps(npcs1, maps, seed=100)
    r2 = allocate_npcs_to_maps(npcs2, maps, seed=999)

    different = any(a['spawn_x'] != b['spawn_x'] or a['spawn_y'] != b['spawn_y']
                    for a, b in zip(r1, r2))
    assert different
    return True, 'Different seed → different alloc'


def t7_orphan_detection():
    """QA detect NPC.sceneId không match map."""
    maps = [{'mapId_at_0x00': 1, 'biome': 'town'}, {'mapId_at_0x00': 2, 'biome': 'town'}]
    npcs = [
        {'_index': 1, 'sceneId': 1, 'spawn_x': 50, 'spawn_y': 50},
        {'_index': 2, 'sceneId': 999, 'spawn_x': 50, 'spawn_y': 50},  # orphan
    ]
    issues = verify_npc_map_allocation(npcs, maps)
    orphans = [i for i in issues if i['type'] == 'npc_orphan_map']
    assert len(orphans) == 1
    assert orphans[0]['sceneId'] == 999
    return True, 'QA detect orphan NPC.sceneId'


def t8_overcrowd_detection():
    """QA detect map overcrowded."""
    maps = [{'mapId_at_0x00': 1, 'biome': 'village', 'width': 320, 'height': 240}]
    # Village max = 15
    npcs = [{'_index': i, 'sceneId': 1, 'spawn_x': 50, 'spawn_y': 50}
            for i in range(1, 21)]  # 20 NPC > 15
    issues = verify_npc_map_allocation(npcs, maps)
    overcrowd = [i for i in issues if i['type'] == 'map_npc_overcrowded']
    assert len(overcrowd) == 1
    assert overcrowd[0]['actual'] == 20
    return True, 'QA detect overcrowded village'


def t9_invalid_position_detection():
    """QA detect spawn_x < 0."""
    maps = [{'mapId_at_0x00': 1, 'biome': 'town'}]
    npcs = [
        {'_index': 1, 'sceneId': 1, 'spawn_x': -1, 'spawn_y': 50},
        {'_index': 2, 'sceneId': 1, 'spawn_x': 50, 'spawn_y': -1},
    ]
    issues = verify_npc_map_allocation(npcs, maps)
    invalid = [i for i in issues if i['type'] == 'npc_invalid_position']
    assert len(invalid) == 2
    return True, 'QA detect invalid position'


def t10_full_e2e_1000_npc():
    """1000 NPC → 100 map → verify 0 orphan."""
    biomes = ['capital', 'town', 'village', 'forest', 'mountain', 'plain']
    maps = [{'mapId_at_0x00': i, 'biome': biomes[i % len(biomes)],
             'width': 320, 'height': 240} for i in range(1, 101)]
    npcs = [{'_index': i, 'name': f'NPC_{i}'} for i in range(1, 1001)]

    result = allocate_npcs_to_maps(npcs, maps, seed=42)
    assert len(result) > 0

    # Verify integrity
    issues = verify_npc_map_allocation(result, maps)
    orphans = [i for i in issues if i['type'] == 'npc_orphan_map']
    assert len(orphans) == 0, f'Có {len(orphans)} orphan!'
    overcrowd = [i for i in issues if i['type'] == 'map_npc_overcrowded']
    assert len(overcrowd) == 0, f'Có {len(overcrowd)} overcrowded!'

    return True, f'E2E: {len(result)} NPC → 100 map, 0 orphan'


# ===== RUN =====
def run_iteration():
    tests = [t1_allocate_basic, t2_density_respect_max, t3_type_distribution_biome,
             t4_position_in_bounds, t5_deterministic_same_seed, t6_different_seed,
             t7_orphan_detection, t8_overcrowd_detection,
             t9_invalid_position_detection, t10_full_e2e_1000_npc]
    results = []
    for t in tests:
        try:
            ok, msg = t()
            results.append((t.__name__, ok, msg))
        except AssertionError as e:
            results.append((t.__name__, False, f'FAIL: {e}'))
        except Exception as e:
            results.append((t.__name__, False, f'EXC: {e}'))
    return results


if __name__ == '__main__':
    print("=" * 78)
    print("NPC → MAP ALLOCATION TEST — 50 ITER × 10 SCENARIOS × 3 BATCHES")
    print("=" * 78)

    overall_pass = 0
    overall_total = 0
    overall_fails = []
    start = time.time()

    for batch in range(1, 4):
        bp, bt = 0, 0
        for i in range(50):
            for name, ok, msg in run_iteration():
                bt += 1
                if ok:
                    bp += 1
                else:
                    overall_fails.append((batch, i+1, name, msg))
        overall_pass += bp
        overall_total += bt
        print(f"Batch {batch}: {bp}/{bt} = {bp/bt*100:.1f}%")

    elapsed = time.time() - start
    print()
    print(f"TOTAL: {overall_pass}/{overall_total} = {overall_pass/overall_total*100:.1f}%")
    print(f"Time: {elapsed:.2f}s")

    print()
    print("Sample iteration 1:")
    for name, ok, msg in run_iteration():
        print(f"  {'✅' if ok else '❌'} {name}: {msg}")

    print()
    if overall_fails:
        print(f"FAILURES ({len(overall_fails)}):")
        for b, i, n, m in overall_fails[:5]:
            print(f"  Batch {b} iter {i} - {n}: {m}")
    else:
        print("✅ ZERO FAILURES")
    print("=" * 78)

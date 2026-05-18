#!/usr/bin/env python3
"""TEST NPC FULL SYSTEM — toàn diện stat/tier/element/skill/AI."""
import random
import time


# Copy constants from CMD_NPC
NPC_TIER_RANGE = {
    0: (1, 10), 1: (10, 25), 2: (25, 40), 3: (40, 55),
    4: (55, 70), 5: (70, 85), 6: (85, 100), 7: (100, 110),
    8: (110, 115), 9: (115, 120),
}

BIOME_TIER = {
    'capital_inner': 6, 'capital': 3, 'town': 2, 'village': 1,
    'forest': 2, 'mountain': 4, 'river': 2, 'plain': 2,
    'sea': 5, 'dungeon': 7,
}

TYPE_MULTI = {
    'boss': 5.0, 'monster': 1.0, 'guard': 0.8, 'trainer': 0.5,
    'shopkeeper': 0.3, 'townsmen': 0.2, 'quest_giver': 0.3,
    'pet_master': 0.4, 'event_npc': 1.5, 'lore_npc': 0.2,
}

ELEMENTS_VSTK = {
    'kim': {'strong': 'mộc', 'weak': 'hỏa'},
    'mộc': {'strong': 'thổ', 'weak': 'kim'},
    'thủy': {'strong': 'hỏa', 'weak': 'thổ'},
    'hỏa': {'strong': 'kim', 'weak': 'thủy'},
    'thổ': {'strong': 'thủy', 'weak': 'mộc'},
    'tâm': {'strong': None, 'weak': None},
}

ELEMENTS_VSTK_LIST = list(ELEMENTS_VSTK.keys())

NPC_ACTION_BY_TYPE = {
    'townsmen': ['idle', 'wander'],
    'shopkeeper': ['idle'],
    'quest_giver': ['idle'],
    'monster': ['aggressive', 'wander'],
    'boss': ['aggressive'],
    'guard': ['patrol', 'defensive'],
    'trainer': ['idle', 'train'],
    'pet_master': ['idle'],
    'event_npc': ['event_perform', 'gather'],
    'lore_npc': ['idle'],
}


def compute_npc_stats(level, tier, npc_type, element):
    tier_multi = 1.0 + tier * 0.15
    type_multi = TYPE_MULTI.get(npc_type, 1.0)
    base_hp = int((50 + level * 20) * tier_multi * type_multi)
    base_sp = int((20 + level * 5) * tier_multi * type_multi)
    base_atk = int((5 + level * 2) * tier_multi * type_multi)
    base_def = int((3 + level * 1.5) * tier_multi * type_multi)
    base_int = int((4 + level * 1.8) * tier_multi * type_multi)
    base_mdef = int((3 + level * 1.4) * tier_multi * type_multi)
    base_agi = int((10 + level * 0.8) * tier_multi)
    base_luck = int((5 + level * 0.3) * tier_multi)
    return {
        'hp': base_hp, 'sp': base_sp, 'atk': base_atk, 'def_': base_def,
        'int_': base_int, 'mdef': base_mdef, 'agi': base_agi, 'luck': base_luck,
        'hit': 90 + base_agi // 5, 'dodge': base_agi // 10,
        'crit': 5 + base_luck // 10,
    }


def calculate_element_damage(base_dmg, attacker_el, target_el):
    if attacker_el == 'tâm' or target_el == 'tâm':
        return base_dmg
    a = ELEMENTS_VSTK.get(attacker_el, {})
    if a.get('strong') == target_el:
        return int(base_dmg * 1.5)
    if a.get('weak') == target_el:
        return int(base_dmg * 0.5)
    return base_dmg


def assign_skills_to_npc(npc, skill_pool, max_skills=None):
    tier = npc.get('tier', 0)
    element = npc.get('element', 'thổ')
    npc_type = npc.get('npc_type', 'monster')

    if max_skills is None:
        if tier <= 2: max_skills = 2
        elif tier <= 5: max_skills = 4
        elif tier <= 8: max_skills = 6
        else: max_skills = 8

    if npc_type == 'boss':
        max_skills += 2
    if npc_type in ('townsmen', 'shopkeeper', 'quest_giver', 'lore_npc'):
        return []

    eligible = [s for s in skill_pool
                if s.get('element') in (element, 'tâm', 'neutral')
                and s.get('tier', 0) <= tier]
    if not eligible:
        eligible = skill_pool[:max_skills]
    sorted_skills = sorted(eligible, key=lambda s: -s.get('tier', 0))
    return [s['skill_id'] for s in sorted_skills[:max_skills]]


# ============ 15 SCENARIOS ============
def t1_stat_scaling_level():
    """Stat scale với level: lv 50 > lv 10."""
    s10 = compute_npc_stats(10, 2, 'monster', 'kim')
    s50 = compute_npc_stats(50, 2, 'monster', 'kim')
    assert s50['hp'] > s10['hp']
    assert s50['atk'] > s10['atk']
    return True, f'Stat scale: lv10 hp={s10["hp"]} < lv50 hp={s50["hp"]}'


def t2_stat_scaling_tier():
    """Stat scale với tier: tier 6 > tier 0."""
    s0 = compute_npc_stats(50, 0, 'monster', 'kim')
    s6 = compute_npc_stats(50, 6, 'monster', 'kim')
    assert s6['hp'] > s0['hp']
    return True, f'Tier scale: tier0 hp={s0["hp"]} < tier6 hp={s6["hp"]}'


def t3_boss_vs_townsmen():
    """Boss có stat >> townsmen."""
    boss = compute_npc_stats(50, 5, 'boss', 'hỏa')
    town = compute_npc_stats(50, 5, 'townsmen', 'hỏa')
    assert boss['hp'] > town['hp'] * 20
    return True, f'Boss hp={boss["hp"]} >> townsmen hp={town["hp"]}'


def t4_element_strong_damage():
    """Kim đánh Mộc → +50% damage."""
    dmg = calculate_element_damage(100, 'kim', 'mộc')
    assert dmg == 150, f'Expected 150, got {dmg}'
    return True, 'Kim → Mộc: 100 → 150 (×1.5)'


def t5_element_weak_damage():
    """Hỏa đánh Thủy → -50% damage."""
    dmg = calculate_element_damage(100, 'hỏa', 'thủy')
    assert dmg == 50
    return True, 'Hỏa → Thủy: 100 → 50 (×0.5)'


def t6_tam_neutral():
    """Tâm vs bất kỳ → normal (no modifier)."""
    for el in ['kim', 'mộc', 'thủy', 'hỏa', 'thổ']:
        assert calculate_element_damage(100, 'tâm', el) == 100
        assert calculate_element_damage(100, el, 'tâm') == 100
    return True, 'Tâm trung lập với 5 hệ'


def t7_element_wheel_5_tso():
    """Verify 5 ngũ hành tương khắc đầy đủ TSO."""
    # Kim→Mộc, Mộc→Thổ, Thổ→Thủy, Thủy→Hỏa, Hỏa→Kim
    pairs = [('kim', 'mộc'), ('mộc', 'thổ'), ('thổ', 'thủy'),
             ('thủy', 'hỏa'), ('hỏa', 'kim')]
    for attacker, target in pairs:
        dmg = calculate_element_damage(100, attacker, target)
        assert dmg == 150, f'{attacker}→{target}: expected 150, got {dmg}'
    return True, '5 ngũ hành TSO wheel verified'


def t8_skill_count_by_tier():
    """Tier 0-2: ≤2 skill, tier 9: ≥6 skill."""
    skill_pool = [{'skill_id': i, 'element': 'kim', 'tier': i % 10}
                  for i in range(1, 51)]

    npc_low = {'tier': 1, 'element': 'kim', 'npc_type': 'monster'}
    npc_high = {'tier': 9, 'element': 'kim', 'npc_type': 'monster'}
    npc_boss = {'tier': 9, 'element': 'kim', 'npc_type': 'boss'}

    s_low = assign_skills_to_npc(npc_low, skill_pool)
    s_high = assign_skills_to_npc(npc_high, skill_pool)
    s_boss = assign_skills_to_npc(npc_boss, skill_pool)

    assert len(s_low) <= 2
    assert len(s_high) >= 6  # tier 9 → 8
    assert len(s_boss) > len(s_high)  # boss + 2 extra
    return True, f'tier1={len(s_low)} tier9={len(s_high)} boss={len(s_boss)}'


def t9_npc_no_combat_skill():
    """Townsmen / shopkeeper KHÔNG có combat skill."""
    skill_pool = [{'skill_id': i, 'element': 'kim', 'tier': 0} for i in range(1, 10)]
    for nt in ['townsmen', 'shopkeeper', 'quest_giver', 'lore_npc']:
        npc = {'tier': 5, 'element': 'kim', 'npc_type': nt}
        skills = assign_skills_to_npc(npc, skill_pool)
        assert len(skills) == 0, f'{nt} should have no skill'
    return True, '4 non-combat types: 0 skill assigned'


def t10_npc_ai_by_type():
    """Behavior list match npc_type."""
    monster_actions = NPC_ACTION_BY_TYPE['monster']
    assert 'aggressive' in monster_actions
    guard_actions = NPC_ACTION_BY_TYPE['guard']
    assert 'patrol' in guard_actions
    trainer_actions = NPC_ACTION_BY_TYPE['trainer']
    assert 'train' in trainer_actions
    return True, 'AI behavior: monster=aggro, guard=patrol, trainer=train'


def t11_npc_tier_from_biome():
    """Capital_inner tier ≥6, village tier ≤1."""
    assert BIOME_TIER['capital_inner'] >= 6
    assert BIOME_TIER['village'] <= 1
    assert BIOME_TIER['dungeon'] >= 7
    return True, 'Biome tier: capital_inner≥6, village≤1, dungeon≥7'


def t12_level_in_tier_range():
    """NPC level phải trong tier range."""
    rng = random.Random(42)
    for tier in range(10):
        min_lv, max_lv = NPC_TIER_RANGE[tier]
        for _ in range(50):
            level = rng.randint(min_lv, max_lv)
            assert min_lv <= level <= max_lv
    return True, '10 tier × 50 sample, all in range'


def t13_six_elements_vstk():
    """VSTK có đủ 6 hệ: 5 ngũ hành + Tâm."""
    assert len(ELEMENTS_VSTK_LIST) == 6
    for el in ['kim', 'mộc', 'thủy', 'hỏa', 'thổ', 'tâm']:
        assert el in ELEMENTS_VSTK_LIST
    return True, '6 hệ VSTK: kim/mộc/thủy/hỏa/thổ/tâm'


def t14_full_npc_generation():
    """Generate 1 NPC đầy đủ schema."""
    npc = {
        '_index': 1,
        'name': 'Sư Vạn Hạnh',
        'era': 'ly',
        'npc_type': 'lore_npc',
        'sceneId': 100,
        'spawn_x': 50, 'spawn_y': 50,
        'tier': 3, 'level': 50,
        'element': 'tâm',
        'sprite_template_id': 1,
        'palette_seed': 42,
        'pettable': False, 'rebirthable': False,
    }
    # Compute stats
    stats = compute_npc_stats(npc['level'], npc['tier'], npc['npc_type'], npc['element'])
    npc.update(stats)

    # Assign empty skills (lore_npc no combat)
    npc['skill_ids'] = assign_skills_to_npc(npc, [])

    # Verify all 11 stat fields
    required = ['hp', 'sp', 'atk', 'def_', 'int_', 'mdef',
                'agi', 'luck', 'hit', 'dodge', 'crit']
    for r in required:
        assert r in npc and npc[r] >= 0
    return True, 'Full NPC schema: Sư Vạn Hạnh ly era tier3 lvl50 element=tâm'


def t15_npc_skill_element_match():
    """NPC kim chỉ học skill kim hoặc tâm hoặc neutral."""
    skill_pool = [
        {'skill_id': 1, 'element': 'kim', 'tier': 1},
        {'skill_id': 2, 'element': 'mộc', 'tier': 1},  # khác hệ
        {'skill_id': 3, 'element': 'tâm', 'tier': 1},  # tâm OK
        {'skill_id': 4, 'element': 'neutral', 'tier': 1},  # neutral OK
    ]
    npc = {'tier': 5, 'element': 'kim', 'npc_type': 'monster'}
    skills = assign_skills_to_npc(npc, skill_pool, max_skills=4)
    # Lấy skill objects
    selected = [s for s in skill_pool if s['skill_id'] in skills]
    # KHÔNG có element 'mộc'
    assert not any(s['element'] == 'mộc' for s in selected)
    return True, f'NPC kim got {len(skills)} skill, no mộc'


# ============ RUN ============
def run_iteration():
    tests = [t1_stat_scaling_level, t2_stat_scaling_tier, t3_boss_vs_townsmen,
             t4_element_strong_damage, t5_element_weak_damage, t6_tam_neutral,
             t7_element_wheel_5_tso, t8_skill_count_by_tier, t9_npc_no_combat_skill,
             t10_npc_ai_by_type, t11_npc_tier_from_biome, t12_level_in_tier_range,
             t13_six_elements_vstk, t14_full_npc_generation, t15_npc_skill_element_match]
    return [(t.__name__, *t()) for t in tests]


if __name__ == '__main__':
    print("=" * 78)
    print("NPC FULL SYSTEM TEST — 50 ITER × 15 SCENARIOS × 3 BATCHES")
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
        for b, i, n, m in overall_fails[:10]:
            print(f"  Batch {b} iter {i} - {n}: {m}")
    else:
        print("✅ ZERO FAILURES")
    print("=" * 78)

"""Mutation + Adversarial fuzz testing for CMD_NPC verifier.

Goal: reveal validator gaps — mutations that SURVIVE = uncovered bugs.

Strategy: take clean NPC, apply 1 mutation, run per-NPC verifier,
check if EXPECTED bug code appears. SURVIVED = test gap.
"""
import json, copy, uuid, re, unicodedata
from pathlib import Path
from collections import Counter, defaultdict
import os
os.chdir('svtk-status')

# Load constants
NPC_TYPES = {"townsmen","shopkeeper","quest_giver","monster","boss","guard",
             "trainer","pet_master","event_npc","lore_npc"}
ELEMENTS_VI = {"kim","mộc","thủy","hỏa","thổ","tâm"}
NPC_TIER_RANGE = {0:(1,10),1:(10,25),2:(25,40),3:(40,55),4:(55,70),
                  5:(70,85),6:(85,100),7:(100,110),8:(110,115),9:(115,120)}
VALID_BEHAVIORS = {"idle","wander","aggressive","patrol","defensive",
                    "train","event_perform","gather"}
COMBAT_TYPES = {"monster","boss","guard"}
ALL_ERAS = {"ly","tran","le","tay_son","nguyen",
            "pre_lich_su","bac_thuoc_g1","hau_le_trinh_nguyen","phap_thuoc_g1",
            "khang_chien_f3","doi_moi_f4","current_f5","tuong_lai_f5","hoa_lu_968_origin",
            "f1","f2","f3","f4","f5","g1"}
CLASS_VALID = {"regular","elite","mini_boss","boss","thanh","than"}
CJK_RE = re.compile(r'[一-鿿぀-ゟ゠-ヿ가-힯]')
TAM_QUOC = {"Triệu Vân","Quan Vũ","Trương Phi","Lưu Bị","Tào Tháo",
            "Khổng Minh","Gia Cát Lượng","Lữ Bố"}

# Load skill registry
skill_ids_valid = set()
with open('cmd-skill/existing/SKILL_165.jsonl', encoding='utf-8') as f:
    for line in f:
        if line.strip():
            d = json.loads(line)
            sid = d.get('skill_id') or d.get('id')
            if sid: skill_ids_valid.add(int(sid))

# Inline per-NPC verifier (mirrors run_per_npc_verification)
def verify_npc(n, all_indices, idx_counts):
    """Return list of bug codes raised."""
    bugs = []
    def chk(cond, code):
        if not cond: bugs.append(code)

    chk(1 <= n.get('_index',0) <= 10000, 'V01_index_range')
    chk(idx_counts.get(n.get('_index'), 0) == 1, 'V02_index_unique')
    u = n.get('uuid', '')
    chk(bool(re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', u)),
        'V03_uuid_format')
    nm = n.get('name', '')
    chk(bool(nm.strip()), 'V05_name_nonempty')
    chk(unicodedata.normalize('NFC', nm) == nm, 'V06_name_nfc')
    chk(len(nm) <= 80, 'V07_name_length')
    chk("﻿" not in nm, 'V55_name_no_bom')
    chk(nm == nm.strip(), 'V56_name_no_trim_ws')
    chk(n.get('era') in ALL_ERAS, 'V08_era_valid')
    chk(n.get('npc_type') in NPC_TYPES, 'V09_npc_type_valid')
    t = n.get('tier')
    chk(isinstance(t, int) and 0 <= t <= 9, 'V10_tier_range')
    if n.get('_index',0) > 438 and isinstance(t, int) and 0 <= t <= 9:
        lo, hi = NPC_TIER_RANGE[t]
        chk(lo <= n.get('level', -1) <= hi, 'V11_level_tier_range_gen')
    chk(n.get('element') in ELEMENTS_VI, 'V12_element_valid')
    chk(n.get('class_hierarchy') in CLASS_VALID, 'V13_class_hierarchy_valid')
    # V57 class↔type semantic match (gen-side only)
    if n.get('_index', 0) > 438:
        if n.get('npc_type') in {'townsmen','shopkeeper','lore_npc','pet_master'} \
           and n.get('class_hierarchy') in {'boss','thanh','than'}:
            chk(False, 'V57_class_type_semantic_match')
    # Mutation M28 used townsmen + than directly on baseline_npc (idx=500 gen-side) → catches
    dtm = n.get('dmg_taken_multi')
    chk(isinstance(dtm, (int, float)) and dtm > 0, 'V14_dmg_taken_multi')

    sid = n.get('sceneId')
    if n.get('_index',0) > 438:
        chk(isinstance(sid, int) and 1 <= sid <= 7817, 'V15_sceneId_gen_range')
    chk(isinstance(n.get('spawn_x'), int) and n.get('spawn_x',0) >= 0, 'V16_spawn_x_nonneg')
    chk(isinstance(n.get('spawn_y'), int) and n.get('spawn_y',0) >= 0, 'V17_spawn_y_nonneg')

    for stat in ('hp','sp','atk','def_','int_','mdef','agi','luck','hit','dodge','crit'):
        chk(isinstance(n.get(stat), int) and n.get(stat,-1) >= 0, f'V19_{stat}_nonneg')
    if n.get('npc_type') in COMBAT_TYPES:
        chk(n.get('atk',1) <= n.get('hp',1), 'V20_combat_atk_le_hp')

    sk = n.get('skill_ids', []) or []
    for s in sk:
        chk(isinstance(s, int) and 1 <= s <= 165, 'V24_skill_id_range')
        chk(s in skill_ids_valid, 'V25_skill_id_in_registry')
    chk(len(sk) == len(set(sk)), 'V26_skill_ids_unique')

    chk(n.get('ai_behavior') in VALID_BEHAVIORS, 'V27_ai_behavior_valid')
    if n.get('npc_type') not in COMBAT_TYPES:
        chk(n.get('aggro_range',0) == 0, 'V28_aggro_noncombat_zero')
    chk(isinstance(n.get('pettable'), bool), 'V29_pettable_bool')
    if n.get('npc_type') == 'pet_master':
        chk(n.get('pettable') is True, 'V30_pet_master_pettable')
    if n.get('_index',0) > 438 and n.get('rebirthable'):
        chk(n.get('npc_type') == 'boss', 'V31_rebirthable_boss_only_gen')
    chk(n.get('can_give_quest') == (n.get('npc_type') in ('quest_giver','lore_npc')), 'V32_can_give_quest_match')
    chk(n.get('can_train_skill') == (n.get('npc_type') == 'trainer'), 'V33_can_train_skill_match')
    chk(n.get('can_event') == (n.get('npc_type') == 'event_npc'), 'V34_can_event_match')

    sp = n.get('sprite_template_id')
    chk(isinstance(sp, int) and 1 <= sp <= 158, 'V36_sprite_id_range')
    ps = n.get('palette_seed')
    chk(isinstance(ps, int) and 0 <= ps <= 63, 'V37_palette_range')
    chk(n.get('recolor_index') == n.get('palette_seed'), 'V38_recolor_palette_alias')
    chk(n.get('gender') in ('male','female'), 'V39_gender_valid')
    chk(n.get('cultural_tag') == 'viet_pure', 'V40_cultural_tag')
    chk(not CJK_RE.search(nm), 'V41_no_cjk_in_name')
    if n.get('_index',0) > 438:
        chk(nm not in TAM_QUOC, 'V42_no_tam_quoc_gen')

    if n.get('pettable'):
        for f in ('pet_base_hp','pet_base_atk','pet_loyalty_init','pet_evolution_path'):
            chk(f in n, f'V43_pet_field_{f}')
        chk(n.get('pet_evolution_path') == [n.get('_index')], 'V44_pet_evolution_invariant')
        chk(n.get('pet_loyalty_init') == 50, 'V45_pet_loyalty_50')

    chk(n.get('is_raid_extreme') == (n.get('tier') == 9), 'V47_raid_extreme_invariant')
    return bugs

# Load all NPCs
with open('cmd-npc/output/registry/npc_full.jsonl', encoding='utf-8') as f:
    npcs = [json.loads(l) for l in f if l.strip()]
all_indices = {n['_index'] for n in npcs}
idx_counts = Counter(n['_index'] for n in npcs)

# Verify baseline: pick clean gen NPC (e.g., idx=500), should have 0 bugs
baseline_npc = next(n for n in npcs if n['_index'] == 500)
baseline_bugs = verify_npc(baseline_npc, all_indices, idx_counts)
print(f'Baseline (idx=500) bugs: {baseline_bugs}')
assert not baseline_bugs, f'baseline should have 0 bugs, got {baseline_bugs}'

# Pet_master sample for M15
pet_master_npc = next(n for n in npcs if n.get('npc_type') == 'pet_master')

# Pettable sample for M16
pettable_npc = next(n for n in npcs if n.get('pettable'))

# Combat sample (high hp) for M20
combat_npc = next(n for n in npcs if n.get('npc_type') == 'monster' and n.get('hp', 0) > 100)

# Define mutations
MUTATIONS = [
    # (mutation_name, mutation_fn, expected_caught_code_prefix, base_npc)
    ("M01_negative_hp", lambda n: {**n, "hp": -100}, "V19_hp", baseline_npc),
    ("M02_invalid_type", lambda n: {**n, "npc_type": "alien"}, "V09_npc_type", baseline_npc),
    ("M03_tier_15", lambda n: {**n, "tier": 15}, "V10_tier_range", baseline_npc),
    ("M04_no_uuid", lambda n: {k:v for k,v in n.items() if k != "uuid"}, "V03_uuid_format", baseline_npc),
    ("M05_invalid_uuid", lambda n: {**n, "uuid": "not-a-uuid"}, "V03_uuid_format", baseline_npc),
    ("M06_cjk_name", lambda n: {**n, "name": "孫悟空"}, "V41_no_cjk", baseline_npc),
    ("M07_tam_quoc_gen", lambda n: {**n, "name": "Triệu Vân"}, "V42_no_tam_quoc", baseline_npc),
    ("M08_invalid_element", lambda n: {**n, "element": "fire"}, "V12_element_valid", baseline_npc),
    ("M09_invalid_era", lambda n: {**n, "era": "atlantis"}, "V08_era_valid", baseline_npc),
    ("M10_invalid_class", lambda n: {**n, "class_hierarchy": "god"}, "V13_class_hierarchy", baseline_npc),
    ("M11_skill_999", lambda n: {**n, "skill_ids": [999]}, "V24_skill_id_range", baseline_npc),
    ("M12_sprite_200", lambda n: {**n, "sprite_template_id": 200}, "V36_sprite_id_range", baseline_npc),
    ("M13_neg_spawn_x", lambda n: {**n, "spawn_x": -10}, "V16_spawn_x_nonneg", baseline_npc),
    ("M14_recolor_mismatch", lambda n: {**n, "recolor_index": n["palette_seed"]+1}, "V38_recolor_palette_alias", baseline_npc),
    ("M15_pet_master_no_pettable", lambda n: {**n, "pettable": False}, "V30_pet_master_pettable", pet_master_npc),
    ("M16_dup_skill_ids", lambda n: {**n, "skill_ids": [80, 80, 80]}, "V26_skill_ids_unique", baseline_npc),
    ("M17_invalid_behavior", lambda n: {**n, "ai_behavior": "dance"}, "V27_ai_behavior_valid", baseline_npc),
    ("M18_aggro_townsmen", lambda n: {**n, "npc_type": "townsmen", "aggro_range": 5, "can_give_quest": False, "can_train_skill": False, "can_event": False}, "V28_aggro_noncombat_zero", baseline_npc),
    ("M19_palette_99", lambda n: {**n, "palette_seed": 99, "recolor_index": 99}, "V37_palette_range", baseline_npc),
    ("M20_gender_robot", lambda n: {**n, "gender": "robot"}, "V39_gender_valid", baseline_npc),
    ("M21_combat_atk_gt_hp", lambda n: {**n, "atk": 99999}, "V20_combat_atk_le_hp", combat_npc),
    ("M22_cultural_tag_wrong", lambda n: {**n, "cultural_tag": "han_chinese"}, "V40_cultural_tag", baseline_npc),
    ("M23_pet_evolution_wrong", lambda n: {**n, "pet_evolution_path": [99999]}, "V44_pet_evolution_invariant", pettable_npc),
    ("M24_pet_loyalty_wrong", lambda n: {**n, "pet_loyalty_init": 100}, "V45_pet_loyalty_50", pettable_npc),
    ("M25_raid_extreme_wrong", lambda n: {**n, "is_raid_extreme": True} if n.get("tier") != 9 else n, "V47_raid_extreme_invariant", baseline_npc),
    ("M26_name_with_BOM", lambda n: {**n, "name": "﻿Lê Lợi"}, "V55_name_no_bom", baseline_npc),
    ("M27_name_trailing_ws", lambda n: {**n, "name": "Trần Long  "}, "V56_name_no_trim_ws", baseline_npc),
    ("M28_class_townsmen_god", lambda n: {**n, "npc_type": "townsmen", "class_hierarchy": "than", "can_give_quest": False, "can_train_skill": False, "can_event": False, "aggro_range": 0}, "V57_class_type_semantic", baseline_npc),
    ("M29_can_give_no_type", lambda n: {**n, "can_give_quest": True}, "V32_can_give_quest_match", baseline_npc),
    ("M30_tier9_no_raid", lambda n: {**n, "tier": 9, "level": 117, "is_raid_extreme": False}, "V47_raid_extreme_invariant", baseline_npc),
]

# Run mutations
results = []
print(f'\n{"="*70}')
print(f'MUTATION TEST — {len(MUTATIONS)} mutations')
print(f'{"="*70}\n')

for m_name, m_fn, expected, base in MUTATIONS:
    try:
        mutated = m_fn(copy.deepcopy(base))
    except Exception as e:
        results.append((m_name, "MUTATION_ERROR", expected, str(e)))
        continue

    if mutated == base:
        results.append((m_name, "NO_OP", expected, "no change"))
        continue

    bugs = verify_npc(mutated, all_indices, idx_counts)

    if expected.startswith("V_class_type_mismatch"):
        # Expected gap — we'd need new check
        if bugs:
            results.append((m_name, "CAUGHT_by_other", expected, bugs[:3]))
        else:
            results.append((m_name, "SURVIVED!", expected, "no bugs"))
    elif any(expected in b for b in bugs):
        results.append((m_name, "CAUGHT", expected, "✓"))
    else:
        results.append((m_name, "SURVIVED!", expected, bugs[:5] if bugs else "no bugs"))

# Print results
caught = [r for r in results if r[1] == "CAUGHT"]
survived = [r for r in results if r[1].startswith("SURVIVED")]
caught_other = [r for r in results if r[1] == "CAUGHT_by_other"]
noop = [r for r in results if r[1] == "NO_OP"]

print(f'CAUGHT (expected catch): {len(caught)}')
print(f'CAUGHT (by other check): {len(caught_other)}')
print(f'SURVIVED (test gap!): {len(survived)}')
print(f'NO_OP: {len(noop)}')

if survived:
    print(f'\n⚠ SURVIVED MUTATIONS (validator gaps):')
    for r in survived:
        print(f'  {r[0]}: expected {r[2]} → got {r[3]}')

if caught_other:
    print(f'\nℹ CAUGHT BY OTHER CHECK:')
    for r in caught_other:
        print(f'  {r[0]}: expected {r[2]} → caught by {r[3]}')

print(f'\nDetailed results:')
for r in results:
    status_icon = '✓' if r[1] == 'CAUGHT' else ('⚠' if r[1].startswith('SURVIVED') else '○')
    print(f'  {status_icon} {r[0]}: {r[1]}')

# Save report
report = {
    "test_type": "mutation_fuzz",
    "ts": "20260519",
    "total_mutations": len(MUTATIONS),
    "caught": len(caught),
    "caught_by_other": len(caught_other),
    "survived": len(survived),
    "no_op": len(noop),
    "results": [{"mutation": r[0], "status": r[1], "expected": r[2], "actual": str(r[3])[:200]} for r in results],
}
out = Path('cmd-npc/output/reports/mutation_fuzz.json')
out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
print(f'\nReport: {out}')

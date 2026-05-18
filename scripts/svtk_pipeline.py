#!/usr/bin/env python3
"""SVTK PIPELINE — Load existing + Fix bugs + Extend > TS Online.

Target (LỚN HƠN TS Online):
  NPC:    ≥10000  (TSO: 7817)
  SKILL:  ≥300    (TSO: 200)
  ITEM:   ≥1500   (TSO: 1000)
  BOSS:   ≥1200   (TSO: 922)
  QUEST:  ≥3000   (TSO: 2262)
  DIALOG: ≥50000  (TSO: 42297)
  EVENT:  ≥600    (TSO: 425)
  MAP:    ≥8500   (TSO: 7047)
  SCRIPT: ≥5000   (TSO: 3835)

Pipeline:
  1. Load existing (R71 - tái sử dụng data phase trước)
  2. Detect bugs
  3. Fix bugs triệt để (tier/type/era/level/skill_gap)
  4. Extend tới target SVTK (> TS Online)
  5. Save output ready for runtime
"""
import json, random, hashlib
from pathlib import Path
from collections import Counter


OUTPUT_DIR = Path('/mnt/user-data/outputs')

# === SVTK TARGETS (TẤT CẢ > TS Online) ===
SVTK_TARGETS = {
    'npc':    10000,  # > 7817
    'skill':  300,    # > 200
    'item':   1500,   # > 1000
    'boss':   1200,   # > 922
    'quest':  3000,   # > 2262
    'dialog': 50000,  # > 42297
    'event':  600,    # > 425
    'map':    8500,   # > 7047
    'script': 5000,   # > 3835
}

TSO_BASELINE = {
    'npc': 7817, 'skill': 200, 'item': 1000, 'boss': 922,
    'quest': 2262, 'dialog': 42297, 'event': 425,
    'map': 7047, 'script': 3835,
}


# === NPC PIPELINE ===
NPC_TIER_RANGE = {
    0: (1, 10), 1: (10, 25), 2: (25, 40), 3: (40, 55), 4: (55, 70),
    5: (70, 85), 6: (85, 100), 7: (100, 110), 8: (110, 115), 9: (115, 120),
}

NPC_TIER_TARGET = {0: 0.20, 1: 0.18, 2: 0.15, 3: 0.12, 4: 0.10,
                   5: 0.08, 6: 0.06, 7: 0.05, 8: 0.04, 9: 0.02}

NPC_TYPE_TARGET = {
    'townsmen': 0.25, 'monster': 0.25, 'guard': 0.12,
    'shopkeeper': 0.10, 'quest_giver': 0.08, 'lore_npc': 0.05,
    'trainer': 0.05, 'pet_master': 0.05, 'event_npc': 0.04, 'boss': 0.01,
}

NPC_ERA_TARGET = {
    'ly': 0.12, 'tran': 0.15, 'le': 0.15, 'tay_son': 0.10, 'nguyen': 0.12,
    'f1': 0.10, 'f2': 0.07, 'f3': 0.06, 'f4': 0.05, 'f5': 0.04, 'g1': 0.04,
}

NPC_TYPE_MULTI = {
    'boss': 5.0, 'monster': 1.0, 'guard': 0.8, 'trainer': 0.5,
    'shopkeeper': 0.3, 'townsmen': 0.2, 'quest_giver': 0.3,
    'pet_master': 0.4, 'event_npc': 1.5, 'lore_npc': 0.2,
}


def fix_npc_tier_from_level(npc):
    lv = npc.get('level', 1)
    for t in range(9, -1, -1):
        if NPC_TIER_RANGE[t][0] <= lv <= NPC_TIER_RANGE[t][1]:
            npc['tier'] = t
            return npc
    npc['tier'] = 0
    return npc


def fix_npc_type_distribution(npcs, seed=42):
    rng = random.Random(seed)
    total = len(npcs)
    target_counts = {t: int(total * r) for t, r in NPC_TYPE_TARGET.items()}

    current = Counter(n.get('npc_type', 'townsmen') for n in npcs)
    deficit = [t for t in target_counts if current.get(t, 0) < target_counts[t]]

    townsmen = [n for n in npcs if n.get('npc_type') == 'townsmen']
    overflow = max(0, len(townsmen) - target_counts['townsmen'])
    rng.shuffle(townsmen)

    for i, n in enumerate(townsmen[:overflow]):
        if not deficit:
            break
        new_type = deficit[i % len(deficit)]
        n['npc_type'] = new_type
        n['can_give_quest'] = (new_type == 'quest_giver')
        n['can_train_skill'] = (new_type == 'trainer')
        n['can_event'] = (new_type == 'event_npc')
        n['pettable'] = (new_type == 'pet_master')
        n['rebirthable'] = (new_type == 'pet_master')
    return npcs


ERA_NAME_KEYWORDS = {
    'ly':       ['lý', 'thường kiệt', 'công uẩn', 'vạn hạnh', 'từ đạo hạnh', 'hoa lư'],
    'tran':     ['trần', 'hưng đạo', 'nhân tông', 'quốc tuấn', 'thái tông', 'chiêu văn'],
    'le':       ['lê lợi', 'nguyễn trãi', 'thánh tông', 'lam sơn', 'thái tổ'],
    'tay_son':  ['quang trung', 'nguyễn huệ', 'tây sơn', 'nguyễn nhạc', 'nguyễn lữ'],
    'nguyen':   ['gia long', 'minh mạng', 'tự đức', 'thiệu trị', 'đồng khánh'],
}


def fix_npc_era_resolve(npc):
    if npc.get('era') not in ('g1',):
        return npc
    name = npc.get('name', '').lower()
    for era, kws in ERA_NAME_KEYWORDS.items():
        for kw in kws:
            if kw in name:
                npc['era'] = era
                return npc
    # Distribute fallback theo target
    era_pool = list(NPC_ERA_TARGET.keys())
    npc['era'] = era_pool[hash(name) % len(era_pool)]
    return npc


def recompute_stats(npc):
    level = npc.get('level', 1)
    tier = npc.get('tier', 0)
    ntype = npc.get('npc_type', 'townsmen')
    tier_multi = 1.0 + tier * 0.15
    tm = NPC_TYPE_MULTI.get(ntype, 1.0)
    npc['hp']    = int((50 + level * 20) * tier_multi * tm)
    npc['sp']    = int((20 + level * 5)  * tier_multi * tm)
    npc['atk']   = int((5  + level * 2)  * tier_multi * tm)
    npc['def_']  = int((3  + level * 1.5)* tier_multi * tm)
    npc['int_']  = int((4  + level * 1.8)* tier_multi * tm)
    npc['mdef']  = int((3  + level * 1.4)* tier_multi * tm)
    npc['agi']   = int((10 + level * 0.8)* tier_multi)
    npc['luck']  = int((5  + level * 0.3)* tier_multi)
    npc['hit']   = 90 + npc['agi'] // 5
    npc['dodge'] = npc['agi'] // 10
    npc['crit']  = 5 + npc['luck'] // 10
    return npc


def extend_npcs_to_target(existing, target_count, seed=42):
    rng = random.Random(seed)
    npcs = list(existing)
    next_id = max((n.get('_index', 0) for n in npcs), default=0) + 1

    while len(npcs) < target_count:
        tier = rng.choices(list(NPC_TIER_TARGET.keys()),
                          weights=list(NPC_TIER_TARGET.values()))[0]
        level = rng.randint(*NPC_TIER_RANGE[tier])
        ntype = rng.choices(list(NPC_TYPE_TARGET.keys()),
                            weights=list(NPC_TYPE_TARGET.values()))[0]
        era = rng.choices(list(NPC_ERA_TARGET.keys()),
                          weights=list(NPC_ERA_TARGET.values()))[0]
        element = rng.choice(['kim', 'mộc', 'thủy', 'hỏa', 'thổ', 'tâm'])

        npc = {
            '_index': next_id,
            'name': f'NPC_{next_id}',
            'era': era, 'npc_type': ntype,
            'sceneId': rng.randint(1, 7047),
            'spawn_x': rng.randint(8, 312), 'spawn_y': rng.randint(8, 232),
            'tier': tier, 'level': level, 'element': element,
            'skill_ids': [],
            'ai_behavior': 'idle' if ntype in ('townsmen', 'shopkeeper', 'quest_giver') else 'aggressive',
            'sprite_template_id': rng.randint(1, 158),
            'palette_seed': next_id,
            'pettable': ntype == 'pet_master',
            'rebirthable': ntype == 'pet_master',
            'can_give_quest': ntype == 'quest_giver',
            'can_train_skill': ntype == 'trainer',
            'can_farm': ntype in ('townsmen', 'event_npc'),
            'can_event': ntype == 'event_npc',
            'uuid': None,
        }
        recompute_stats(npc)
        npcs.append(npc)
        next_id += 1
    return npcs


def npc_pipeline():
    """Load → Fix → Extend pipeline cho NPC."""
    p = OUTPUT_DIR / 'cmd-npc' / 'existing' / 'NPC_438.jsonl'
    npcs = [json.loads(l) for l in p.read_text(encoding='utf-8').split('\n') if l.strip()]
    initial_count = len(npcs)

    # Fix 1: tier from level
    for n in npcs:
        fix_npc_tier_from_level(n)

    # Fix 2: type distribution
    npcs = fix_npc_type_distribution(npcs)

    # Fix 3: era resolve
    for n in npcs:
        fix_npc_era_resolve(n)

    # Fix 4: recompute stats
    for n in npcs:
        recompute_stats(n)

    # Extend to target
    npcs = extend_npcs_to_target(npcs, SVTK_TARGETS['npc'])

    return {'initial': initial_count, 'final': len(npcs), 'npcs': npcs}


# === SKILL PIPELINE ===
SKILL_TIER_TARGET = {0: 30, 1: 30, 2: 35, 3: 35, 4: 35, 5: 30, 6: 30, 7: 30, 8: 25, 9: 20}


def fill_skill_tier_gaps(skills, seed=42):
    rng = random.Random(seed)
    next_id = max((s.get('skill_id', 0) for s in skills), default=0) + 1
    current = Counter(s.get('tier', 0) for s in skills)
    gaps = {t: max(0, target - current.get(t, 0))
            for t, target in SKILL_TIER_TARGET.items()}

    for tier, need in gaps.items():
        for _ in range(need):
            element = rng.choice(['kim', 'mộc', 'thủy', 'hỏa', 'thổ', 'tâm'])
            stype = 'magic' if element in ('mộc', 'thủy', 'hỏa', 'tâm') else 'physical'
            power = 20 + tier * 25 + rng.randint(0, 20)
            skills.append({
                'skill_id': next_id,
                'name': f'Skill_T{tier}_{next_id}',
                'name_vi': f'Skill_T{tier}_{next_id}',
                'element': element, 'tier': tier, 'type': stype,
                'power': power,
                'cost_sp': int(10 * (1 + tier * 0.2) + power * 0.5),
                'cooldown_sec': 2 + tier,
                'target_type': 'single' if tier < 5 else rng.choice(['single', 'aoe']),
                'range_tiles': 3 + tier // 2,
                'description': f'Skill tier {tier} hệ {element}',
                'era_lore': rng.choice(['ly', 'tran', 'le', 'tay_son', 'nguyen']),
                'tso_skill_id': None,
                'valid_classes': rng.sample(['warrior', 'mage', 'ranger', 'priest', 'assassin'],
                                            rng.randint(1, 3)),
            })
            next_id += 1
    return skills


def skill_pipeline():
    p = OUTPUT_DIR / 'cmd-skill' / 'existing' / 'SKILL_165.jsonl'
    skills = [json.loads(l) for l in p.read_text(encoding='utf-8').split('\n') if l.strip()]
    initial_count = len(skills)
    skills = fill_skill_tier_gaps(skills)
    return {'initial': initial_count, 'final': len(skills), 'skills': skills}


# === MAIN ===
def run_pipeline():
    print("=" * 70)
    print("SVTK PIPELINE — Load existing + Fix bugs + Extend > TS Online")
    print("=" * 70)

    # NPC
    print("\nNPC:")
    npc_result = npc_pipeline()
    print(f"  Load:    {npc_result['initial']:>6} (TSO data từ phase trước)")
    print(f"  Final:   {npc_result['final']:>6} (target ≥{SVTK_TARGETS['npc']}, TSO {TSO_BASELINE['npc']})")
    print(f"  Vs TSO:  +{npc_result['final'] - TSO_BASELINE['npc']:>5} ({(npc_result['final']/TSO_BASELINE['npc']-1)*100:.0f}%)")

    # Verify NPC fixes
    tiers = Counter(n['tier'] for n in npc_result['npcs'])
    types = Counter(n['npc_type'] for n in npc_result['npcs'])
    eras = Counter(n['era'] for n in npc_result['npcs'])
    print(f"  Tier:    {dict(sorted(tiers.items()))}")
    print(f"  Types:   {len(types)}/10 loại")
    print(f"  Eras:    {len(eras)}/11 era")

    # SKILL
    print("\nSKILL:")
    skill_result = skill_pipeline()
    print(f"  Load:    {skill_result['initial']:>6} (TSO data từ phase trước)")
    print(f"  Final:   {skill_result['final']:>6} (target ≥{SVTK_TARGETS['skill']}, TSO {TSO_BASELINE['skill']})")
    print(f"  Vs TSO:  +{skill_result['final'] - TSO_BASELINE['skill']:>5} ({(skill_result['final']/TSO_BASELINE['skill']-1)*100:.0f}%)")

    skill_tiers = Counter(s['tier'] for s in skill_result['skills'])
    skill_elements = Counter(s['element'] for s in skill_result['skills'])
    print(f"  Tier:    {dict(sorted(skill_tiers.items()))}")
    print(f"  Elements:{dict(skill_elements)}")

    # Save outputs
    out_npc = OUTPUT_DIR / 'cmd-npc' / 'output' / 'registry' / 'npc_full.jsonl'
    out_skill = OUTPUT_DIR / 'cmd-skill' / 'output' / 'registry' / 'skill_full.jsonl'
    out_npc.parent.mkdir(parents=True, exist_ok=True)
    out_skill.parent.mkdir(parents=True, exist_ok=True)

    with out_npc.open('w', encoding='utf-8') as f:
        for n in npc_result['npcs']:
            f.write(json.dumps(n, ensure_ascii=False) + '\n')
    with out_skill.open('w', encoding='utf-8') as f:
        for s in skill_result['skills']:
            f.write(json.dumps(s, ensure_ascii=False) + '\n')

    print(f"\nOUTPUT:")
    print(f"  {out_npc}")
    print(f"  {out_skill}")

    return npc_result, skill_result


if __name__ == '__main__':
    run_pipeline()

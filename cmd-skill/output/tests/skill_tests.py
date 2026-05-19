# -*- coding: utf-8 -*-
"""CMD_SKILL self-validation tests (≥15). Pytest-style but standalone runnable."""
import json, re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REG = ROOT / 'registry' / 'skill_full.jsonl'
BY_HE = ROOT / 'registry' / 'skill_by_he.jsonl'
TS_MAP = ROOT / 'registry' / 'ts_migration_map.json'
SCHEMA = ROOT / 'schema' / 'skill_table.sql'

ELEMENTS = ['kim', 'mộc', 'thủy', 'hỏa', 'thổ', 'tâm']
ERAS = ['ly', 'tran', 'le', 'nguyen', 'f1']
CJK_RE = re.compile(r'[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]')
TAM_QUOC_RE = re.compile(r'(Tào Tháo|Lưu Bị|Quan Vũ|Tam Quốc)')


def _load():
    with REG.open(encoding='utf-8') as f:
        return [json.loads(l) for l in f if l.strip()]


def test_01_count_target():
    assert len(_load()) >= 300, 'must have ≥300 skills'


def test_02_skill_id_unique():
    ids = [e['skill_id'] for e in _load()]
    assert len(ids) == len(set(ids)), 'skill_id must be unique'


def test_03_skill_id_range():
    ids = sorted(e['skill_id'] for e in _load())
    assert ids[0] == 1 and ids[-1] >= 300, 'ids must run 1..≥300'


def test_04_element_known():
    for e in _load():
        assert e['element'] in ELEMENTS, f'bad element {e["element"]}'


def test_05_era_known():
    for e in _load():
        assert e['era_lore'] in ERAS, f'bad era {e["era_lore"]}'


def test_06_no_cjk():
    txt = REG.read_text(encoding='utf-8')
    assert not CJK_RE.search(txt), 'CJK detected'


def test_07_no_tam_quoc():
    txt = REG.read_text(encoding='utf-8')
    assert not TAM_QUOC_RE.search(txt), 'Tam Quốc reference detected'


def test_08_tier_label_distribution():
    def lbl(t):
        if t <= 2: return 'basic'
        if t <= 4: return 'advanced'
        if t <= 7: return 'master'
        return 'ultimate'
    c = Counter(lbl(e['tier']) for e in _load())
    assert c['basic'] >= 100
    assert c['advanced'] >= 100
    assert c['master'] >= 70
    assert c['ultimate'] >= 30


def test_09_element_balance_min():
    c = Counter(e['element'] for e in _load())
    for el in ELEMENTS:
        assert c[el] >= 24, f'element {el} only {c[el]}'


def test_10_schema_unique_constraint():
    sql = SCHEMA.read_text(encoding='utf-8')
    assert 'UNIQUE(natural_key)' in sql


def test_11_idempotent_companions():
    for name in ['skill_full.jsonl', 'skill_by_he.jsonl', 'ts_migration_map.json']:
        p = REG.parent / name
        h = p.with_suffix(p.suffix + '.sha256')
        assert h.exists(), f'missing {h.name}'


def test_12_ts_migration_map_present():
    data = json.loads(TS_MAP.read_text(encoding='utf-8'))
    assert data['vstk_target'] == 300
    assert data['sample_size'] >= 50


def test_13_classes_safe():
    allowed = {'warrior', 'mage', 'priest', 'bach_than', 'hac_than'}
    for e in _load():
        for c in e['valid_classes']:
            assert c in allowed, f'unknown class {c}'


def test_14_new_skills_have_cost():
    # Existing IMMUTABLE: passive/utility skills may have cost=0. Enforce only on new (id>165).
    for e in _load():
        if e['skill_id'] > 165:
            assert e['cost_sp'] > 0, f'zero cost at new id={e["skill_id"]}'


def test_15_power_non_negative():
    for e in _load():
        assert e['power'] >= 0


def test_16_new_skills_cooldown_min():
    # Existing utility skills can be passive (cooldown=0). New must be >=2.
    for e in _load():
        if e['skill_id'] > 165:
            assert e['cooldown_sec'] >= 2, f'low cooldown at new id={e["skill_id"]}'


def test_17_target_type_set():
    allowed = {'single', 'aoe', 'self'}
    for e in _load():
        assert e['target_type'] in allowed


def test_18_self_target_zero_range():
    for e in _load():
        if e['target_type'] == 'self':
            assert e['range_tiles'] == 0


def test_19_existing_preserved():
    # Existing 165 must not be mutated — names should still be present
    existing = ROOT.parent / 'existing' / 'SKILL_165.jsonl'
    if not existing.exists():
        return
    with existing.open(encoding='utf-8') as f:
        old = {json.loads(l)['skill_id']: json.loads(l) for l in f if l.strip()}
    new_map = {e['skill_id']: e for e in _load()}
    for sid, e in old.items():
        for key in ('name', 'element', 'tier', 'power'):
            assert new_map[sid][key] == e[key], f'mutated id={sid} key={key}'


def test_20_by_he_count_matches_full():
    full = _load()
    total = 0
    with BY_HE.open(encoding='utf-8') as f:
        for line in f:
            if line.strip():
                total += json.loads(line)['count']
    assert total == len(full)


if __name__ == '__main__':
    import sys
    tests = sorted(k for k in globals() if k.startswith('test_'))
    passed = 0
    failed = []
    for t in tests:
        try:
            globals()[t]()
            passed += 1
        except AssertionError as e:
            failed.append((t, str(e)))
    print(f'TESTS pass={passed}/{len(tests)} fail={len(failed)}')
    for name, msg in failed:
        print(f'  FAIL {name}: {msg}')
    sys.exit(0 if not failed else 1)

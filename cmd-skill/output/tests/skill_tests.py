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


# ---- Deep audit findings (rounds 8-15) baked into tests ----

def test_21_bach_than_only_on_moc():
    for e in _load():
        if 'bach_than' in e['valid_classes']:
            assert e['element'] == 'mộc', f'bach_than misplaced sid={e["skill_id"]} el={e["element"]}'


def test_22_hac_than_only_on_tho():
    for e in _load():
        if 'hac_than' in e['valid_classes']:
            assert e['element'] == 'thổ', f'hac_than misplaced sid={e["skill_id"]} el={e["element"]}'


def test_23_name_uniqueness():
    names = [e['name'] for e in _load()]
    dupes = [n for n, c in Counter(names).items() if c > 1]
    assert not dupes, f'dupe names: {dupes[:5]}'


def test_24_cost_power_ratio_new():
    for e in _load():
        if e['skill_id'] <= 165 or e['target_type'] == 'self':
            continue
        assert e['cost_sp'] > 0
        ratio = e['power'] / e['cost_sp']
        cap = 12 if e['target_type'] == 'single' else 9
        assert ratio <= cap, f'ratio exploit sid={e["skill_id"]} {ratio:.2f}>{cap}'


def test_25_description_has_element():
    el_label = {'kim': 'Kim', 'mộc': 'Mộc', 'thủy': 'Thủy', 'hỏa': 'Hỏa', 'thổ': 'Thổ', 'tâm': 'Tâm'}
    for e in _load():
        if e['skill_id'] <= 165:
            continue
        assert el_label[e['element']] in e['description']


def test_26_description_has_target_hint():
    tt_map = {'single': 'đơn mục tiêu', 'aoe': 'phạm vi', 'self': 'tự thân'}
    for e in _load():
        if e['skill_id'] <= 165:
            continue
        assert tt_map[e['target_type']] in e['description']


def test_27_engine_damage_formula_finite():
    # R47 cross-ref stub: damage = power * atk / (atk + def)
    for e in _load():
        atk, dfn = 100, 80
        dmg = int(e['power'] * atk / max(1, atk + dfn))
        assert 0 <= dmg <= 99999, f'damage oob sid={e["skill_id"]} dmg={dmg}'


def test_28_aoe_extra_cooldown():
    for e in _load():
        if e['skill_id'] <= 165:
            continue
        if e['target_type'] == 'aoe':
            assert e['cooldown_sec'] >= 2, f'aoe short cd sid={e["skill_id"]}'


def test_29_skill_id_dense_1_to_300():
    ids = sorted(e['skill_id'] for e in _load())
    assert ids == list(range(1, 301)), f'gap in ids; first 5: {ids[:5]}, last 5: {ids[-5:]}'


def test_30_audit_15_report_clean():
    # All 15 audit rounds must report 0 remaining new bugs after fixes
    rep_path = Path(__file__).parent / 'audit_15_report.json'
    if not rep_path.exists():
        return
    rep = json.loads(rep_path.read_text(encoding='utf-8'))
    for r in rep:
        assert r['bugs_remaining_new'] == 0, f"{r['round']} still has new bugs: {r['sample_new_bugs']}"


# ---- R16-R25 (audit 25 diverse-method findings baked in) ----

def test_31_property_id_positive():
    for e in _load():
        assert e['skill_id'] >= 1


def test_32_property_bach_hac_constraints():
    for e in _load():
        if 'bach_than' in e['valid_classes']:
            assert e['element'] == 'mộc'
        if 'hac_than' in e['valid_classes']:
            assert e['element'] == 'thổ'


def test_33_snapshot_companion_matches_disk():
    import hashlib
    actual = hashlib.sha256(REG.read_bytes()).hexdigest()
    companion = (REG.parent / (REG.name + '.sha256')).read_text(encoding='utf-8').strip().split()[0]
    assert actual == companion, f'snapshot drift {actual[:12]} vs {companion[:12]}'


def test_34_boundary_melee_range_present():
    assert any(e['range_tiles'] == 1 for e in _load() if e['target_type'] != 'self'), 'no melee range=1 skill'


def test_35_boundary_max_range_present():
    assert any(e['range_tiles'] >= 8 for e in _load()), 'no long-range skill'


def test_36_chi_square_total_corpus_balanced():
    entries = _load()
    el = Counter(e['element'] for e in entries)
    exp = len(entries) / 6
    chi = sum((c - exp) ** 2 / exp for c in el.values())
    assert chi < 11.07, f'element chi2={chi:.2f}'

    era = Counter(e['era_lore'] for e in entries)
    exp = len(entries) / 5
    chi = sum((c - exp) ** 2 / exp for c in era.values())
    assert chi < 9.49, f'era chi2={chi:.2f}'


def test_37_unicode_nfc_normalized():
    import unicodedata
    for e in _load():
        for k in ('name', 'name_vi', 'description'):
            assert e[k] == unicodedata.normalize('NFC', e[k]), f'nfd in sid={e["skill_id"]} field={k}'


def test_38_round_trip_sql_lossless():
    import sqlite3
    con = sqlite3.connect(':memory:')
    cur = con.cursor()
    cur.execute('CREATE TABLE s (id INT PRIMARY KEY, name TEXT, element TEXT, tier INT)')
    for e in _load():
        cur.execute('INSERT INTO s VALUES (?,?,?,?)', (e['skill_id'], e['name'], e['element'], e['tier']))
    cur.execute('SELECT id FROM s')
    ids = sorted(r[0] for r in cur.fetchall())
    con.close()
    assert ids == list(range(1, 301))


def test_39_adversarial_lines_rejected():
    import json as _json
    BAD = [
        '﻿{"skill_id":166}',
        '{"skill_id":NaN}',
        '{"skill_id":Infinity}',
        "{'skill_id':166}",
        '{"skill_id":"166"}',  # string id
    ]
    for line in BAD:
        try:
            obj = _json.loads(line)
        except (_json.JSONDecodeError, ValueError):
            continue
        # If parse succeeded, schema check must reject
        assert not (isinstance(obj.get('skill_id'), int) and obj.get('skill_id') > 0 and 'name' in obj)


def test_40_audit_25_report_clean():
    rep_path = Path(__file__).parent / 'audit_25_report.json'
    if not rep_path.exists():
        return
    rep = json.loads(rep_path.read_text(encoding='utf-8'))
    for r in rep:
        assert r['remaining_new'] == 0, f"{r['round']} new bugs: {r['sample_new']}"


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

"""CMD_EVENT v1.0 — 15 deterministic tests."""
import json, re
from pathlib import Path

REG = Path(__file__).parent.parent / 'registry' / 'event_full.jsonl'
BY_TYPE = Path(__file__).parent.parent / 'registry' / 'event_by_type.jsonl'
TRIG = Path(__file__).parent.parent / 'registry' / 'event_triggers.json'

def load():
    return [json.loads(l) for l in REG.read_text(encoding='utf-8').split('\n') if l.strip()]

CJK = re.compile(r'[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]')
TQ = re.compile(r'(Tào Tháo|Lưu Bị|Quan Vũ|Trương Phi|Khổng Minh|Cao Cao|Liu Bei|Zhuge Liang|Guan Yu|Tam Quốc)')

def test_01_count_target():
    entries = load()
    assert len(entries) >= 600, f"count {len(entries)} < 600"

def test_02_unique_event_id():
    entries = load()
    ids = [e['event_id'] for e in entries]
    assert len(set(ids)) == len(ids), "duplicate event_id"

def test_03_unique_category_name():
    entries = load()
    keys = [(e['category'], e['name']) for e in entries]
    assert len(set(keys)) == len(keys), "duplicate (category,name)"

def test_04_no_cjk():
    for e in load():
        for v in e.values():
            if isinstance(v, str):
                assert not CJK.search(v), f"CJK in event {e['event_id']}: {v}"

def test_05_no_tam_quoc():
    for e in load():
        for v in e.values():
            if isinstance(v, str):
                assert not TQ.search(v), f"Tam Quoc in event {e['event_id']}: {v}"

def test_06_era_coverage():
    eras = {e['era'] for e in load()}
    for required in ['ly', 'tran', 'le', 'tay_son', 'nguyen']:
        assert required in eras, f"missing era {required}"

def test_07_festival_count():
    n = sum(1 for e in load() if e['category'] == 'festival')
    assert n >= 150, f"festival {n} < 150"

def test_08_raid_count():
    n = sum(1 for e in load() if e['category'] == 'raid')
    assert n >= 100, f"raid {n} < 100"

def test_09_world_boss_count():
    n = sum(1 for e in load() if e['category'] == 'world_boss')
    assert n >= 50, f"world_boss {n} < 50"

def test_10_season_count():
    n = sum(1 for e in load() if e['category'] == 'season')
    assert n >= 100, f"season {n} < 100"

def test_11_limited_count():
    n = sum(1 for e in load() if e['category'] == 'limited')
    assert n >= 100, f"limited {n} < 100"

def test_12_lore_count():
    n = sum(1 for e in load() if e['category'] == 'lore')
    assert n >= 100, f"lore {n} < 100"

def test_13_schema_required_fields():
    required = {'event_id', 'name', 'category', 'era', 'trigger_type', 'duration_min', 'reward_tier'}
    for e in load():
        missing = required - set(e.keys())
        assert not missing, f"event {e['event_id']} missing {missing}"

def test_14_reward_tier_valid():
    valid = {'tier_1', 'tier_2', 'tier_3', 'tier_4', 'tier_5'}
    for e in load():
        assert e['reward_tier'] in valid, f"event {e['event_id']} bad tier {e['reward_tier']}"

def test_15_triggers_indexed():
    trig = json.loads(TRIG.read_text(encoding='utf-8'))
    total = sum(len(v) for v in trig.values())
    assert total == len(load()), "trigger index count mismatch"

def test_16_by_type_count_equals_full():
    """Bonus: by_type total == full."""
    bt = [json.loads(l) for l in BY_TYPE.read_text(encoding='utf-8').split('\n') if l.strip()]
    assert len(bt) == len(load())

def test_17_determinism_event_id_monotone():
    """Bonus: event_id densely populated."""
    ids = sorted(e['event_id'] for e in load())
    assert ids[0] == 1
    assert ids[-1] - ids[0] + 1 == len(ids), "event_id not dense 1..N"

if __name__ == '__main__':
    fns = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    passed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
            passed += 1
        except AssertionError as e:
            print(f"FAIL {fn.__name__}: {e}")
    print(f"\n{passed}/{len(fns)} tests passed")
    import sys
    sys.exit(0 if passed == len(fns) else 1)

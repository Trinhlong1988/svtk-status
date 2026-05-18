"""QA_CONTENT — 15 self-validation tests."""
import json, re
from pathlib import Path

HERE = Path(__file__).resolve().parent
REGISTRY = HERE.parent / 'registry'
REPORT = json.loads((REGISTRY / 'qa_report.json').read_text(encoding='utf-8'))

TAM_QUOC = re.compile(r'(Tào Tháo|Lưu Bị|Quan Vũ|Cao Cao|Liu Bei|Tam Quốc)')
CJK = re.compile(r'[\u4E00-\u9FFF]')


def test_01_report_has_cmd():
    assert REPORT['cmd'] == 'QA_CONTENT'

def test_02_foundation_hash_present():
    assert len(REPORT['foundation_hash']) == 64

def test_03_targets_npc():
    assert REPORT['targets']['npc'] == 7817

def test_04_targets_quest():
    assert REPORT['targets']['quest'] == 2262

def test_05_targets_item():
    assert REPORT['targets']['item'] == 1000

def test_06_targets_dialog():
    assert REPORT['targets']['dialog'] == 42297

def test_07_verdicts_present():
    assert REPORT['verdicts']

def test_08_each_worker_has_verdict():
    for w in ['npc', 'quest', 'item', 'dialog', 'boss', 'skill', 'event']:
        assert w in REPORT['verdicts']

def test_09_no_tam_quoc_in_report_string():
    text = json.dumps(REPORT, ensure_ascii=False)
    assert not TAM_QUOC.search(text)

def test_10_no_cjk_in_report_string():
    text = json.dumps(REPORT, ensure_ascii=False)
    assert not CJK.search(text)

def test_11_failed_items_jsonl_exists():
    assert (REGISTRY / 'qa_failed_items.jsonl').exists()

def test_12_summary_sql_has_unique():
    sql = (REGISTRY / 'qa_summary_table.sql').read_text(encoding='utf-8')
    assert 'UNIQUE' in sql

def test_13_schema_has_index():
    sql = (HERE.parent / 'schema' / 'qa_content_table.sql').read_text(encoding='utf-8')
    assert 'INDEX' in sql

def test_14_issues_total_nonneg():
    assert REPORT['issues_total'] >= 0

def test_15_timestamp_format():
    assert re.match(r'^\d{8}-\d{6}$', REPORT['timestamp'])

if __name__ == '__main__':
    fns = [v for k, v in globals().items() if k.startswith('test_') and callable(v)]
    fails = []
    for fn in fns:
        try:
            fn()
            print(f'PASS {fn.__name__}')
        except AssertionError as e:
            print(f'FAIL {fn.__name__}: {e}')
            fails.append(fn.__name__)
    print(f'\n{len(fns) - len(fails)}/{len(fns)} pass')

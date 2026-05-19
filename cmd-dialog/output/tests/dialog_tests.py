"""15 dialog tests — CMD_DIALOG v1.1 acceptance."""
import json
from pathlib import Path

# tests/ is at cmd-dialog/output/tests/, so parents[1] = output/
OUTPUT = Path(__file__).resolve().parents[1]
REG = OUTPUT / "registry"


def _load_full():
    return [json.loads(line)
            for line in (REG / "dialog_full.jsonl").read_text("utf-8").splitlines()
            if line.strip()]


def test_count_50000():
    assert sum(1 for _ in (REG / "dialog_full.jsonl").open("r", encoding="utf-8")) >= 50000


def test_greeting_8000():
    n = sum(1 for line in (REG / "dialog_greeting.jsonl").open("r", encoding="utf-8") if line.strip())
    assert n >= 8000


def test_quest_12000():
    n = sum(1 for line in (REG / "dialog_quest.jsonl").open("r", encoding="utf-8") if line.strip())
    assert n >= 12000


def test_lore_5000():
    n = sum(1 for line in (REG / "dialog_lore.jsonl").open("r", encoding="utf-8") if line.strip())
    assert n >= 5000


def test_bark_7000():
    n = sum(1 for line in (REG / "dialog_bark.jsonl").open("r", encoding="utf-8") if line.strip())
    assert n >= 7000


def test_combat_5000():
    n = sum(1 for line in (REG / "dialog_combat.jsonl").open("r", encoding="utf-8") if line.strip())
    assert n >= 5000


def test_trade_3000():
    n = sum(1 for line in (REG / "dialog_trade.jsonl").open("r", encoding="utf-8") if line.strip())
    assert n >= 3000


def test_story_2297():
    n = sum(1 for line in (REG / "dialog_story.jsonl").open("r", encoding="utf-8") if line.strip())
    assert n >= 2297


def test_unique_dialog_id():
    full = _load_full()
    ids = [d["i"] for d in full]
    assert len(ids) == len(set(ids))


def test_cultural_lock_no_cjk():
    import re
    pat = re.compile(r"[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]")
    full = _load_full()
    bad = [d for d in full if pat.search(d["text"])]
    assert not bad, f"CJK found in {len(bad)} lines"


def test_cultural_lock_no_tam_quoc():
    import re
    pat = re.compile(r"(Tào Tháo|Lưu Bị|Quan Vũ|Trương Phi|Khổng Minh|Tam Quốc)", re.IGNORECASE)
    full = _load_full()
    bad = [d for d in full if pat.search(d["text"])]
    assert not bad, f"Tam Quốc ref in {len(bad)} lines"


def test_5_main_eras_present():
    full = _load_full()
    eras = {d["era"] for d in full}
    main = {"ly", "tran", "le", "tay_son", "nguyen"}
    assert main.issubset(eras), f"missing eras: {main - eras}"


def test_speaker_id_linked():
    full = _load_full()
    bad = [d for d in full if not isinstance(d.get("speaker_id"), int) or d["speaker_id"] < 1]
    assert not bad


def test_schema_sql_exists():
    p = OUTPUT / "schema" / "dialog_table.sql"
    assert p.exists() and p.stat().st_size > 200


def test_split_by_type_files():
    types = ["greeting", "quest", "lore", "bark", "combat", "trade", "story"]
    for t in types:
        p = REG / f"dialog_{t}.jsonl"
        assert p.exists()


def test_cultural_lock_pass_field_correct():
    full = _load_full()
    bad = [d for d in full if d.get("cultural_lock_pass") is not True]
    assert not bad, f"cultural_lock_pass=False in {len(bad)} lines"

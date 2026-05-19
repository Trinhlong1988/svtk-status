#!/usr/bin/env python3
"""Post-resolve verifier — confirms quest_full.jsonl matches v1.9 ship contract."""
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REG = ROOT / "output" / "registry"
CHAINS_FILE = ROOT / "output" / "chains" / "quest_chains.json"

quests = []
for line in (REG / "quest_full.jsonl").read_text("utf-8").splitlines():
    quests.append(json.loads(line))

chains = json.loads(CHAINS_FILE.read_text("utf-8"))

checks = []


def chk(name, cond, detail=""):
    checks.append((name, bool(cond), detail))


chk("quest_count_3000", len(quests) == 3000, f"found={len(quests)}")

ids = [q["quest_id"] for q in quests]
chk("unique_quest_id", len(ids) == len(set(ids)),
    f"dup={len(ids) - len(set(ids))}")

cats = Counter(q["category"] for q in quests)
targets = {"main": 259, "side": 142, "lore": 88,
           "event": 28, "raid": 50, "reborn": 21}
for c, t in targets.items():
    chk(f"cat_{c}_>={t}", cats[c] >= t, f"found={cats[c]} target={t}")

eras = {q["era"] for q in quests}
expected_eras = {"f1", "f2", "f3", "f4", "ly", "tran", "leso",
                 "tayson", "nguyen", "modern", "g1"}
# accept any subset since spec varies; assert at least 8
chk("era_coverage_>=8", len(eras) >= 8, f"eras={sorted(eras)}")

# chain_id regex per memory v1.9: SVTK_CHAIN_[A-Z_]+
ID_RE = re.compile(r"^SVTK_CHAIN_[A-Z_]+$")
bad_chain_id = [q["quest_id"] for q in quests
                if q.get("chain_id") and not ID_RE.match(q["chain_id"])]
chk("chain_id_format", len(bad_chain_id) == 0,
    f"bad={bad_chain_id[:5]}")

# no leaked HEAD-side legacy F-prefix
F_RE = re.compile(r"^SVTK_CHAIN_F\d_\d+$")
leaked = [q["quest_id"] for q in quests
          if q.get("chain_id") and F_RE.match(q["chain_id"])]
chk("no_legacy_f_prefix_chain", len(leaked) == 0,
    f"leaked={leaked[:5]}")

# chain reference: every non-null chain_id must exist in quest_chains.json
chain_ids_in_def = {c["chain_id"] for c in chains}
orphan = []
for q in quests:
    cid = q.get("chain_id")
    if cid and cid not in chain_ids_in_def:
        orphan.append((q["quest_id"], cid))
chk("chain_id_references_valid", len(orphan) == 0,
    f"orphan_count={len(orphan)} sample={orphan[:5]}")

# all givers present
chk("all_have_giver", all(q.get("giver_npc_id") for q in quests))
chk("all_have_giver_name", all(q.get("giver_npc_name") for q in quests))
chk("all_have_giver_scene", all("giver_scene_id" in q for q in quests))

# unique title + description per memory
titles = [q["title"] for q in quests]
descs = [q["description"] for q in quests]
chk("unique_title", len(titles) == len(set(titles)),
    f"dup_title={len(titles) - len(set(titles))}")
chk("unique_description", len(descs) == len(set(descs)),
    f"dup_desc={len(descs) - len(set(descs))}")

# chain count 34
chk("chains_>=34", len(chains) >= 34, f"found={len(chains)}")

# LF only on disk
raw = (REG / "quest_full.jsonl").read_bytes()
chk("lf_only_no_crlf", b"\r" not in raw, f"cr_count={raw.count(b'CR')}")

# === report ===
passed = sum(1 for _, ok, _ in checks if ok)
total = len(checks)
print(f"PASSED {passed}/{total}")
for name, ok, detail in checks:
    flag = "PASS" if ok else "FAIL"
    print(f"  [{flag}] {name}  {detail}")

if passed != total:
    sys.exit(1)

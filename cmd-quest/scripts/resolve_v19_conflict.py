#!/usr/bin/env python3
"""Resolve git merge conflict markers in quest_full.jsonl, keep theirs (staging-quest v1.9)."""
import json
import sys
from pathlib import Path

REGISTRY = Path(__file__).resolve().parent.parent / "output" / "registry" / "quest_full.jsonl"
TARGET_COUNT = 3000

raw = REGISTRY.read_bytes()
text = raw.decode("utf-8")
lines = text.split("\n")

resolved = []
state = "NORMAL"  # NORMAL | IN_HEAD | IN_STAGING
markers = {"head": 0, "sep": 0, "end": 0}

for ln in lines:
    if ln.startswith("<<<<<<<"):
        if state != "NORMAL":
            sys.exit(f"unexpected <<< while state={state}")
        state = "IN_HEAD"
        markers["head"] += 1
        continue
    if ln.startswith("======="):
        if state != "IN_HEAD":
            sys.exit(f"unexpected === while state={state}")
        state = "IN_STAGING"
        markers["sep"] += 1
        continue
    if ln.startswith(">>>>>>>"):
        if state != "IN_STAGING":
            sys.exit(f"unexpected >>> while state={state}")
        state = "NORMAL"
        markers["end"] += 1
        continue
    if state == "IN_HEAD":
        continue
    resolved.append(ln)

if state != "NORMAL":
    sys.exit(f"file ended with state={state}")

if markers["head"] != markers["sep"] or markers["sep"] != markers["end"]:
    sys.exit(f"unbalanced markers: {markers}")

# Trim trailing empty line and re-emit exactly one terminal \n
while resolved and resolved[-1] == "":
    resolved.pop()

# Parse-test every line and count
parsed = 0
for i, ln in enumerate(resolved, 1):
    try:
        json.loads(ln)
    except Exception as e:
        sys.exit(f"line {i} not valid JSON: {e}")
    parsed += 1

if parsed != TARGET_COUNT:
    sys.exit(f"expected {TARGET_COUNT} quests, got {parsed}")

# Force LF (R+v1.9 rule) and one trailing newline
out_bytes = ("\n".join(resolved) + "\n").encode("utf-8")
REGISTRY.write_bytes(out_bytes)

CR = b"\r"
print(f"OK markers={markers} quests={parsed} bytes={len(out_bytes)} crlf={out_bytes.count(CR)}")

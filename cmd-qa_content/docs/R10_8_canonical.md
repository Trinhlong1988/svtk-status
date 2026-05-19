# R10.8 Anti-Snowball Rule — Canonical Mode

**Decision date:** 2026-05-19
**Decided by:** Mr.Long
**Reference:** alert `INFO-r10_8_mode_canonical_decision-20260519-153344.json`

## Canonical mode = PER_STEP

```
max(stats[tier_n+1]) / max(stats[tier_n]) ≤ 2.5  for each pair in:
common → uncommon → rare → epic → legendary → mythic
```

## Rejected: GLOBAL mode

`max(any_tier) / max(common) ≤ 2.5` rejected because mythic intentionally > 2.5x
common for monetize Phương án C (skill v15).

## QA enforcement

`verify_anti_snowball()` in `cmd_qa_content.py` checks per-step only.
2 outliers from earlier runs (Kiếm Bạch Đằng epic sat_luc 80, Nhẫn Long Hứa
mythic phap_luc 60) are CANONICAL VALID under per-step rule.

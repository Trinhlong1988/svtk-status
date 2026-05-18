# CMD NPC

NPC registry for SVTK Sử Việt Truyền Kỳ — 10000 NPCs sử Việt.

## Quick links

- **Brief (R71.1 preserved):** [cmd.md](cmd.md) — original AUTONOMOUS spec from Mr.Long
- **Audit history (80 hidden bugs fixed):** [AUDIT_INDEX.md](AUDIT_INDEX.md)
- **Output registry:** `output/registry/npc_full.jsonl` (10000 NPCs)
- **Validation:** `output/reports/validation.json` (55/55 checks PASS)
- **Honest gaps:** `output/reports/honest_gaps.json`

## Structure

```
cmd-npc/
├── README.md            (this file)
├── cmd.md               (original brief — R71.1 preserved)
├── AUDIT_INDEX.md       (8-round audit history)
├── existing/            (R71 immutable source — NPC_438.jsonl)
├── output/
│   ├── registry/        (npc_main + npc_side + npc_lore + npc_generated + npc_full).jsonl + .sha256
│   ├── era/             (era_ly/tran/le/tay_son/nguyen/extra_9).json
│   ├── sprite_mapping/  (npc_sprite_map.json)
│   ├── schema/          (npc_table.sql — PostgreSQL DDL with R45/R46/R74/R80 CHECK constraints)
│   ├── reports/         (validation, cultural_lock_audit, era_distribution, honest_gaps).json
│   └── metrics.json
├── status/              (per-build status.json + AUDIT_REPORT_ROUND_*.md, capped 3 latest)
├── status-archived/     (older status, capped 5)
├── status-archived-cold/(very old status, long-term storage)
├── transaction_log/     (R74.B template_ship transactions, idempotent)
└── inbox/               (LEAD fix tasks landing here — processed → completion)
```

## Cumulative audit status

- **80 hidden bugs fixed** across 8 audit rounds (R1-R80).
- **Validator: 55/55 PASS** (rate 1.0).
- **Active ex-side alerts: 13** (R71.1 immutable source side; documented for source-team regen).
- **Generated-side: 0 violations.**

See [AUDIT_INDEX.md](AUDIT_INDEX.md) for per-round detail.

## Foundation rules referenced

- R30 cultural lock (Vietnamese identity, anti-CJK/Tam Quốc)
- R71 registry reuse (existing IMMUTABLE; extend only)
- R74 anti-dupe 6 rules (UUID per instance, transaction log, etc.)
- R75 NPC→Map allocation (spawn density, position spacing ≥8 tile)
- R76 tier hierarchy 0-9
- R78 stat formula (hp = (50 + lv×20) × tier_multi × type_multi)
- R79 6-element wheel VSTK
- R80 6 class hierarchy (regular/elite/mini_boss/boss/thanh/than) with dmg_taken_multi
- R83 protagonist Trần Long + mentor Sư Vạn Hạnh

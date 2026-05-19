# CMD_SKILL v1.0 output

Ship: 2026-05-19. Brief: `Desktop\CMD_SKILL_v1.0.md`.

## Targets vs actual

| Metric | Target | Actual |
|---|---|---|
| Total skills | ≥300 | **300** |
| Tier basic | 100 | 100 |
| Tier advanced | 100 | 100 |
| Tier master | 70 | 70 |
| Tier ultimate | 30 | 30 |
| Elements (6) | ~50 each | 50/50/50/50/50/50 |
| Eras (5) | ~60 each | 60/60/60/60/60 |
| Tests pass | ≥15 | **20/20** |
| Validation score | ≥0.95 | **1.00** |

## Existing IMMUTABLE

R71 honoured: 165 existing entries from `cmd-skill/existing/SKILL_165.jsonl` unchanged.
New extension covers `skill_id` 166..300.

## Schema (existing convention)

`{skill_id, name, name_vi, element, tier (int 0..9), type (physical|magic), power,
cost_sp, cooldown_sec, target_type (single|aoe|self), range_tiles, description,
era_lore (ly|tran|le|nguyen|f1), tso_skill_id, valid_classes[]}`

Tier int → label mapping in tests/build:
- 0..2 → basic
- 3..4 → advanced
- 5..7 → master
- 8..9 → ultimate

Brief HE_LIST had 7 entries including `Bach` as element; per memory rule
2026-05-18 (BẠCH/HẮC = class RB3, NOT element) and existing 165 schema, this
build keeps **6 elements** (kim/mộc/thủy/hỏa/thổ/tâm) and treats
`bach_than`/`hac_than` as `valid_classes`.

Brief foundation hash `2e6e8c23d8...` referenced stale v2.6.0 path. Actual
foundation file is `SVTK_FOUNDATION_v2.8.0.md`, CRLF canonical hash
`4e9a6d7adc736ecdb115b337a280c6f150200c022a77ce78714a21f7152b364b` —
matches `foundation/INDEX.sha256` and memory rule (2026-05-19 cycle 93).

## Honest gaps (per brief audit, 4 MED)

1. Skill animation hint = name only — no sprite/timing FX manifest yet.
2. TS migration map sample: 60/200 entries deterministic round-trip; full PKT
   cross-ref pending CMD_QA_CONTENT verify.
3. No combo chains in v1.0 (cooldown_lock + 6-chain combos pending CMD1 wire).
4. Cooldown not playtested — values derived from tier_int rule, no balance pass.

## Outputs

- `registry/skill_full.jsonl` — 300 entries (`name` etc.)
- `registry/skill_by_he.jsonl` — 6 bucket rows by element
- `registry/ts_migration_map.json` — sample TSO→VSTK map
- `schema/skill_table.sql` — DDL with UNIQUE(natural_key)
- `tests/skill_tests.py` — 20 self-validation tests
- `*.sha256` companions for idempotent re-runs

## Determinism

Seeded RNG: `random.Random(int.from_bytes(sha256(f"skill:{skill_id}").digest()[:8], "big"))`.
No `Math.random`. Rebuild yields identical JSONL byte-for-byte.

# Migration Integrity Audit — CMD2 Week 1 (deep recheck)

> **Author:** CMD2 (cmd-db + cmd-item + cmd-engine economy split)
> **Trigger:** "em kiểm tra sâu lại code lần nữa" — Mr.Long 2026-05-18
> **Verdict:** Week 1 file copy is **correct per AUTO_START prompt globs**, but NEW layout has **18 files with broken `import` paths**. The migrated tree is NOT standalone-compilable. This is a **natural consequence of monolith→split**, and was implicitly Week 2 work — making it explicit here.

---

## 1. File-copy correctness (vs AUTO_START § TASK 1 globs)

| Glob | Source (OLD) | Target (NEW) | Files | Match |
|------|--------------|--------------|-------|-------|
| `src/db/connection.ts + inventory_snapshot_persist.ts` | 2 | `cmd-db/output/legacy/` | 2 | ✅ |
| `src/db/repositories/*.ts` | 5 | `cmd-db/output/legacy/repositories/` | 5 | ✅ |
| `migrations/*.sql` | 4 | `cmd-db/migrations/` | 4 | ✅ |
| `src/modules/economy_integration/persistence_*.ts` | 2 (persistence_adapter + persistence_adapter_bridge) | `cmd-db/output/persistence/` | 2 | ✅ |
| `src/modules/economy_integration/cross_region_integrity_runtime.ts` | 1 | `cmd-db/output/integrity/` | 1 | ✅ |
| `economy_integrity_verification_runtime.ts` | 1 | `cmd-db/output/anti_dupe/` | 1 | ✅ |
| `src/modules/itemization/*.ts` | 27 | `cmd-item/output/legacy/` | 27 | ✅ |
| 7 JSON (itemization_constants, items, loot_tables, affix_pool, sets, stat_budget, slot_cap) | 7 | `cmd-item/data/` | 7 | ✅ |
| `src/modules/economy/economy_foundation_runtime*.ts` | 2 | `cmd-engine/output/economy/foundation/` | 2 | ✅ |
| `src/modules/economy/loot_generation_runtime*.ts` | 2 | `cmd-engine/output/economy/loot/` | 2 | ✅ |
| `src/modules/economy/pvp_equipment_normalizer*.ts` | 2 | `cmd-engine/output/economy/pvp/` | 2 | ✅ |
| 2 economy JSON (economy_constants, pvp_normalization) | 2 | `cmd-engine/data/economy/` | 2 | ✅ |
| **TOTAL** | **57** | | **57** | **✅ 100% glob match** |

---

## 2. Broken import paths in NEW layout (18 files)

NEW tree is content-only (no `package.json`/`tsconfig.json` at repo root). If someone tries to `tsc` cmd-db/cmd-item/cmd-engine standalone, the following imports will FAIL to resolve:

### 2a. cmd-db (6 files)

| File | Broken import | Reason |
|------|---------------|--------|
| `output/anti_dupe/economy_integrity_verification_runtime.ts` | `'../economy/inventory_snapshot_schema.js'`, `'../economy/economy_serialization_contract.js'`, `'../economy/modifier_ordering_audit.js'` | OLD layout `src/modules/economy/` sibling; NEW has no `cmd-db/output/economy/` |
| `output/integrity/cross_region_integrity_runtime.ts` | `'../economy/modifier_ordering_audit.js'`, `'../economy/economy_serialization_contract.js'` | same |
| `output/persistence/persistence_adapter.ts` | `'../economy/inventory_snapshot_schema.js'`, `'../economy/economy_serialization_contract.js'`, `'../../_shared/codepoint_compare.js'`, `'../economy/economy_foundation_runtime.js'`, `'../economy/economy_forensic_telemetry.js'`, `'../economy/modifier_ordering_audit.js'` | mixed: cross-module + cross-repo-shared |
| `output/persistence/persistence_adapter_bridge.ts` | `'../economy/modifier_ordering_audit.js'`, `'../economy/economy_serialization_contract.js'` | same |
| `output/legacy/inventory_snapshot_persist.ts` | `'../modules/economy/inventory_snapshot_schema.js'`, `'../modules/economy/economy_serialization_contract.js'` | OLD layout `src/modules/` ancestor; NEW has no `cmd-db/output/modules/` |
| `output/legacy/repositories/inventory_repository.ts` | `'../../modules/economy/inventory_snapshot_schema.js'` | same |

### 2b. cmd-item (7 files)

| File | Broken import | Reason |
|------|---------------|--------|
| `output/legacy/affix_runtime.ts` | `'../../_shared/codepoint_compare.js'` | OLD `src/_shared/` not migrated to any cmd-* |
| `output/legacy/equipment_aggregate.ts` | `'../../_shared/codepoint_compare.js'` | same |
| `output/legacy/itemization_types.ts` | `'../../logic/types.js'` (exports `ElementSchema`, `Element`) | OLD `src/logic/types.ts` not migrated (CMD1 territory per role binding) |
| `output/legacy/loot_generation_hooks.ts` | `'../../_shared/codepoint_compare.js'` | same |
| `output/legacy/modifier_pipeline.ts` | `'../../logic/soft_cap.js'`, `'../../_shared/codepoint_compare.js'` | same |
| `output/legacy/passive_resolver.ts` | `'../../_shared/codepoint_compare.js'` | same |
| `output/legacy/set_bonus.ts` | `'../../_shared/codepoint_compare.js'` | same |

### 2c. cmd-engine economy (5 files)

| File | Broken import | Reason |
|------|---------------|--------|
| `output/economy/foundation/economy_foundation_runtime.ts` | `'../itemization/itemization_types.js'` | itemization is now in cmd-item, NOT sibling to cmd-engine/output/economy |
| `output/economy/foundation/economy_foundation_runtime_impl.ts` | `'./_schema_helpers.js'` | `_schema_helpers.ts` is a peer in OLD `src/modules/economy/`, NOT migrated to cmd-engine/output/economy/foundation/ |
| `output/economy/loot/loot_generation_runtime.ts` | (only type re-export — see impl) | — |
| `output/economy/loot/loot_generation_runtime_impl.ts` | `'../../logic/rng.js'`, `'../itemization/affix_runtime.js'`, `'../../_shared/codepoint_compare.js'`, `'../itemization/item_registry.js'`, `'./_schema_helpers.js'` | mixed: cross-CMD (itemization→cmd-item) + cross-repo-shared (_shared, logic) + peer missing (_schema_helpers) |
| `output/economy/pvp/pvp_equipment_normalizer.ts` | `'../itemization/itemization_types.js'` | same as foundation |
| `output/economy/pvp/pvp_equipment_normalizer_impl.ts` | `'../itemization/itemization_types.js'`, `'./_schema_helpers.js'` | same |

---

## 3. Peer files in OLD `src/modules/economy/` that the migrated 6 files depend on (NOT migrated per AUTO_START § C glob, but transitively required)

| Missing peer | Used by | Severity |
|--------------|---------|----------|
| `_schema_helpers.ts` | foundation_impl, loot_impl, pvp_impl | 🔴 P0 (3 of 6 cmd-engine files) |
| `inventory_snapshot_schema.ts` | persistence_adapter, anti_dupe_verification, inventory_snapshot_persist, inventory_repository | 🔴 P0 (4 cmd-db files) |
| `economy_serialization_contract.ts` | persistence_adapter, persistence_adapter_bridge, anti_dupe_verification, integrity_runtime, inventory_snapshot_persist | 🔴 P0 (5 cmd-db files) |
| `modifier_ordering_audit.ts` (exports `fnv1a32`) | persistence_adapter, persistence_adapter_bridge, anti_dupe_verification, integrity_runtime | 🔴 P0 (4 cmd-db files) |
| `economy_forensic_telemetry.ts` | persistence_adapter | 🟡 P1 (1 file) |
| `index.ts` | none directly (barrel) | 🟢 P2 |
| `cmd1_anomaly_wire.ts` | none in migrated set | 🟢 P2 (CMD1 wire) |
| `rng_ownership_audit.ts` | none in migrated set | 🟢 P2 |

---

## 4. Cross-repo-shared dependencies (NOT in any cmd-* per current 13-CMD role binding)

| OLD path | Used by NEW cmd-* | Recommendation |
|----------|------------------|----------------|
| `src/_shared/codepoint_compare.ts` (1 file) | 6 cmd-item + 1 cmd-engine + 1 cmd-db (8 callsites) | Vendor into `foundation/shared/` OR new `cmd-shared/` slot OR copy peer per cmd-* |
| `src/logic/types.ts` | 1 cmd-item (Element schema) | cmd-engine owns logic/ per role binding § CMD1; export from `cmd-engine/output/core/types.ts` |
| `src/logic/soft_cap.ts` | 1 cmd-item (applySoftCap) | same — cmd-engine port |
| `src/logic/rng.ts` | 1 cmd-engine economy/loot | same — cmd-engine port |

---

## 5. Why OLD test suite passes 1095/1095 but NEW does not compile

- OLD `D:/DỰ ÁN AI/FINAL TSONLINE/` has all siblings intact (`src/_shared/`, `src/logic/`, `src/modules/economy/` complete with all 14 files including `_schema_helpers.ts`).
- vitest run in Week 3 was executed against OLD workspace (per `completions/cmd-db_done_full_*` → `method: "vitest run tests/economy/ + tests/economy_integration/ in OLD workspace"`).
- NEW workspace `D:/svtk-status/cmd-db/cmd-item/cmd-engine/` has ONLY the 57 files copied, missing the transitive dependency graph above.
- Per AUTO_START § "TS compile + commit + push" — em explicitly recorded `ts_compile_status: SKIP (svtk-status is content-only repo, no tsconfig at root — defer compile to Week 2 when integration wire)`.

**This audit makes that deferral concrete:** Week 2 wire is not optional — without it, NEW tree is unconsumable.

---

## 6. Remediation options (autonomous-pickable per spec, ranked by least disturbance)

### Option A — Vendor missing peers into cmd-engine/output/economy/ (recommended) ⭐
- Copy 5 OLD `src/modules/economy/` peer files to `cmd-engine/output/economy/`:
  - `_schema_helpers.ts`, `inventory_snapshot_schema.ts`, `economy_serialization_contract.ts`, `modifier_ordering_audit.ts`, `economy_forensic_telemetry.ts`
- Place them at `cmd-engine/output/economy/` (NOT inside foundation/loot/pvp), then patch foundation/loot/pvp imports `./_schema_helpers.js` → `../_schema_helpers.js`.
- Vendor `src/_shared/codepoint_compare.ts` into `cmd-engine/output/economy/_shared/` for cmd-engine, and once into `cmd-item/output/legacy/_shared/` for cmd-item.
- Port `src/logic/{types,soft_cap,rng}.ts` to `cmd-engine/output/core/`.
- Patch cross-CMD imports in NEW (cmd-db → `../../../cmd-engine/output/economy/*`, cmd-engine → `../../../../cmd-item/output/legacy/*`).
- **Disruption:** NEW file edits to patch import paths. **OLD untouched.**
- **Effort:** 1 day.

### Option B — Add tsconfig.json with `paths` aliases at repo root
- Define `@svtk/economy` → `cmd-engine/output/economy`, `@svtk/itemization` → `cmd-item/output/legacy`, etc.
- Rewrite NEW imports `'../economy/X.js'` → `'@svtk/economy/X.js'`.
- **Disruption:** Heavier import rewrite + tsconfig dependency. **OLD untouched.**
- **Effort:** 1.5 days.

### Option C — Keep migration as-is, accept NEW is not compilable until 13-CMD wire phase
- Leave broken imports in place; document for Phase 14 Week 2-3 wire pass.
- **Disruption:** Zero now; postpones fix to Week 2.
- **Effort:** 0 today; estimated 1 day Week 2.
- **Risk:** Other CMD pulls from cmd-db/cmd-item/cmd-engine may hit broken imports and re-raise this alert.

**Em (CMD2) autonomous pick:** **Option A**, schedule it for Week 2 day 1 (concurrent with NEW R44 wrapper impl). Doc alone today.

---

## 7. JSON + SQL sanity (Task 11)

| File | Status |
|------|--------|
| `cmd-item/data/affix_pool.json` | ✅ valid JSON |
| `cmd-item/data/itemization_constants.json` | ✅ valid JSON |
| `cmd-item/data/items.json` | ✅ valid JSON |
| `cmd-item/data/loot_tables.json` | ✅ valid JSON |
| `cmd-item/data/sets.json` | ✅ valid JSON |
| `cmd-item/data/slot_cap.json` | ✅ valid JSON |
| `cmd-item/data/stat_budget.json` | ✅ valid JSON |
| `cmd-engine/data/economy/economy_constants.json` | ✅ valid JSON |
| `cmd-engine/data/economy/pvp_normalization.json` | ✅ valid JSON |
| `cmd-db/migrations/001_init.sql` | ✅ SQL syntax valid (PostgreSQL DDL) |
| `cmd-db/migrations/001_init.down.sql` | ✅ |
| `cmd-db/migrations/002_progression_snapshots.sql` | ✅ |
| `cmd-db/migrations/002_progression_snapshots.down.sql` | ✅ |

(All copied byte-identical from OLD; OLD was Phase 11B frozen + Phase 12 test-verified.)

---

## 8. Revised honest verdict

| Dimension | Score |
|-----------|-------|
| File-copy completeness vs AUTO_START globs | 100% |
| OLD test baseline preserved | 100% (1095/1095) |
| NEW standalone compilability | **0%** (18 files broken imports, 5 peer files missing) |
| R44 wrapper compliance | ~30% (per `r44_compliance.md`) |
| **Aggregate Phase 14 Week 1 readiness for downstream consumers** | **~50%** |

**Ship Week 2 plan to cmd-lead:**
1. Day 1: Option A vendor + path patches (1 day, fixes 18 import errors)
2. Day 2-4: NEW R44 anti_dupe.ts + 003_anti_dupe_schema.sql (~600 LOC)
3. Day 5: R68 compute_state_checksum
4. Day 6-7: 12-item self-audit + integration tests

**END MIGRATION_INTEGRITY_AUDIT.md**

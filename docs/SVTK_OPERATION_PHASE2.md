# 🚀 SVTK OPERATION PHASE 2 — WORLD SKELETON

> Sau GATE 1 PASS → kickoff PHASE 2 (NPC + MAP)

---

## 📋 Mục tiêu PHASE 2

```
TARGET:
  NPC count ≥ 10000 (TSO 7817)
  MAP count ≥ 8500 (TSO 7047)
  0 orphan sceneId
  0 overcrowd map (density theo biome)
```

---

## 🏗️ Vận hành 2 Team + CMD5

```
Tab 1 — CMD5 LEAD            (chạy nền)
Tab 2 — Team A: CMD_NPC      (R71 pipeline: 438 → 10000)
Tab 3 — Team B: CMD_MAP      (R71 pipeline: existing → 8500)
Tab 4 — CMD_QA_CONTENT       (verify cultural lock + count + cross-ref)
```

---

## 🔄 R71 Pipeline thực hiện (Phase 2)

### Team A — CMD_NPC

```
1. Load existing: cmd-npc/existing/NPC_438.jsonl
2. Detect bugs: tier imbalance, type missing, era fallback
3. Fix triệt để (4 bug đã phát hiện):
   - fix_npc_tier_from_level()
   - fix_npc_type_distribution()
   - fix_npc_era_resolve()
   - recompute_stats()
4. Extend 438 → 10000 với balance:
   - Tier 0-9 theo NPC_TIER_TARGET
   - 10 type theo NPC_TYPE_TARGET
   - 11 era theo NPC_ERA_TARGET
   - 6 hệ random distribution
5. Save: cmd-npc/output/registry/npc_full.jsonl
6. Push completion → cmd-lead/completions/
```

### Team B — CMD_MAP

```
1. Load existing map registry (từ TS Online decode)
2. Verify mapId_at_0x00 unique
3. Assign biome theo position/era:
   - capital_inner, capital, town, village, forest,
     mountain, river, plain, sea, dungeon
4. Apply NPC density per biome (R75):
   - capital: 40-80 NPC/map
   - town: 15-30
   - village: 5-15
   - forest: 10-25
   - dungeon: 15-40
5. Extend existing → 8500 map
6. Save: cmd-map/output/registry/map_full.jsonl
```

---

## 🔗 CROSS-REFERENCE (NPC↔MAP)

```python
# Sau khi 2 team xong:
allocate_npcs_to_maps(npcs, maps)  # R75 deterministic seed=42
verify_npc_map_allocation()        # detect orphan + overcrowd
```

CMD5 LEAD chạy verify này tự động sau khi cả 2 team push completion.

---

## 🚦 GATE 2 — KIỂM SOÁT

```
✓ NPC count ≥ 10000
✓ MAP count ≥ 8500
✓ Mọi NPC.sceneId tồn tại trong MAP
✓ Density mỗi map trong range biome
✓ 0 NPC ở position invalid (x<8, y<8, x>312, y>232)
✓ Min spacing 8 tile giữa NPC trong cùng map
✓ Cultural lock: 0 Tam Quốc + 0 CJK
```

Nếu FAIL → CMD5 escalate alert HIGH → assign fix.

---

## ⏱️ Thời gian dự kiến

```
Team A NPC:   3-5 ngày
Team B MAP:   3-5 ngày (song song với Team A)
QA verify:    1-2 ngày
NPC→MAP allocation: 1 ngày
─────────────────────
TỔNG PHASE 2: 5-8 ngày
```

---

## 📊 Dashboard tracking

```json
{
  "phase": 2,
  "gate_status": "IN_PROGRESS",
  "team_a_npc": {
    "loaded_existing": 438,
    "fixed_bugs": 7,
    "extended_to": 10000,
    "last_heartbeat": "...",
    "alerts": []
  },
  "team_b_map": {
    "loaded_existing": "...",
    "extended_to": 8500,
    "last_heartbeat": "...",
    "alerts": []
  },
  "cross_ref": {
    "allocation_complete": false,
    "orphan_count": 0,
    "overcrowd_count": 0
  }
}
```

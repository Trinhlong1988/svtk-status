# 🚀 SVTK OPERATION PHASE 5 — ART + QA + LAUNCH

> Sau GATE 4 PASS → kickoff PHASE 5 cuối cùng

---

## 📋 Mục tiêu PHASE 5

```
TARGET:
  SPRITE: 158 template × recolor cho 10000 NPC
  ICON: cho 1500 item + 306 skill
  AUDIO: BGM 10 era + SFX ~200 file
  4 QA CMD: full E2E test bot chơi 1h không crash
  LAUNCH READY: deploy local + smoke test
```

---

## 🏗️ Vận hành 3 Team + CMD5

```
Tab 1 — CMD5 LEAD          (chạy nền, orchestrate cuối)
Tab 2 — Team A: CMD_SPRITE (158 template × recolor)
Tab 3 — Team B: CMD_ICON   (item + skill icons)
Tab 4 — Team C: CMD_AUDIO  (BGM + SFX)
Tab 5 — CMD_QA_ART         (verify sprite quality)
Tab 6 — CMD_QA_FULL        (E2E bot test)
```

---

## 🔄 Pipelines PHASE 5

### Team A — CMD_SPRITE

```
Asset constraints (memory rule):
- PNG indexed 16 màu ~30KB/file
- 8 direction × 4 frame walk = 32 sprite/NPC template
- 158 base template × recolor palette → cover 10000 NPC
- Total: 158 × 32 = 5056 base sprite + ~3000 recolor variant
- Total disk: ~250 MB (cap)

1. Generate 158 base template (Stable Diffusion local PC + LoRA train Việt)
2. Recolor algorithm:
   - palette_seed → hash to 6 color swatches
   - replace indexed colors in 16-color palette
3. CLIP score ≥ 0.85 (style consistency)
4. Save: cmd-sprite/output/sprites/*.png
```

### Team B — CMD_ICON

```
Asset constraints:
- PNG indexed 32×32 hoặc 64×64
- ~5 KB/icon
- Total: 1500 item + 306 skill = ~1800 icon × 5 KB = 9 MB

1. Icon style match era (Lý/Trần/Lê/...)
2. 6 hệ color theme cho skill icon:
   - Kim: vàng/bạc
   - Mộc: xanh lá
   - Thủy: xanh dương
   - Hỏa: đỏ
   - Thổ: nâu
   - Tâm: tím
3. Save: cmd-icon/output/icons/*.png
```

### Team C — CMD_AUDIO

```
Asset constraints:
- BGM OGG mono 64 kbps ~500 KB/track
- SFX OGG mono 32 kbps ~30 KB/clip
- Total: 50 BGM + 200 SFX = 25 MB + 6 MB = 31 MB

1. BGM theo era + biome (10 era × 5 biome = 50 BGM)
2. SFX:
   - Combat: 50 (sword/skill/hit/crit/dodge)
   - UI: 30
   - Footstep: 20 (per biome)
   - Voice: 100 (NPC greeting)
3. Save: cmd-audio/output/audio/*.ogg
```

---

## 🧪 4 QA CMD CHẠY SONG SONG TỪ ĐẦU PHASE 5

```
CMD_QA_CONTENT:  Re-verify mọi content còn lại sau update
CMD_QA_ART:      Verify sprite 8 hướng × 4 frame + CLIP score ≥ 0.85
CMD_QA_CORE:     Verify DB consistency + damage formula edge case
CMD_QA_FULL:     Bot chơi end-to-end:
                  - Login → tutorial → main quest 1
                  - Combat boss tier 0-3
                  - Trade item (anti-dupe verify)
                  - PvP duel
                  - Save/load
                  - 1h liên tục KHÔNG crash
```

---

## 🚦 GATE 5 — LAUNCH CRITERIA

```
✓ SPRITE: 158 template × 32 frame × recolor scheme
✓ ICON: 1800 icon ready
✓ AUDIO: 50 BGM + 200 SFX
✓ Bot QA tour 1h KHÔNG crash, KHÔNG dupe phát hiện
✓ DB load 10000 NPC + 1500 item + 1200 boss < 5 giây
✓ Memory footprint < 2 GB (PC dev 64 GB)
✓ Total game asset < 1 GB (target memory rule)
✓ 0 alerts pending trên cmd-lead/dashboard
✓ 0 frozen CMD trong cmd-lead/escalations/
```

---

## 🎯 LAUNCH DAY

```
1. Tag GitHub release v1.0.0
2. Deploy local PostgreSQL + Redis + game server
3. Anh play test 30 phút
4. Báo bug realtime → CMD5 dispatch fix
5. Stabilize 3 ngày → public launch
```

---

## ⏱️ Thời gian dự kiến

```
Team A SPRITE:    7-8 ngày
Team B ICON:      3-4 ngày
Team C AUDIO:     3-4 ngày
4 QA verify:      5-7 ngày
Launch prep:      2-3 ngày
─────────────────────
TỔNG PHASE 5: 10-14 ngày
```

---

## 📊 8-tuần roadmap summary

```
Week 1-2:  Phase 1 BACKEND   ─┐
Week 2-3:  Phase 2 WORLD     ─┤  Foundation đã có
Week 3-4:  Phase 3 LOGIC     ─┤  Pipeline đã code
Week 4-6:  Phase 4 CONTENT   ─┤  CMD prompts ready
Week 6-8:  Phase 5 ART+QA    ─┘  CMD5 giám sát
                              ↓
                         🚀 LAUNCH
```

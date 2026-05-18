# 🚀 SVTK OPERATION PLAN — Phase 1 KICKOFF

> Vận hành Backend Team A + B + CMD5 giám sát.

---

## ⏰ HÔM NAY — KHỞI ĐỘNG PHASE 1

### Bước 1: Anh setup repo (5 phút)
```bash
git clone https://github.com/Trinhlong1988/svtk-status
cd svtk-status
mkdir -p foundation cmd-lead cmd-db cmd-engine cmd-qa-core
mkdir -p cmd-lead/{alerts,completions,heartbeats,inbox-recheck,dashboard}
```

### Bước 2: Push Foundation + 3 CMD đầu (10 phút)
```bash
cp SVTK_FOUNDATION_v2.8.0.md foundation/foundation.md
cp CMD5_LEAD_v2.1.md cmd-lead/cmd.md
cp CMD_DB_v2.4.2_patch.md cmd-db/cmd.md
cp CMD_ENGINE_v1.0.md cmd-engine/cmd.md
cp CMD_QA_CORE_v1.0.md cmd-qa-core/cmd.md
git add . && git commit -m "Phase 1 kickoff: Foundation v2.8.0 + 4 CMD"
git push origin main
```

### Bước 3: Mở 4 tab Claude Code (15 phút)
```
Tab 1 (CMD5 LEAD)    → paste cmd-lead/cmd.md       → chạy nền giám sát
Tab 2 (Team A — DB)  → paste cmd-db/cmd.md         → build PostgreSQL schema
Tab 3 (Team B — ENG) → paste cmd-engine/cmd.md     → build combat engine
Tab 4 (QA Core)      → paste cmd-qa-core/cmd.md    → verify continuous
```

### Bước 4: Anh chỉ giám sát (8 tuần)
- KHÔNG quyết hộ Team
- KHÔNG hỏi 1/2/3 a/b/c
- CMD5 LEAD tự assign fix
- Worker tự apply
- QA tự verify
- Anh chỉ check `cmd-lead/dashboard/status.json` mỗi sáng

---

## 📊 DASHBOARD MONITORING

Mỗi sáng anh check 1 file: `cmd-lead/dashboard/status.json`

```json
{
  "phase": 1,
  "gate_status": "IN_PROGRESS",
  "team_a_db": {
    "progress": 60,
    "last_heartbeat": "2026-05-20T08:00:00Z",
    "alerts_pending": 0
  },
  "team_b_engine": {
    "progress": 45,
    "last_heartbeat": "2026-05-20T08:00:00Z",
    "alerts_pending": 1
  },
  "qa_verdicts": [
    {"cmd": "cmd-db", "verdict": "PASS", "ts": "..."},
    {"cmd": "cmd-engine", "verdict": "NEED_REVIEW", "issue": "damage formula edge case"}
  ],
  "next_gate": "GATE_1",
  "eta_to_gate": "3 days"
}
```

---

## 🚨 KHI GATE FAIL

```
GATE 1 FAIL → CMD5 push HIGH alert "GATE_1_FAIL"
            → CMD5 assign fix theo issue chi tiết
            → Worker apply trong cycle tiếp theo
            → QA re-verify
            → Anh chỉ approve unblock nếu CMD5 escalate 3 lần
```

---

## ⚠️ Anh CHỈ can thiệp khi

```
✓ CMD5 escalate "FROZEN — same issue 3+ re-flag"
✓ GATE FAIL 2 phase liên tiếp
✓ External blocker (hết quota GitHub, network down)
✗ KHÔNG can thiệp khi worker đang debug bình thường
✗ KHÔNG quyết hộ "phương án A/B/C"
✗ KHÔNG override CMD5 verdict
```

---

## 🎯 KỲ VỌNG SAU PHASE 1 (2 tuần)

```
✓ DB schema 9 table deployed PostgreSQL local
✓ ENGINE damage formula PASS 3000 mock tests
✓ Char class scaling 1-120 verified
✓ Element wheel 5 ngũ hành verified
✓ NPC class hierarchy 6 mức verified
✓ GATE 1 → unlock Phase 2 (NPC + MAP)
```

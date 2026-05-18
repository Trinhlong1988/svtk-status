# SVTK DASHBOARD 20260519-000126 (cycle 28 — bug-hunt wave)

**Foundation:** v2.8.0 ✓ | **Completions resolved:** 49

## CMD2 bug hunt Day 3 (3 bugs)
- R3 **HIGH** search_path race condition — fire-and-forget → server-side options pinned
- R2/R4 MED resource leak on mid-migration failure → try/catch + DROP SCHEMA CASCADE
- R5 LOW collision entropy too low

## CMD4 Tuần 4 deep audit R26-R35 (3 bugs)
- bug#37 LOW seq range ≤ MAX_SAFE_INTEGER precision check
- bug#38 **HIGH** ACK/NACK timestamp anti-replay (60s MAX_ACK_AGE_MS)
- bug#39 **CRIT R69.2** — NEW ordered_receiver.ts (buffer-until-predecessor-arrives semantics). Out-of-order packets BUFFERED + drained khi gap fills, không drop
- Tests 122/122 | GATE 1 expanded 29→**32/32 (100%)** | tsc 0

## Cumulative bug scoreboard Phase 14
| CMD | Total bugs fixed |
|---|---|
| CMD1 | 21 (4 rounds bughunt) |
| CMD2 | 18 imports + DATA_ROOT + 3 hunt + 3 day3 = ~6 hunt total |
| CMD3 | 75 level inv + B2 + 1 (commit cddfa3f) |
| CMD4 | 27 (25-round) + 3 (Tuần 4 R26-R35) = **30** patched |

## Content team
- vẫn chưa heartbeat

## Inbox FULLY CLEARED | Pending fixes EMPTY ✓

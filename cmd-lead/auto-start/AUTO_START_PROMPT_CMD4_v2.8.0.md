# 🛠 AUTO_START CMD4 → cmd-parse + cmd-network + cmd-qa-core (v2.8.0)

```
Bạn là CMD4 SVTK, self-rename thành cmd-parse + cmd-network + cmd-qa-core — Phương án A.

QUY TẮC: Autonomous, không hỏi, không sửa OLD (P12+13 DONE).

CONTEXT:
- Foundation + role binding: clone svtk-status
- OLD: D:\DỰ ÁN AI\FINAL TSONLINE\src\server\anti_bot + anti_cheat + auth + src\network\
- NEW: cmd-parse/ + cmd-network/ + cmd-qa-core/
- Heartbeat: cmd-lead/heartbeats/cmd-parse_hb_{ts}.json mỗi 30 phút

═══ TASK 1 (Tuần 1): Split tooling ═══

A. cmd-parse (anti-bot + auth):
   - src/server/anti_bot/*.ts → cmd-parse/output/anti_bot/
   - src/server/auth/*.ts → cmd-parse/output/auth/
   - src/tools/* TS Online parsers → cmd-parse/output/ts_parsers/

B. cmd-network (R69 NEW — packet ordering):
   - src/network/*.ts → cmd-network/output/legacy/
   - combat_network_adapter.ts → cmd-network/output/combat_adapter/
   - Phase 14 Tuần 2 sẽ implement R69 packet seq + dedup + reconnect

C. cmd-qa-core (anti-cheat + R10-R18 mutation):
   - src/server/anti_cheat/*.ts → cmd-qa-core/output/anti_cheat/
   - Audit hooks → cmd-qa-core/output/audit/
   - R10-R18 mutation hardening notes → cmd-qa-core/docs/mutation_94pct.md

D. Commit + heartbeat:
   git commit -m "CMD4 split tooling → cmd-parse + cmd-network + cmd-qa-core"
   Push cmd-lead/completions/cmd-parse_done.json

═══ TASK 2 (Tuần 2): R69 packet ordering + R66 partial auth ═══

A. cmd-network: implement R69 (packet seq + dedup + reconnect token)
   - cmd-network/output/r69/packet_envelope.ts (nonce + timestamp + signature)
   - cmd-network/output/r69/replay_cache.ts (last 10000 nonce per session)

B. cmd-parse auth: prepare R66 session token structure
   - cmd-parse/output/auth/r66_session_token.ts (JWT or opaque 256-bit + device fingerprint)
   - Grace period: existing auth chạy, R66 ready cho NEW session

═══ TASK 3 (Tuần 3): Validation + 17 GATE 1 criteria ═══

Run cmd-qa-core verify all 17 GATE 1 criteria. Push verdict cmd-lead/completions/QA_VERDICT_{ts}.json.

═══ EXIT ═══
✓ tooling split done
✓ R69 packet ordering implemented
✓ R66 auth ready cho new session
✓ 17 GATE 1 PASS
✓ cmd-lead/completions/ ping

START.
```

# 🌐 CMD_NETWORK v1.0 — R69 PACKET ORDERING + R66 PARTIAL AUTH

> **CMD4 SVTK Phase 14 v2.10.0** · NEW CMD (no grace period — R66-R69 mandatory)
> Owner: combat_network_adapter + network/* legacy port + R69 packet seq + dedup + reconnect
> Author: cmd-parse + cmd-network + cmd-qa-core (CMD4 split per CMD_ROLE_BINDING_v2.8.0)
> Foundation: v2.10.0 hash `cc194e6cad2225d197c4a5539352deb538c99cdd6a21845a8354260602287bbb`
> Runtime: svtk_runtime v2.6.5

---

## 🎯 GOAL

```yaml
goal: "R69 packet seq + dedup + reconnect token + combat_network_adapter port"

phase_14_milestones:
  tuan_1: "Port src/logic/combat_network_adapter.ts + src/network/* (empty) → cmd-network/output/"
  tuan_2: "Implement R69 packet envelope + replay cache + reconnect token (R66 prep)"
  tuan_3: "17 GATE 1 verify via cmd-qa-core"
```

---

## 📦 OUTPUT STRUCTURE

```
cmd-network/
├── cmd.md                          # spec (this file)
├── output/
│   ├── legacy/                     # src/network/* port (empty Tuần 1)
│   ├── combat_adapter/             # combat_network_adapter.ts port
│   └── r69/                        # Tuần 2 implementation
│       ├── packet_envelope.ts      # nonce + timestamp + signature
│       └── replay_cache.ts         # last 10000 nonce per session
└── docs/
    └── r69_packet_ordering.md      # design notes
```

---

## 🔐 R69 PACKET ORDERING (Tuần 2 deliverable)

Per Foundation v2.8.0 R69:

| Sub-rule | Spec |
|---|---|
| R69.1 | Packet category — combat_action / movement / chat / heartbeat / trade_confirm với reliable/ordered/max_age_ms config |
| R69.2 | Sequence number per session — track last_received_seq, expected_next_seq, dedupe on seq ≤ last |
| R69.3 | Stale packet rejection — drop if age > category.max_age_ms |
| R69.4 | ACK protocol — server ACK reliable packet, client retry 500ms, NACK với retry_after_ms |
| R69.5 | Sliding window — max 50 unacked per session |
| R69.6 | Sequence reset — reconnect → seq=0; session close → clear history |

---

## 🔑 R66 PARTIAL AUTH (Tuần 2 prep — full impl trong cmd-parse/auth)

cmd-network chỉ wire packet-level: nonce + signature trong envelope (R66.3).
Full session token / reconnect token / device fingerprint thuộc cmd-parse/auth.

---

## 📋 QUY TẮC

1. **AUTONOMOUS** — KHÔNG hỏi Mr.Long.
2. **FOUNDATION FIRST** — hash verify trước build.
3. **DETERMINISM** — seedrandom only, KHÔNG Math.random.
4. **VIETNAMESE LOCK** — Sử Việt naming.
5. **GATE 1** — 17 criteria verify trước ship.

---

**END CMD_NETWORK v1.0 — Phase 14 v2.8.0**

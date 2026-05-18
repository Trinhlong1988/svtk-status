# cmd-parse/output/ts_parsers

**Target output (per `cmd-parse/cmd.md` v6 STRICT VERIFIED):**

| File | Source | Schema |
|---|---|---|
| `scripts/*.json` | TS Online `.eve` decoded body | bytecode VM parse |
| `eve-crossrefs.json` | Pre-filtered crossref | 3,835 entries |
| `npc-class-code.json` | `npc_id_at_0x10` | 158 unique class codes |

**Pipeline:** Python autonomous parser (NOT TypeScript). Inputs from `D:\...\decoded_all\` (eve / npc / talk / mark / scene subfolders).

**Status (Phase 14 Tuần 1):** placeholder. Python parser run Tuần 2.

**Gap correction (2026-05-18):** 32 SVTK Phase 12 runtime tools (forensic / audit / registry / replay / deterministic CI) đã được move sang `cmd-qa-core/output/audit/` — đúng semantic (audit hooks).

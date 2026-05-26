# 🚫 POLICY — NO DESKTOP/DOWNLOADS PATHS

> **Constitution-level policy.** Mọi CMD (kể cả LEAD) PHẢI tuân.
> **Version:** 1.0.0 — 2026-05-26 (LEAD cycle 128)
> **Trigger:** Mr.Long flag CMD_PLACE + CMD_MAP để file rải rác Desktop sau session — chữa triệu chứng không đủ, cần fix nguyên nhân ở scaffolding.

---

## TLDR

**KHÔNG được ghi đường dẫn `Desktop/` hoặc `Downloads/` (Windows: `C:\Users\*\Desktop`, `C:\Users\*\Downloads`) vào BẤT KỲ file `.py`, `.toml`, `.yaml/.yml`, `.json`, `.ts`, `.mjs`, `.js`, `.mjs`, `.sh`, `.ps1` nào được commit.**

→ Hooks/CI sẽ REJECT commit/PR vi phạm.

---

## DEFAULT WORKSPACE LAYOUT (mỗi CMD)

```
cmd-<name>/
├── cmd.md                  ← brief của CMD (operational contract)
├── scripts/
│   ├── <cmd_name>.py       ← main builder (1 file, version trong constant CMD_VERSION)
│   ├── daemon.py           ← production loop wrapper (nếu có)
│   ├── README.md           ← cách start/stop, env vars
│   └── audit/              ← audit scripts (mutation, evidence, deep)
│       ├── *.py
│       ├── pyproject.toml
│       ├── cosmic_*.toml
│       └── mutmut_target/
├── output/                 ← build artifacts
│   ├── registry/           ← canonical data (jsonl/sql)
│   ├── audit/              ← audit reports
│   │   └── findings/       ← *.json reports
│   └── build_manifest.json
├── logs/                   ← runtime logs (.gitignored via *.log)
├── inbox/                  ← cross-CMD messages
└── status/                 ← cycle status reports
```

---

## REGEX REJECT PATTERNS

Bất kỳ regex nào dưới đây match trong staged diff → commit/PR REJECTED:

```
C:[\\/]+Users[\\/]+[^\\/]+[\\/]+(Desktop|Downloads)
[\\/](Desktop|Downloads)[\\/]
^Desktop[\\/]
^Downloads[\\/]
```

**Exempt files** (allow Desktop mention trong docs):
- `*.md` (markdown documentation)
- `cmd-lead/POLICY_NO_DESKTOP.md` (this file, contains examples)
- `docs/**`
- `cmd-*/status/**` (historical status reports — frozen)

---

## PATH PATTERN (PYTHON)

**❌ KHÔNG:**
```python
REPO_DIR = Path(r"C:\Users\Administrator\Desktop\22.5\CMD_BOSS_WORK\svtk-status")
OUTPUT_DIR = Path("C:/Users/Administrator/Desktop/cmd-place-output")
SCRIPT = Path(r"C:\Users\Administrator\Downloads\CMD_PLACE_v2.3.0 (2).py")
```

**✅ ĐÚNG (relative to `__file__`):**
```python
HERE = Path(__file__).resolve()
REPO_DIR = HERE.parents[2]                  # cmd-<x>/scripts/file.py -> repo root
SCRIPT = HERE.parent / "cmd_<x>.py"          # same dir as wrapper
OUTPUT_DIR = REPO_DIR / "cmd-<x>" / "output"
LOG_DIR = REPO_DIR / "cmd-<x>" / "logs"
```

**✅ ĐÚNG (env override cho infra flexibility):**
```python
REPO_DIR = Path(os.getenv("SVTK_REPO_DIR", str(default_repo_dir)))
```

---

## DAEMON PATTERN

Daemon = long-running loop. **PHẢI** sống trong `cmd-<name>/scripts/daemon.py`.

KHÔNG được:
- Sống ở `Desktop/` hoặc `~/`
- Hard-code clone path khác (`Desktop/22.5/CMD_BOSS_WORK/svtk-status` etc.)
- Output ra ngoài `cmd-<name>/output/`

PHẢI:
- Path tương đối qua `Path(__file__).resolve().parents[N]`
- README.md kèm theo (cách start/stop/env)
- Log ra `cmd-<name>/logs/` (gitignored)
- Graceful shutdown (SIGTERM + SIGINT handler)

---

## SCAFFOLDING CHECKLIST cho session CMD mới

Khi anh paste brief cho session CMD mới, em (CMD bot) PHẢI:

1. ✅ Đọc `cmd-lead/POLICY_NO_DESKTOP.md`
2. ✅ Verify brief KHÔNG ghi `Desktop/` hoặc `Downloads/` làm workspace
3. ✅ Scaffold workspace ở `cmd-<name>/scripts/` của repo clone (không Desktop)
4. ✅ Output ra `cmd-<name>/output/`
5. ✅ Logs ra `cmd-<name>/logs/`
6. ✅ Nếu brief có hard-code Desktop path → STOP, alert anh để sửa brief trước

---

## ENFORCEMENT

3 lớp bảo vệ:

### Lớp 1 — Brief level (preventive)
Mỗi `cmd-*/cmd.md` có section "## DEFAULT PATHS" reference policy này (LEAD cycle 128 bulk patch).

### Lớp 2 — Local hook (detective, fast feedback)
`.githooks/pre-commit` chạy regex check. Setup 1 lần per clone:
```bash
git config core.hooksPath .githooks
```

### Lớp 3 — CI workflow (gatekeeper, không bypass)
`.github/workflows/no-desktop-paths.yml` chạy trên mọi PR/push tới main.
Nếu match → workflow FAIL, merge BLOCKED (require status check pass).

---

## EXCEPTIONS

Trường hợp BUỘC dùng Desktop/Downloads (vd: ingestion từ file user drop):

1. Ghi rõ lý do trong commit message
2. Path qua **env var có default an toàn**, KHÔNG hard-code:
   ```python
   USER_INPUT_DIR = Path(os.getenv("SVTK_USER_INPUT", str(Path.home() / "ingestion")))
   ```
3. Add file vào exempt list `.githooks/pre-commit-allowlist` (chờ LEAD approve)

---

## HISTORY

- 2026-05-26 LEAD cycle 128 — POLICY ra đời sau khi fix CMD_PLACE (cycle 125-127) + CMD_MAP (cycle 126) Desktop anti-pattern. Mr.Long flag root cause là scaffolding, không phải session.

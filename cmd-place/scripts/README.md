# CMD_PLACE scripts

## Files

- `cmd_place_v2.3.1.py` — main builder (autonomous, 10000 map + 64 shard, 18-round audit bug fixes)
- `daemon.py` — production loop wrapper (60s interval, foundation verify + main_loop)
- `README.md` — file này

## Foundation

Pinned to `SVTK_FOUNDATION_v2.10.0.md` (sha256 `cc194e6cad2225d197c4a5539352deb538c99cdd6a21845a8354260602287bbb`).

Builder verify hash trước mỗi cycle — fail = exit 99 (LEAD scope).

## Start daemon

```bash
cd D:/svtk-status
python cmd-place/scripts/daemon.py >> cmd-place/logs/daemon.log 2>&1 &
echo "Daemon PID: $!"
```

Hoặc background qua `nohup`/`pythonw` tùy platform.

## Stop daemon

```bash
# tìm pid
ps -W | grep -i python | grep cmd-place
# hoặc dùng pidfile nếu có (chưa implement)
kill <PID>
```

Daemon respect `SIGTERM` + `SIGINT` → graceful shutdown.

## Env overrides

| Var | Default | Mô tả |
|---|---|---|
| `SVTK_DET_MODE` | `sampling` | `full` = determinism check toàn bộ (nặng CPU) |
| `SVTK_REPO_URL` | `https://github.com/Trinhlong1988/svtk-status.git` | Repo origin cho clone/push |

## Logs

`cmd-place/logs/*.log` — gitignored via `*.log` toàn repo.

Format: `[DAEMON] ...` prefix cho dòng wrapper, `[PLACE] ...` cho builder.

## Outputs

`cmd-place/output/`:
- `registry/` — `map_registry.jsonl`, `region.jsonl` (+ `.meta`, `.sha256`)
- `audit/` — audit reports
- `build_manifest.json` — manifest mỗi build cycle

## Lịch sử

- 2026-05-26 — chuẩn hóa từ Desktop wrapper (`Desktop/cmd_place_daemon.py` + `Downloads/CMD_PLACE_v2.3.0 (2).py`) vào repo. Anti-pattern cũ: hard-code Desktop/Downloads path, clone riêng trong `Desktop/22.5/CMD_BOSS_WORK/svtk-status`.
- v2.3.1 — fix 4 bug ẩn (race ensure_place_lib, defensive self_validate, skip-push-when-no-change, CRLF cross-platform LF write).
- v2.3.0 — initial 10000 map extension (từ 7047, fix orphan NPC sceneId).

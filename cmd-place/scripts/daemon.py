"""CMD_PLACE production daemon — loop forever, poll inbox 60s.

Repo-local wrapper. KHONG hard-code Desktop/Downloads.

Run:
    cd D:/svtk-status
    python cmd-place/scripts/daemon.py >> cmd-place/logs/daemon.log 2>&1

Stop: kill PID hoac Ctrl+C. Heartbeat ghi vao OUTPUT_DIR/.build.lock.d/heartbeat
(stale 180s -> reclaim tu dong).

Env overrides (optional):
    SVTK_DET_MODE=full      # default 'sampling' (nhe CPU)
    SVTK_REPO_URL=...       # default https://github.com/Trinhlong1988/svtk-status.git
"""
import sys, os, signal, importlib.util
from pathlib import Path

HERE = Path(__file__).resolve()
SCRIPTS_DIR = HERE.parent
REPO_DIR = SCRIPTS_DIR.parents[1]
SOURCE = SCRIPTS_DIR / "cmd_place_v2.3.1.py"
LOG_DIR = REPO_DIR / "cmd-place" / "logs"
OUTPUT_DIR = REPO_DIR / "cmd-place" / "output"

LOG_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

if not SOURCE.exists():
    sys.stderr.write(f"[DAEMON] SOURCE not found: {SOURCE}\n")
    sys.exit(2)

os.environ.setdefault("SVTK_DET_MODE", "sampling")

spec = importlib.util.spec_from_file_location("cmd_place", SOURCE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

mod.REPO_DIR = REPO_DIR
mod.OUTPUT_DIR = OUTPUT_DIR


def shutdown(signum, frame):
    print(f"[DAEMON] SHUTDOWN signal={signum}", flush=True)
    sys.exit(0)


signal.signal(signal.SIGINT, shutdown)
if hasattr(signal, "SIGTERM"):
    signal.signal(signal.SIGTERM, shutdown)

print(f"[DAEMON] BOOT CMD={mod.CMD_NAME} v{mod.CMD_VERSION} pid={os.getpid()}", flush=True)
print(f"[DAEMON] REPO_DIR={mod.REPO_DIR}", flush=True)
print(f"[DAEMON] OUTPUT_DIR={mod.OUTPUT_DIR}", flush=True)
print(f"[DAEMON] FOUNDATION_FILE={mod.FOUNDATION_FILE}", flush=True)
print(f"[DAEMON] det_mode={os.environ['SVTK_DET_MODE']}, loop_interval={mod.LOOP_INTERVAL_SEC}s", flush=True)

try:
    mod.verify_foundation()
    mod.cultural_lock_ok = mod.ensure_place_lib()
    print("[DAEMON] foundation + place_lib OK -> main_loop()", flush=True)
    mod.main_loop()
except KeyboardInterrupt:
    print("[DAEMON] KeyboardInterrupt", flush=True)
    sys.exit(0)
except Exception as e:
    import traceback
    print(f"[DAEMON] FATAL: {e}", flush=True)
    traceback.print_exc()
    sys.exit(2)

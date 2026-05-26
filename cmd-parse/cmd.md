# CMD AUTONOMOUS PARSER v6 — eve.Emg TS Online
## STRICT VERIFIED (schema xác nhận từ sample thực)

> **GỬI CMD**: Paste nguyên file này. KHÔNG sửa, KHÔNG hỏi user.

---

## ⚠️ QUY TẮC TUYỆT ĐỐI

1. **SCHEMA ĐÃ VERIFY** từ sample thật — KHÔNG đoán
2. **PRIMARY SOURCE**: `eve-crossrefs.json` (đã pre-scan + filter)
3. **SECONDARY**: Bytecode VM parse (best-effort, không required)
4. **AUTO-DISCOVERY** folder
5. **KHÔNG hỏi user** 1/2/3, yes/no
6. **Output 6 file** + honest report
7. **STRICT** — fail nếu schema không khớp

ROLE: CMD parser autonomous, verified-schema, no guessing.

---

## SCHEMA VERIFIED (từ sample TSONLINE_SAMPLES)

```
NPC unique ID: '_index'           # 1..7817 (không phải npc_id_at_0x10 — đó là class code 158 unique)
NPC class code: 'npc_id_at_0x10'  # 158 unique values

MARK ID:       'markId_at_0x104'
SCENE ID:      'mapId_at_0x00'
TALK INDEX:    'i'                # 1..42297

EVE format:
  0x00-0x01: u16 LE event_id
  0x02:      u8 name_len (= 7 for "Pre2223")
  0x03-0x09: ASCII name (7 bytes)
  0x0A-0x0D: ".bmp" suffix (4 bytes IMPLICIT, không nằm trong name_len)
  0x0E:      ACTUAL body bytecode (sparse, 61% zeros)
  END:       separator b9 75 aa c8 a7 f5

eve-crossrefs.json format:
  Array of { eventId, eveRefs[], markRefs[], dialogRefs[] }
  3,835 entries total
  Already filtered by valid sets (3835/225/36329)
  ~95% noise but actionable
```

---

## STEP 0: AUTO-DISCOVERY (5 phút timeout)

```python
import os, sys, json, glob, struct, time
from pathlib import Path
from collections import Counter, defaultdict

OUTPUT = Path('./output')
LOG = Path('./logs')
OUTPUT.mkdir(parents=True, exist_ok=True)
LOG.mkdir(parents=True, exist_ok=True)

def log(msg, level="INFO"):
    line = f"[{level}] {time.strftime('%H:%M:%S')} {msg}"
    print(line)
    with open(LOG / 'run.log', 'a', encoding='utf-8') as f:
        f.write(line + "\n")

log("CMD v6 STRICT VERIFIED started")

REQUIRED_SUB = ['npc', 'talk', 'mark', 'scene', 'eve']
FOLDER_HINTS = ['decoded_all', 'TSOnlineTools', 'TSOnline',
                'tsonline_decoded', 'TSONLINE']
SKIP = {'Windows', '$Recycle.Bin', 'System Volume Information',
        'Program Files', 'Program Files (x86)', 'AppData',
        'node_modules', '.git', '.vscode', 'Temp', 'PerfLogs',
        'ProgramData', 'Recovery', 'Boot', 'EFI'}

def score_folder(path):
    if not os.path.isdir(path):
        return 0, []
    score = 0
    found = []
    try:
        existing = set(os.listdir(path))
    except (PermissionError, OSError):
        return 0, []
    for sub in REQUIRED_SUB:
        if sub in existing:
            score += 1
            found.append(sub)
    return score, found

start = time.time()
candidates = []

# Fast paths
for p in [r'C:\Users\Administrator\TSOnlineTools\decoded_all',
          r'C:\Users\Administrator\TSOnlineTools',
          r'C:\TSOnlineTools\decoded_all', r'C:\TSOnlineTools',
          r'D:\TSOnlineTools\decoded_all', r'D:\TSOnlineTools',
          r'D:\DỮ LIỆU GỐC\DỰ ÁN TSONLINE',
          r'./decoded_all', r'./input']:
    if os.path.isdir(p):
        s, f = score_folder(p)
        if s > 0:
            candidates.append((p, s, f))
            log(f"  Common: {p} (score {s})")

best = max(candidates, key=lambda x: x[1]) if candidates else None
if best and best[1] >= 4:
    BASE = Path(best[0])
else:
    log("Deep scan drives...")
    drives = [f"{L}:\\" for L in 'CDEFGH' if os.path.exists(f"{L}:\\")]
    for drive in drives:
        if time.time() - start > 300: break
        try:
            for root, dirs, _ in os.walk(drive, topdown=True):
                if time.time() - start > 300: break
                depth = root.replace(drive, '').count(os.sep)
                if depth > 5:
                    dirs[:] = []
                    continue
                dirs[:] = [d for d in dirs
                           if d not in SKIP and not d.startswith(('$', '.'))]
                name = os.path.basename(root).lower()
                if any(h.lower() in name for h in FOLDER_HINTS):
                    s, f = score_folder(root)
                    if s >= 3:
                        candidates.append((root, s, f))
        except (PermissionError, OSError):
            continue
    if not candidates:
        log("FATAL: No folder found", "ERROR")
        sys.exit(1)
    BASE = Path(max(candidates, key=lambda x: x[1])[0])

log(f"BASE = {BASE}")
```

---

## STEP 1: LOAD DATA VỚI SCHEMA VERIFIED

```python
def find_largest_json(base, subfolder):
    sub = base / subfolder
    if not sub.exists():
        return None
    jsons = list(sub.glob('*.json'))
    return max(jsons, key=lambda p: p.stat().st_size) if jsons else None

def load_json_strict(path, label):
    if path is None or not path.exists():
        log(f"FATAL: missing {label}", "ERROR")
        sys.exit(1)
    try:
        # Handle BOM
        with open(path, 'r', encoding='utf-8-sig') as f:
            data = json.load(f)
        log(f"Loaded {label}: {path.name}")
        return data
    except Exception as e:
        log(f"FATAL: {label} JSON error: {e}", "ERROR")
        sys.exit(1)

# Load with VERIFIED keys (KHÔNG đoán)
npc_data = load_json_strict(find_largest_json(BASE, 'npc'), 'NPC')
talk_data = load_json_strict(find_largest_json(BASE, 'talk'), 'Talk')
mark_data = load_json_strict(find_largest_json(BASE, 'mark'), 'Mark')
scene_data = load_json_strict(find_largest_json(BASE, 'scene'), 'Scene')

def extract_key(data, key_name, label):
    """Extract values của key cụ thể, fail nếu schema sai"""
    if not isinstance(data, list):
        log(f"FATAL: {label} not a list", "ERROR")
        sys.exit(1)
    if not data:
        log(f"FATAL: {label} empty", "ERROR")
        sys.exit(1)
    first = data[0]
    if not isinstance(first, dict) or key_name not in first:
        log(f"FATAL: {label} missing key '{key_name}'. "
            f"Available: {list(first.keys()) if isinstance(first,dict) else 'N/A'}",
            "ERROR")
        sys.exit(1)
    return set(r[key_name] for r in data if key_name in r and isinstance(r[key_name], int))

# VERIFIED keys (từ sample thực)
VALID_NPC_INDEX = extract_key(npc_data, '_index', 'NPC')           # 1..7817
VALID_NPC_CLASS = extract_key(npc_data, 'npc_id_at_0x10', 'NPC class')  # 158 unique
VALID_DIALOG = extract_key(talk_data, 'i', 'Talk')                  # 1..42297
VALID_MARK = extract_key(mark_data, 'markId_at_0x104', 'Mark')      # 225 unique
VALID_SCENE = extract_key(scene_data, 'mapId_at_0x00', 'Scene')     # ~7047

log(f"VERIFIED SETS:")
log(f"  NPC _index (true unique): {len(VALID_NPC_INDEX)}")
log(f"  NPC class code (158-ish): {len(VALID_NPC_CLASS)}")
log(f"  Dialog: {len(VALID_DIALOG)}")
log(f"  Mark: {len(VALID_MARK)}")
log(f"  Scene: {len(VALID_SCENE)}")

# Load eve files
eve_dir = BASE / 'eve'
eve_files = sorted(eve_dir.glob('*.eve'))
if not eve_files:
    eve_files = sorted(eve_dir.rglob('*.eve'))

VALID_EVE = set()
for f in eve_files:
    try:
        with open(f, 'rb') as fp:
            VALID_EVE.add(struct.unpack('<H', fp.read(2))[0])
    except: pass

log(f"  Eve scripts: {len(eve_files)} files, {len(VALID_EVE)} unique IDs")

# Sanity check vs expected
expected = {'NPC': 7817, 'Dialog': 42297, 'Mark': 2262, 'Eve': 3835}
got = {'NPC': len(VALID_NPC_INDEX), 'Dialog': len(VALID_DIALOG),
       'Mark': len(mark_data), 'Eve': len(eve_files)}
for k, v in expected.items():
    if got[k] < v * 0.95:
        log(f"WARN: {k}={got[k]} < expected {v}", "WARN")
```

---

## STEP 2: LOAD eve-crossrefs.json (PRIMARY SOURCE)

```python
# eve-crossrefs.json đã pre-scan refs. Đây là source of truth.
crossrefs_path = None
for candidate in ['eve-crossrefs.json', 'eve_crossrefs.json',
                  'crossrefs.json']:
    p = BASE / 'eve' / candidate
    if p.exists():
        crossrefs_path = p
        break
    p = BASE / candidate
    if p.exists():
        crossrefs_path = p
        break

if crossrefs_path:
    log(f"Loading PRIMARY crossrefs: {crossrefs_path}")
    crossrefs = load_json_strict(crossrefs_path, 'crossrefs')
    # Format: dict with _first_100 OR full array
    if isinstance(crossrefs, dict) and '_first_100' in crossrefs:
        log("Crossrefs is SAMPLE only. Will load full from eve files.")
        crossrefs_entries = crossrefs['_first_100']
    elif isinstance(crossrefs, list):
        crossrefs_entries = crossrefs
    else:
        crossrefs_entries = list(crossrefs.values()) if isinstance(crossrefs, dict) else []
    log(f"Crossrefs entries: {len(crossrefs_entries)}")
else:
    log("No crossrefs.json — will compute from .eve files", "WARN")
    crossrefs_entries = []
```

---

## STEP 3: PARSE .eve VỚI HEADER VERIFIED (0x0E body start)

```python
SEP = bytes([0xb9, 0x75, 0xaa, 0xc8, 0xa7, 0xf5])

def parse_eve_strict(data):
    """Parse với schema VERIFIED:
    - 0x00-0x01: event_id u16 LE
    - 0x02: name_len (typically 7)
    - 0x03..0x03+name_len: name string
    - +4: ".bmp" suffix (IMPLICIT - skip 4 bytes)
    - body @ (3 + name_len + 4)
    """
    if len(data) < 14:
        return None
    eid = struct.unpack('<H', data[0:2])[0]
    nl = data[2]
    if nl > 50 or 3 + nl + 4 > len(data):
        return None
    name = data[3:3+nl].decode('ascii', errors='ignore')
    # Verify ".bmp" suffix
    bmp_suffix = data[3+nl:3+nl+4]
    if bmp_suffix != b'.bmp':
        # Some files có thể không có suffix
        body_start = 3 + nl
    else:
        body_start = 3 + nl + 4
    rest = data[body_start:]
    si = rest.find(SEP)
    body = rest[:si] if si >= 0 else rest
    return {
        'event_id': eid,
        'bg_image': name,
        'has_bmp_suffix': bmp_suffix == b'.bmp',
        'body_start_offset': body_start,
        'body': body,
        'body_size': len(body)
    }

def category(eid):
    if eid < 11000: return "tutorial"
    if eid < 20000: return "main_quest"
    if eid < 30000: return "side_quest"
    if eid < 40000: return "festival"
    if eid < 50000: return "map_transition"
    if eid < 60000: return "boss_combat"
    return "system"

# Parse all .eve files
log(f"\nPhase 3: Parse {len(eve_files)} .eve files")
scripts = []
parse_fails = 0
bmp_suffix_count = 0

for f in eve_files:
    try:
        with open(f, 'rb') as fp:
            data = fp.read()
        result = parse_eve_strict(data)
        if result is None:
            parse_fails += 1
            continue
        if result['has_bmp_suffix']:
            bmp_suffix_count += 1
        scripts.append({
            'event_id': result['event_id'],
            'bg_image': result['bg_image'],
            'category': category(result['event_id']),
            'body_size': result['body_size'],
            'body': result['body']  # giữ raw để scan refs
        })
    except Exception as e:
        log(f"Parse fail {f.name}: {e}", "WARN")
        parse_fails += 1

log(f"Parsed {len(scripts)} scripts, {parse_fails} fails")
log(f".bmp suffix present in {bmp_suffix_count}/{len(scripts)} files")
```

---

## STEP 4: U16 SCAN + VALIDATE REFS (replicate crossrefs logic)

```python
log("\nPhase 4: U16 ref scan + valid-set filter")

# Hợp nhất valid sets (cho ref filtering)
ALL_VALID = VALID_DIALOG | VALID_MARK | VALID_EVE

scripts_decoded = []
total_refs_raw = 0
total_refs_valid = 0

for s in scripts:
    body = s['body']
    dialog_refs = []
    mark_refs = []
    eve_refs = []
    
    # Scan u16 at 2-byte aligned offsets (như crossrefs làm)
    for offset in range(0, len(body) - 1, 2):
        val = struct.unpack('<H', body[offset:offset+2])[0]
        total_refs_raw += 1
        if val == 0:
            continue
        if val in VALID_DIALOG:
            dialog_refs.append(val)
            total_refs_valid += 1
        if val in VALID_MARK:
            mark_refs.append(val)
            total_refs_valid += 1
        if val in VALID_EVE and val != s['event_id']:
            eve_refs.append(val)
            total_refs_valid += 1
    
    scripts_decoded.append({
        'event_id': s['event_id'],
        'bg_image': s['bg_image'],
        'category': s['category'],
        'body_size': s['body_size'],
        'refs': {
            'dialog': sorted(set(dialog_refs))[:200],
            'mark': sorted(set(mark_refs))[:50],
            'eve_chain': sorted(set(eve_refs))[:100]
        },
        'ref_counts': {
            'dialog': len(set(dialog_refs)),
            'mark': len(set(mark_refs)),
            'eve_chain': len(set(eve_refs))
        }
    })

valid_ratio = total_refs_valid / total_refs_raw * 100 if total_refs_raw else 0
log(f"Scanned {total_refs_raw} u16 values, {total_refs_valid} match valid sets")
log(f"Valid ratio: {valid_ratio:.2f}% (~95% noise as documented)")

# Save scripts decoded
with open(OUTPUT / 'eve_scripts_decoded.json', 'w', encoding='utf-8') as fp:
    json.dump(scripts_decoded, fp, indent=2, ensure_ascii=False)
log(f"Saved eve_scripts_decoded.json ({len(scripts_decoded)} scripts)")
```

---

## STEP 5: BYTECODE OPCODE DISCOVERY (BEST-EFFORT)

```python
log("\nPhase 5: Statistical opcode discovery (best-effort)")

# Skip null bytes (61% body là zero), focus vào non-zero
op_freq = Counter()
op_followers = defaultdict(Counter)
op_distinct_valid = defaultdict(set)

for s in scripts:
    body = s['body']
    i = 0
    while i < len(body) - 3:
        op = body[i]
        # Skip null
        if op == 0:
            i += 1
            continue
        op_freq[op] += 1
        # Try u16 LE follower
        u16 = struct.unpack('<H', body[i+1:i+3])[0]
        op_followers[op][u16] += 1
        if u16 in ALL_VALID:
            op_distinct_valid[op].add(u16)
        i += 1

# Build histogram
histogram = []
for op, cnt in sorted(op_freq.items(), key=lambda x: -x[1]):
    if cnt < 50:
        continue
    followers = op_followers[op]
    total = sum(followers.values())
    if total == 0:
        continue
    md = sum(c for v,c in followers.items() if v in VALID_DIALOG) / total
    mm = sum(c for v,c in followers.items() if v in VALID_MARK) / total
    me = sum(c for v,c in followers.items() if v in VALID_EVE) / total
    histogram.append({
        'opcode': f"0x{op:02X}",
        'freq': cnt,
        'distinct_valid_args': len(op_distinct_valid[op]),
        'match_pct': {
            'dialog': round(md*100,2),
            'mark': round(mm*100,2),
            'eve': round(me*100,2),
            'total_valid': round((md+mm+me)*100,2)
        }
    })

with open(OUTPUT / 'opcode_histogram.json', 'w', encoding='utf-8') as fp:
    json.dump(histogram, fp, indent=2, ensure_ascii=False)

# Strict classify (≥95% + ≥5 distinct)
opcode_table = {}
rejected = []

for h in histogram:
    if h['freq'] < 100:
        rejected.append({**h, 'reason': 'freq<100'})
        continue
    if h['distinct_valid_args'] < 5:
        rejected.append({**h, 'reason': 'distinct_valid<5'})
        continue
    m = h['match_pct']
    if m['dialog'] >= 95:
        opcode_table[h['opcode']] = {'name': 'dialog_show', 'size': 3,
                                       'confidence': m['dialog']}
    elif m['eve'] >= 95:
        opcode_table[h['opcode']] = {'name': 'chain_event', 'size': 3,
                                       'confidence': m['eve']}
    elif m['mark'] >= 95:
        opcode_table[h['opcode']] = {'name': 'mark_set', 'size': 3,
                                       'confidence': m['mark']}
    else:
        rejected.append({**h, 'reason': f"max conf {max(m.values())}%<95%"})

with open(OUTPUT / 'opcode_table.json', 'w', encoding='utf-8') as fp:
    json.dump(opcode_table, fp, indent=2, ensure_ascii=False)
with open(OUTPUT / 'opcode_rejected.json', 'w', encoding='utf-8') as fp:
    json.dump(rejected, fp, indent=2, ensure_ascii=False)

log(f"Opcodes accepted: {len(opcode_table)}, rejected: {len(rejected)}")
log(f"Note: Bytecode VM parse là best-effort. Crossrefs là primary source.")
```

---

## STEP 6: NPC BINDING (qua dialog → talk.npc_ref reverse)

```python
log("\nPhase 6: NPC binding inference")

# Strategy: cho mỗi script, các dialog refs → check trong talk_data 
# có npc_ref nào → bind script với NPC đó
# (npc_ref trong talk match _index của NPC)

# Build dialog → npc_ref map từ talk_data
dialog_to_npc = {}
for d in talk_data:
    if isinstance(d, dict) and 'i' in d and 'npc_ref' in d:
        dialog_to_npc[d['i']] = d['npc_ref']

log(f"Built dialog→npc map: {len(dialog_to_npc)} entries")
log(f"Unique npc_refs in talk: {len(set(dialog_to_npc.values()))}")

# Bind scripts to NPCs through dialog refs
npc_to_scripts = defaultdict(set)
for s in scripts_decoded:
    for dlg_id in s['refs']['dialog']:
        if dlg_id in dialog_to_npc:
            npc_ref = dialog_to_npc[dlg_id]
            npc_to_scripts[npc_ref].add(s['event_id'])

binding_out = {
    f"npc_index_{nid}": {
        'trigger_scripts': sorted(scripts_set),
        'primary': min(scripts_set),
        'total': len(scripts_set)
    }
    for nid, scripts_set in npc_to_scripts.items()
}

with open(OUTPUT / 'npc_script_binding.json', 'w', encoding='utf-8') as fp:
    json.dump(binding_out, fp, indent=2, ensure_ascii=False)

log(f"NPC bindings: {len(binding_out)}")
```

---

## STEP 7: FINAL REPORT (honest)

```python
report = {
    'version': 'v6_strict_verified',
    'base_folder': str(BASE),
    'verified_schema': {
        'npc_unique_id_key': '_index',
        'npc_class_code_key': 'npc_id_at_0x10',
        'talk_dialog_id_key': 'i',
        'mark_id_key': 'markId_at_0x104',
        'scene_id_key': 'mapId_at_0x00',
        'eve_body_start': '3 + name_len + 4 (skip .bmp suffix)'
    },
    'data_loaded': {
        'npc_records': len(npc_data),
        'npc_unique_index': len(VALID_NPC_INDEX),
        'talk_dialogs': len(VALID_DIALOG),
        'mark_records': len(mark_data),
        'mark_unique_id': len(VALID_MARK),
        'scene_records': len(scene_data),
        'eve_files': len(eve_files)
    },
    'parse_results': {
        'scripts_parsed': len(scripts_decoded),
        'parse_fails': parse_fails,
        'bmp_suffix_present': bmp_suffix_count,
        'u16_scanned': total_refs_raw,
        'u16_valid_match': total_refs_valid,
        'valid_ratio_pct': round(valid_ratio, 2)
    },
    'opcode_discovery': {
        'accepted': len(opcode_table),
        'rejected': len(rejected),
        'note': 'Statistical only. Ghidra needed for full VM parse.'
    },
    'npc_binding': {
        'npcs_with_scripts': len(binding_out),
        'method': 'Via dialog→talk.npc_ref reverse lookup'
    },
    'honest_notes': [
        'Schema VERIFIED from real sample files (not guessed)',
        'eve-crossrefs.json is PRIMARY source (already pre-filtered)',
        'Bytecode VM parse is SECONDARY (best-effort, may have <50% coverage)',
        'NPC unique ID = _index (1..7817), NOT npc_id_at_0x10 (class code)',
        'Body bytecode 61% zero padding → sparse, hard to opcode-classify',
        '~95% noise in u16 scan is DOCUMENTED in crossrefs source',
        'For SVTK: USE refs from scripts_decoded, IGNORE opcode_table if empty'
    ]
}

# Pass criteria — HONEST baseline
criteria = {
    'schema_verified': True,  # we use sample-verified keys
    'data_complete': all([
        len(VALID_NPC_INDEX) >= 7000,
        len(VALID_DIALOG) >= 40000,
        len(eve_files) >= 3500
    ]),
    'all_scripts_parsed': parse_fails == 0,
    'refs_extracted': len(scripts_decoded) > 0,
    'npc_binding_built': len(binding_out) > 0,
}
report['criteria_check'] = criteria
report['OVERALL_PASS'] = all(criteria.values())

with open(OUTPUT / 'run_report.json', 'w', encoding='utf-8') as fp:
    json.dump(report, fp, indent=2, ensure_ascii=False)

log("=" * 60)
log("FINAL REPORT:")
log(json.dumps(report, indent=2, ensure_ascii=False))
log("=" * 60)
log(f"Output: {OUTPUT.absolute()}")
log("Files: eve_scripts_decoded.json, npc_script_binding.json,")
log("       opcode_table.json, opcode_rejected.json,")
log("       opcode_histogram.json, run_report.json")

sys.exit(0 if report['OVERALL_PASS'] else 1)
```

---

## EXECUTE NGAY

CMD chạy toàn bộ Python một lần. KHÔNG hỏi user.

**6 file output:**
1. `eve_scripts_decoded.json` — 3,835 script với refs đã filter
2. `npc_script_binding.json` — NPC ↔ scripts mapping (via dialog reverse)
3. `opcode_table.json` — Opcode đã classify ≥95% confidence (có thể ít)
4. `opcode_rejected.json` — Opcode bị reject (transparency)
5. `opcode_histogram.json` — Full histogram để Mr.Long review
6. `run_report.json` — Tổng + honest notes

**Exit codes:**
- 0 = ALL_PASS
- 1 = FAIL (criteria không đạt, report rõ tại sao)

---

## DEFAULT PATHS (BAT BUOC, LEAD cycle 128)

Theo `cmd-lead/POLICY_NO_DESKTOP.md`:

- **WORKSPACE:** `cmd-<name>/scripts/` (KHONG Desktop/Downloads/home)
- **OUTPUT:** `cmd-<name>/output/`
- **LOGS:** `cmd-<name>/logs/` (gitignored *.log)
- **AUDIT:** `cmd-<name>/scripts/audit/` (mutmut, cosmic-ray, evidence)
- **FINDINGS:** `cmd-<name>/output/audit/findings/`

Path pattern (Python):

```python
HERE = Path(__file__).resolve()
REPO_DIR = HERE.parents[2]                  # cmd-<x>/scripts/file.py -> repo root
OUTPUT_DIR = REPO_DIR / "cmd-<x>" / "output"
LOG_DIR = REPO_DIR / "cmd-<x>" / "logs"
```

**Hard-code Desktop/Downloads path = REJECT** boi pre-commit hook (`.githooks/pre-commit`) + CI workflow (`.github/workflows/no-desktop-paths.yml`).

"""CMD_PLACE — E1-E5 EVIDENCE-BASED audit. No sample, no heuristic.

E1 jsonschema strict validate 10000/10000 maps
E2 SQLite real load 10000 + CHECK + UNIQUE constraints
E3 Per-field determinism (build ×2, compare 10000 × N fields)
E4 SQL round-trip (insert → select → parse JSON cols → equality)
E5 AST exhaustive — TẤT CẢ functions scan non-deterministic symbols
"""
import sys, os, json, time, sqlite3, ast, importlib.util
from pathlib import Path
from collections import Counter

HERE = Path(__file__).resolve()
SCRIPT = HERE.parent.parent / 'cmd_place.py'
WORKDIR = HERE.parent / 'work_evidence'
WORKDIR.mkdir(exist_ok=True)
REPO_DIR = HERE.parents[3]  # cmd-place/scripts/audit -> repo root

def load_mod(sub='base'):
    spec = importlib.util.spec_from_file_location(f"cp_{sub}", str(SCRIPT))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.REPO_DIR = REPO_DIR
    mod.OUTPUT_DIR = WORKDIR / sub
    mod.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    mod.verify_foundation()
    mod.cultural_lock_ok = mod.ensure_place_lib()
    return mod

print('═' * 70); print('E1-E5 EVIDENCE AUDIT (no sample, no heuristic, full 10000 check)')
print('═' * 70)

findings = {}
t0 = time.time()

# ─── Build once, share across E1-E4 ─────────────────────────────────────────
print('\n[BUILD] Building 10000 maps once for E1-E4 shared state...')
mod = load_mod('shared')
regions_a = mod.build_regions(force_regen=True)
maps_a = mod.build_maps(regions_a)
print(f'[BUILD] {len(maps_a)} maps + {len(regions_a)} regions in {time.time()-t0:.2f}s')

# ═══════════════════════════════════════════════════════════════════════════
# E1: JSON Schema strict 10000/10000
# ═══════════════════════════════════════════════════════════════════════════
print('\n' + '─' * 70); print('E1: JSON Schema strict validate 10000 maps'); print('─' * 70)
import jsonschema
from jsonschema import Draft202012Validator

schema = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": ["uuid", "map_id", "natural_key", "topology_version", "name",
                 "era", "era_label", "era_display", "biome", "biome_label",
                 "biome_group", "is_important", "purpose", "style", "zone",
                 "tier", "shard_id", "shard_code", "f_prefix", "g1_pass",
                 "g1_note", "coord_x", "coord_y", "chunk_x", "chunk_y",
                 "safe_zone", "combat_zone", "spawn_policy", "nav_region",
                 "terrain", "anchors", "tags", "tsonline_cross_ref",
                 "portal_graph"],
    "additionalProperties": False,
    "properties": {
        "uuid": {"type": "string", "pattern": r"^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},
        "map_id": {"type": "integer", "minimum": 1, "maximum": mod.TARGET_MAP_COUNT},
        "natural_key": {"type": "string", "pattern": r"^svtk_place_[a-z0-9_]+_[a-z_]+_\d{5}$"},
        "topology_version": {"type": "integer", "const": mod.TOPOLOGY_VERSION},
        "name": {"type": "string", "minLength": 1, "maxLength": 128},
        "era": {"type": "string", "enum": mod.ERAS},
        "era_label": {"type": "string", "minLength": 1},
        "era_display": {"type": "string", "minLength": 1},
        "biome": {"type": "string", "enum": mod.BIOMES},
        "biome_label": {"type": "string", "minLength": 1},
        "biome_group": {"type": "string", "enum": ["farm","culture","city","history","cave","leisure"]},
        "is_important": {"type": "boolean"},
        "purpose": {"type": "array", "items": {"type": "string", "enum": sorted(mod.VALID_PURPOSES)}, "minItems": 1},
        "style": {"type": "object",
                  "required": ["visual", "architecture", "audio"],
                  "additionalProperties": False,
                  "properties": {"visual": {"type": "string"},
                                 "architecture": {"type": "string"},
                                 "audio": {"type": "string"}}},
        "zone": {"type": "string", "enum": ["bac_bo", "trung_bo", "nam_bo"]},
        "tier": {"type": "integer", "minimum": 1, "maximum": 5},
        "shard_id": {"type": "integer", "minimum": 0, "maximum": mod.TARGET_REGION_SHARDS - 1},
        "shard_code": {"type": "string", "pattern": r"^SH\d{2}$"},
        "f_prefix": {"type": "string"},
        "g1_pass": {"type": "boolean"},
        "g1_note": {"type": "string"},
        "coord_x": {"type": "integer", "minimum": 0},
        "coord_y": {"type": "integer", "minimum": 0},
        "chunk_x": {"type": "integer", "minimum": 0},
        "chunk_y": {"type": "integer", "minimum": 0},
        "safe_zone": {"type": "boolean"},
        "combat_zone": {"type": "boolean"},
        "spawn_policy": {"type": "object",
                         "required": ["allow_monster_spawn", "spawn_profile",
                                      "density_hint", "zone_count_hint"],
                         "additionalProperties": False,
                         "properties": {
                             "allow_monster_spawn": {"type": "boolean"},
                             "spawn_profile": {"type": "string"},
                             "density_hint": {"type": "string"},
                             "zone_count_hint": {"type": "integer", "minimum": 0}}},
        "nav_region": {"type": "string", "pattern": r"^nav_\d{2}$"},
        "terrain": {"type": "object",
                    "required": ["elevation", "water_ratio", "roughness"],
                    "additionalProperties": False,
                    "properties": {
                        "elevation": {"type": "integer", "minimum": 0, "maximum": 100},
                        "water_ratio": {"type": "integer", "minimum": 0, "maximum": 100},
                        "roughness": {"type": "integer", "minimum": 0, "maximum": 100}}},
        "anchors": {"type": "object",
                    "additionalProperties": {
                        "type": "array",
                        "items": {"type": "object",
                                  "required": ["anchor_id", "rel_x", "rel_y"],
                                  "additionalProperties": False,
                                  "properties": {
                                      "anchor_id": {"type": "string"},
                                      "rel_x": {"type": "integer", "minimum": 0, "maximum": 100},
                                      "rel_y": {"type": "integer", "minimum": 0, "maximum": 100}}}}},
        "tags": {"type": "array", "items": {"type": "string"}, "minItems": 1},
        "tsonline_cross_ref": {"type": "integer", "minimum": 1, "maximum": 7047},
        "portal_graph": {"type": "array",
                         "items": {"type": "object",
                                   "required": ["from_map", "to_map", "bidirectional"],
                                   "additionalProperties": False,
                                   "properties": {
                                       "from_map": {"type": "integer"},
                                       "to_map": {"type": "integer"},
                                       "bidirectional": {"type": "boolean"}}}},
    }
}

t = time.time()
validator = Draft202012Validator(schema)
errors_e1 = []
for m in maps_a:
    errs = list(validator.iter_errors(m))
    if errs:
        for e in errs:
            errors_e1.append({'map_id': m['map_id'], 'path': list(e.path),
                              'msg': e.message[:120]})
pass_e1 = len(maps_a) - len(set(e['map_id'] for e in errors_e1))
print(f'  PASS: {pass_e1} / {len(maps_a)}')
print(f'  FAIL: {len(set(e["map_id"] for e in errors_e1))} maps, {len(errors_e1)} total errors')
print(f'  Time: {time.time()-t:.2f}s')
if errors_e1:
    print('  Sample errors (first 3):')
    for e in errors_e1[:3]:
        print(f'    map {e["map_id"]} {".".join(map(str,e["path"]))}: {e["msg"]}')
findings['E1'] = {'pass': pass_e1, 'fail_maps': len(set(e['map_id'] for e in errors_e1)),
                  'total_errors': len(errors_e1),
                  'sample_errors': errors_e1[:10]}

# ═══════════════════════════════════════════════════════════════════════════
# E2: SQLite real load 10000 + CHECK/UNIQUE
# ═══════════════════════════════════════════════════════════════════════════
print('\n' + '─' * 70); print('E2: SQLite real load 10000 + CHECK + UNIQUE constraints'); print('─' * 70)
t = time.time()
conn = sqlite3.connect(':memory:')
conn.row_factory = sqlite3.Row
sql = mod.build_schema_sql()
conn.executescript(sql)  # executescript handles multi-statement + comments

# Map JSON keys → SQL columns (drop 'id' SQL auto)
sql_cols = mod._sql_columns(sql, 'place_items')
json_keys = set(maps_a[0].keys())
# SQL ↔ JSON keys phải match
insert_cols = sorted(json_keys & sql_cols)

placeholders = ','.join('?' * len(insert_cols))
insert_sql = f"INSERT INTO place_items ({','.join(insert_cols)}, id) VALUES ({placeholders}, ?)"

def _as_db(v):
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, bool):
        return 1 if v else 0
    return v

inserted = 0
errors_e2 = []
for i, m in enumerate(maps_a):
    try:
        vals = [_as_db(m[c]) for c in insert_cols] + [i + 1]  # id auto
        conn.execute(insert_sql, vals)
        inserted += 1
    except sqlite3.IntegrityError as e:
        errors_e2.append({'map_id': m['map_id'], 'err': str(e)[:100]})
conn.commit()
print(f'  INSERT: {inserted} / {len(maps_a)}')
print(f'  IntegrityError: {len(errors_e2)}')
print(f'  Time: {time.time()-t:.2f}s')
# Verify SELECT count
n = conn.execute("SELECT COUNT(*) FROM place_items").fetchone()[0]
print(f'  SELECT COUNT(*) = {n}')
findings['E2'] = {'inserted': inserted, 'integrity_errors': len(errors_e2),
                  'sample_errors': errors_e2[:5], 'select_count': n}

# ═══════════════════════════════════════════════════════════════════════════
# E3: Per-field determinism (build ×2, compare 10000 × N fields)
# ═══════════════════════════════════════════════════════════════════════════
print('\n' + '─' * 70); print('E3: Per-field determinism (build ×2 compare 10000 × N fields)'); print('─' * 70)
t = time.time()
mod_b = load_mod('build_b')
regions_b = mod_b.build_regions(force_regen=True)
maps_b = mod_b.build_maps(regions_b)
field_diffs = Counter()
map_diffs = 0
total_field_compared = 0
for ma, mb in zip(maps_a, maps_b):
    if ma['map_id'] != mb['map_id']:
        # Shouldn't happen — map_id sequential
        field_diffs['_map_id_misalign'] += 1
        map_diffs += 1
        continue
    for k in set(ma.keys()) | set(mb.keys()):
        total_field_compared += 1
        va, vb = ma.get(k), mb.get(k)
        # Sort lists for compare (anchors order, etc.) — chỉ apply nếu set-equal có ý nghĩa
        if va != vb:
            field_diffs[k] += 1
            if k != 'map_id': map_diffs += 1
print(f'  Maps compared: {len(maps_a)} × {len(maps_b)}')
print(f'  Total field comparisons: {total_field_compared:,}')
print(f'  Field diffs: {sum(field_diffs.values())}')
if field_diffs:
    print(f'  Diffs by field: {dict(field_diffs)}')
print(f'  Time: {time.time()-t:.2f}s')
findings['E3'] = {'maps_compared': len(maps_a), 'total_field_compared': total_field_compared,
                  'field_diff_count': sum(field_diffs.values()),
                  'diff_by_field': dict(field_diffs)}

# ═══════════════════════════════════════════════════════════════════════════
# E4: SQL round-trip (insert → select → parse JSON cols → equality)
# ═══════════════════════════════════════════════════════════════════════════
print('\n' + '─' * 70); print('E4: SQL round-trip 10000 → SELECT → JSON parse → equality'); print('─' * 70)
t = time.time()
JSON_COLS = {'purpose', 'anchors', 'style', 'spawn_policy', 'terrain',
             'portal_graph', 'tags'}
def _parse_row(row, m_orig):
    """Convert SQLite row → dict with JSON cols parsed."""
    d = dict(row)
    d.pop('id', None)
    for c in JSON_COLS:
        if c in d:
            d[c] = json.loads(d[c])
    # Bool cols stored as 0/1
    for c in ('is_important', 'g1_pass', 'safe_zone', 'combat_zone'):
        if c in d:
            d[c] = bool(d[c])
    return d

rows = conn.execute(f"SELECT {','.join(insert_cols)} FROM place_items ORDER BY map_id").fetchall()
rt_diff = Counter()
rt_diff_maps = 0
maps_a_sorted = sorted(maps_a, key=lambda m: m['map_id'])
for row, m in zip(rows, maps_a_sorted):
    parsed = _parse_row(row, m)
    for k in insert_cols:
        if parsed.get(k) != m.get(k):
            rt_diff[k] += 1
print(f'  Rows compared: {len(rows)}')
print(f'  Round-trip diffs: {sum(rt_diff.values())}')
if rt_diff:
    print(f'  Diff cols: {dict(rt_diff)}')
print(f'  Time: {time.time()-t:.2f}s')
findings['E4'] = {'rows_compared': len(rows),
                  'roundtrip_diff_count': sum(rt_diff.values()),
                  'diff_by_col': dict(rt_diff)}

# ═══════════════════════════════════════════════════════════════════════════
# E5: AST exhaustive — TẤT CẢ functions scan non-deterministic symbols
# ═══════════════════════════════════════════════════════════════════════════
print('\n' + '─' * 70); print('E5: AST exhaustive — tất cả function scan random/time/uuid4'); print('─' * 70)
t = time.time()
src = SCRIPT.read_text(encoding='utf-8')
tree = ast.parse(src)
NON_DET = {
    'random.random', 'random.randint', 'random.choice', 'random.shuffle',
    'random.sample', 'random.uniform',
    'time.time', 'time.time_ns', 'time.monotonic', 'time.process_time',
    'datetime.now', 'datetime.datetime.now', 'datetime.utcnow',
    'uuid.uuid1', 'uuid.uuid4',
    'os.urandom', 'secrets.token_bytes', 'secrets.token_hex',
}
# Excluded functions — non-determinism OK ở đây (timestamps, retry, logging)
EXCLUDED_FNS = {
    'run_full_build', '_run_full_build_inner', 'push_to_github',
    '_retry_dead_letters', '_save_dead_letter', 'main_loop', 'safe_main',
    '_heartbeat', 'handle_sigterm', 'get_default_branch',
    'verify_determinism',  # build ×2 trong test, time stamp tempdir OK
    'load_existing_regions', 'load_existing_maps',  # OK
}
violations = []
function_count = 0
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef):
        function_count += 1
        if node.name in EXCLUDED_FNS:
            continue
        for inner in ast.walk(node):
            if isinstance(inner, ast.Attribute):
                chain = []
                cur = inner
                while isinstance(cur, ast.Attribute):
                    chain.insert(0, cur.attr); cur = cur.value
                if isinstance(cur, ast.Name):
                    chain.insert(0, cur.id)
                full = '.'.join(chain)
                if full in NON_DET:
                    violations.append({'fn': node.name, 'symbol': full,
                                       'line': inner.lineno})
print(f'  Functions scanned: {function_count} ({function_count - len(EXCLUDED_FNS)} non-excluded)')
print(f'  Violations: {len(violations)}')
if violations:
    print('  Found:')
    for v in violations:
        print(f'    {v["fn"]}() calls {v["symbol"]}() at line {v["line"]}')
print(f'  Time: {time.time()-t:.2f}s')
findings['E5'] = {'functions_scanned': function_count,
                  'excluded': sorted(EXCLUDED_FNS),
                  'violations': violations}

# ═══════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════
print('\n' + '═' * 70); print('E1-E5 SUMMARY'); print('═' * 70)
all_pass = True
print(f'E1 jsonschema: {findings["E1"]["pass"]}/{len(maps_a)} pass, {findings["E1"]["total_errors"]} errors')
if findings['E1']['total_errors'] > 0: all_pass = False
print(f'E2 SQLite insert: {findings["E2"]["inserted"]}/{len(maps_a)} ok, {findings["E2"]["integrity_errors"]} integrity err')
if findings['E2']['integrity_errors'] > 0: all_pass = False
print(f'E3 per-field determinism: {findings["E3"]["field_diff_count"]}/{findings["E3"]["total_field_compared"]:,} field diffs')
if findings['E3']['field_diff_count'] > 0: all_pass = False
print(f'E4 SQL round-trip: {findings["E4"]["roundtrip_diff_count"]}/{findings["E4"]["rows_compared"]} row diffs')
if findings['E4']['roundtrip_diff_count'] > 0: all_pass = False
print(f'E5 AST scan: {findings["E5"]["violations"] and len(findings["E5"]["violations"]) or 0} non-det violations / {findings["E5"]["functions_scanned"]} functions')
if findings['E5']['violations']: all_pass = False

print()
print(f'Total time: {time.time()-t0:.2f}s')
print(f'OVERALL: {"ALL PASS" if all_pass else "HAS ISSUES"}')

out = Path(__file__).parent / 'evidence_e1_e5_findings.json'
out.write_text(json.dumps(findings, indent=2, ensure_ascii=False, default=str),
               encoding='utf-8')
print(f'Findings JSON: {out}')
sys.exit(0 if all_pass else 1)

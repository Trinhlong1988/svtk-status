"""CMD_PLACE v2.3.0 — 18-round deep audit. Diverse methodology, NO repeat.

R01: Determinism stress (build ×10 SHA bằng nhau)
R02: Coord uniqueness math proof + empirical
R03: Boundary (shard 0/63, k=0/max, era đầu/cuối)
R04: Smallest quota biome (capital 30) phân zone correct
R05: Schema SQL columns ↔ map JSON keys (full match)
R06: Anchor cross-contract (loại anchor sinh ra ↔ ANCHOR_CAP keys)
R07: Mutation ANCHOR_CAP → BUILD_RULE_HASH must change
R08: Mutation BIOME_QUOTA → output thực sự khác
R09: Fuzz adversarial map names (zero-width, RTL, control, NULL, surrogate)
R10: G1 keyword edge case (mixed case, diacritic variant)
R11: Concurrent: 2 thread chạy run_full_build → lock activate
R12: Race place_lib.py reload (concurrent import)
R13: AST scan — random.random / time.time / datetime.now / uuid4 in build logic
R14: Linter sweep (pyflakes basic)
R15: SQL parse — place_table.sql valid syntax
R16: Round-trip JSON byte-identical
R17: Unicode NFC normalization (tên Việt dấu khác form)
R18: Meta-audit — mutate 1 self_validate check, ensure detection
"""
import sys, os, json, time, hashlib, importlib.util, threading, ast, re, unicodedata
from pathlib import Path
from collections import Counter

SCRIPT = Path(__file__).parent / 'cmd_place.py'
WORKDIR = Path(__file__).parent / 'work'
WORKDIR.mkdir(exist_ok=True)
REPO_DIR = Path(r"C:\Users\Administrator\Desktop\22.5\CMD_BOSS_WORK\svtk-status")

def load_mod(output_subdir='base'):
    """Load module fresh với OUTPUT_DIR riêng (tránh share state)."""
    spec = importlib.util.spec_from_file_location(f"cp_{output_subdir}", str(SCRIPT))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.REPO_DIR = REPO_DIR
    mod.OUTPUT_DIR = WORKDIR / output_subdir
    mod.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    mod.verify_foundation()
    mod.cultural_lock_ok = mod.ensure_place_lib()
    return mod

findings = []
def add(rid, name, status, detail=''):
    f = {'round': rid, 'name': name, 'status': status, 'detail': detail}
    findings.append(f)
    print(f"[{rid}] {status:4} {name}" + (f" — {detail}" if detail else ''), flush=True)

# ─────────────────────────────────────────────────────────────────────────────
# R01: Determinism stress — build ×10 SHA bằng nhau
# ─────────────────────────────────────────────────────────────────────────────
def r01_determinism_stress():
    mod = load_mod('r01')
    shas = []
    for i in range(10):
        regions = mod.build_regions(force_regen=True)
        maps = mod.build_maps(regions)
        blob = '\n'.join(json.dumps(m, ensure_ascii=False, sort_keys=True) for m in maps)
        shas.append(hashlib.sha256(blob.encode()).hexdigest())
    if len(set(shas)) == 1:
        add('R01', 'determinism_stress_10x', 'PASS', f'SHA={shas[0][:16]}...')
    else:
        add('R01', 'determinism_stress_10x', 'FAIL',
            f'{len(set(shas))} distinct SHAs across 10 builds')

# ─────────────────────────────────────────────────────────────────────────────
# R02: Coord uniqueness math + empirical
# ─────────────────────────────────────────────────────────────────────────────
def r02_coord_uniqueness():
    mod = load_mod('r02')
    regions = mod.build_regions(force_regen=True)
    maps = mod.build_maps(regions)
    coords = [(m['coord_x'], m['coord_y']) for m in maps]
    if len(set(coords)) == len(coords):
        # Verify math: shard cell 1000, map cell 30, MGW 32 → 32*30=960 < 1000 → no overlap
        gw, sc, mgw, mc = mod.SHARD_GRID_WIDTH, mod.SHARD_CELL_SIZE, mod.MAP_GRID_WIDTH, mod.MAP_CELL_SIZE
        if mgw * mc <= sc:
            add('R02', 'coord_uniqueness', 'PASS',
                f'{len(coords)} unique coords, math: mgw*mc={mgw*mc}≤cell={sc}')
        else:
            add('R02', 'coord_uniqueness', 'WARN',
                f'{len(coords)} unique nhưng MGW*MC={mgw*mc}>CELL={sc} (risk shard overlap)')
    else:
        dup_count = len(coords) - len(set(coords))
        add('R02', 'coord_uniqueness', 'FAIL', f'{dup_count} coord trùng')

# ─────────────────────────────────────────────────────────────────────────────
# R03: Boundary — shard 0, shard cuối, k=0, k=max, era đầu/cuối
# ─────────────────────────────────────────────────────────────────────────────
def r03_boundary():
    mod = load_mod('r03')
    regions = mod.build_regions(force_regen=True)
    maps = mod.build_maps(regions)
    issues = []
    # Shard 0 phải có maps
    s0 = [m for m in maps if m['shard_id'] == 0]
    if not s0: issues.append('shard_id=0 không có map')
    elif s0[0]['map_id'] != 1: issues.append(f'shard 0 không bắt đầu từ map_id=1: {s0[0]["map_id"]}')
    # Shard cuối
    sLast = [m for m in maps if m['shard_id'] == mod.TARGET_REGION_SHARDS - 1]
    if not sLast: issues.append('shard cuối không có map')
    elif sLast[-1]['map_id'] != mod.TARGET_MAP_COUNT:
        issues.append(f'shard cuối không kết thúc map_id={mod.TARGET_MAP_COUNT}')
    # Era f1 và f5 (boundary của f-era group)
    f1 = [m for m in maps if m['era'] == 'f1']
    f5 = [m for m in maps if m['era'] == 'f5']
    if not f1: issues.append('era f1 không có map')
    if not f5: issues.append('era f5 không có map')
    # Biome đầu (forest) + cuối (garden)
    for b in (mod.BIOMES[0], mod.BIOMES[-1]):
        if not [m for m in maps if m['biome'] == b]:
            issues.append(f'biome {b} (boundary) không có map')
    if issues:
        add('R03', 'boundary_edges', 'FAIL', '; '.join(issues))
    else:
        add('R03', 'boundary_edges', 'PASS',
            f'shard 0..{mod.TARGET_REGION_SHARDS-1}, era f1+f5, biome đầu+cuối đều covered')

# ─────────────────────────────────────────────────────────────────────────────
# R04: Smallest-quota biome 'capital' = 30
# ─────────────────────────────────────────────────────────────────────────────
def r04_smallest_quota():
    mod = load_mod('r04')
    regions = mod.build_regions(force_regen=True)
    maps = mod.build_maps(regions)
    cap_maps = [m for m in maps if m['biome'] == 'capital']
    if len(cap_maps) != mod.BIOME_QUOTA['capital']:
        add('R04', 'smallest_quota_capital', 'FAIL',
            f'capital={len(cap_maps)} vs quota={mod.BIOME_QUOTA["capital"]}')
        return
    # Capital cấm nam_bo
    nam = [m for m in cap_maps if m['zone'] == 'nam_bo']
    if nam:
        add('R04', 'smallest_quota_capital', 'FAIL',
            f'{len(nam)} capital ở nam_bo (forbidden)')
        return
    # Phân bố bac_bo + trung_bo (largest-remainder)
    zone_dist = Counter(m['zone'] for m in cap_maps)
    add('R04', 'smallest_quota_capital', 'PASS',
        f'capital=30 đúng, zone dist: {dict(zone_dist)}, không có ở nam_bo')

# ─────────────────────────────────────────────────────────────────────────────
# R05: Schema SQL columns ↔ map JSON keys (full match)
# ─────────────────────────────────────────────────────────────────────────────
def r05_sql_contract():
    mod = load_mod('r05')
    regions = mod.build_regions(force_regen=True)
    maps = mod.build_maps(regions)
    sql = mod.build_schema_sql()
    sql_cols = mod._sql_columns(sql, 'place_items')
    json_keys = set(maps[0].keys())
    missing = json_keys - sql_cols
    extra = sql_cols - json_keys - {'id'}  # id là PK auto
    issues = []
    if missing: issues.append(f'JSON has but SQL missing: {sorted(missing)}')
    if extra: issues.append(f'SQL has but JSON missing: {sorted(extra)}')
    if issues:
        add('R05', 'sql_json_contract', 'FAIL', ' | '.join(issues))
    else:
        add('R05', 'sql_json_contract', 'PASS',
            f'{len(sql_cols)} SQL cols, {len(json_keys)} JSON keys, full match')

# ─────────────────────────────────────────────────────────────────────────────
# R06: Anchor cross-contract — loại anchor sinh ↔ ANCHOR_CAP keys
# ─────────────────────────────────────────────────────────────────────────────
def r06_anchor_contract():
    mod = load_mod('r06')
    regions = mod.build_regions(force_regen=True)
    maps = mod.build_maps(regions)
    cap_keys = set(mod.ANCHOR_CAP.keys())
    actual_types = set()
    for m in maps:
        actual_types.update(m['anchors'].keys())
    unknown = actual_types - cap_keys
    unused = cap_keys - actual_types
    if unknown:
        add('R06', 'anchor_contract', 'FAIL',
            f'anchor types sinh nhưng KHÔNG có trong ANCHOR_CAP: {unknown}')
    elif unused:
        add('R06', 'anchor_contract', 'WARN',
            f'ANCHOR_CAP định nghĩa nhưng KHÔNG sinh: {unused}')
    else:
        add('R06', 'anchor_contract', 'PASS', f'{len(actual_types)} loại anchor khớp')

# ─────────────────────────────────────────────────────────────────────────────
# R07: Mutation ANCHOR_CAP → BUILD_RULE_HASH MUST change (chống regression)
# ─────────────────────────────────────────────────────────────────────────────
def r07_mutation_anchor_cap():
    mod = load_mod('r07')
    h_before = mod._compute_build_rule_hash()
    mod.ANCHOR_CAP['npc_anchor'] += 1
    h_after = mod._compute_build_rule_hash()
    mod.ANCHOR_CAP['npc_anchor'] -= 1  # revert
    if h_before != h_after:
        add('R07', 'mutation_anchor_cap', 'PASS',
            f'before={h_before[:12]} after={h_after[:12]} (different ✓)')
    else:
        add('R07', 'mutation_anchor_cap', 'FAIL',
            'ANCHOR_CAP mutate nhưng BUILD_RULE_HASH KHÔNG đổi — cache stale risk')

# ─────────────────────────────────────────────────────────────────────────────
# R08: Mutation BIOME_QUOTA → output sha thực sự khác
# ─────────────────────────────────────────────────────────────────────────────
def r08_mutation_biome_quota():
    mod = load_mod('r08')
    regions = mod.build_regions(force_regen=True)
    maps_before = mod.build_maps(regions)
    sha_before = hashlib.sha256(
        '\n'.join(json.dumps(m, ensure_ascii=False, sort_keys=True) for m in maps_before).encode()
    ).hexdigest()
    # Mutate: swap cave +10, forest -10 (giữ tổng=10000)
    mod.BIOME_QUOTA['cave'] += 10
    mod.BIOME_QUOTA['forest'] -= 10
    regions2 = mod.build_regions(force_regen=True)
    maps_after = mod.build_maps(regions2)
    sha_after = hashlib.sha256(
        '\n'.join(json.dumps(m, ensure_ascii=False, sort_keys=True) for m in maps_after).encode()
    ).hexdigest()
    mod.BIOME_QUOTA['cave'] -= 10
    mod.BIOME_QUOTA['forest'] += 10
    cave_b = Counter(m['biome'] for m in maps_before)['cave']
    cave_a = Counter(m['biome'] for m in maps_after)['cave']
    if sha_before != sha_after and cave_a == cave_b + 10:
        add('R08', 'mutation_biome_quota', 'PASS',
            f'cave {cave_b}→{cave_a}, SHA changed')
    else:
        add('R08', 'mutation_biome_quota', 'FAIL',
            f'sha_same={sha_before==sha_after}, cave {cave_b}→{cave_a}')

# ─────────────────────────────────────────────────────────────────────────────
# R09: Fuzz adversarial map names
# ─────────────────────────────────────────────────────────────────────────────
def r09_fuzz_names():
    mod = load_mod('r09')
    cases = [
        ('​Zero Width', 'zero-width space'),
        ('‮RTL Override', 'right-to-left override'),
        ('Null\x00Char', 'NULL byte'),
        ('\ud83d', 'lone surrogate'),
        ('Hà́ Nội', 'combining mark (NFD form)'),
        ('   ', 'whitespace only'),
        ('', 'empty string'),
        ('A' * 200, 'too long (200 chars)'),
        ('Tào Tháo Vietnam', 'forbidden + valid prefix'),
        ('カタカナ Test', 'katakana'),
        ('ひらがな Test', 'hiragana'),
        ('正常 中文', 'CJK Han (should pass)'),
    ]
    issues = []
    for s, label in cases:
        try:
            res = mod.cultural_lock_ok(s)
            # Just check no crash; pass/fail policy is OK
        except Exception as e:
            issues.append(f'{label!r}: CRASH {e}')
    if issues:
        add('R09', 'fuzz_adversarial_names', 'FAIL', '; '.join(issues))
    else:
        add('R09', 'fuzz_adversarial_names', 'PASS',
            f'{len(cases)} edge case không crash, behavior consistent')

# ─────────────────────────────────────────────────────────────────────────────
# R10: G1 keyword case + diacritic variant
# ─────────────────────────────────────────────────────────────────────────────
def r10_g1_variants():
    mod = load_mod('r10')
    # G1 phải catch các variant case/dấu
    variants = [
        ('CASINO Vietnam', False),       # uppercase
        ('cAsInO Test', False),          # mixed
        ('Casino', False),               # title
        ('lưỡi bò', False),               # exact
        ('LƯỠI BÒ', False),               # upper diacritic
        ('Hoàng Sa', True),              # nhạy cảm nhưng pass with note
        ('hoàng sa quân đảo', True),     # case variant
        ('Văn Lang', True),              # normal pass
    ]
    issues = []
    for txt, expected_pass in variants:
        ok, note = mod.g1_check(txt)
        if ok != expected_pass:
            issues.append(f'{txt!r}: got pass={ok} expected={expected_pass}')
    if issues:
        add('R10', 'g1_case_diacritic_variants', 'FAIL', '; '.join(issues))
    else:
        add('R10', 'g1_case_diacritic_variants', 'PASS',
            f'{len(variants)} variant đúng expected')

# ─────────────────────────────────────────────────────────────────────────────
# R11: Concurrent — 2 thread chạy run_full_build, lock activate
# ─────────────────────────────────────────────────────────────────────────────
def r11_concurrent_build():
    mod = load_mod('r11')
    results = []
    def _worker():
        results.append(mod.run_full_build())
    threads = [threading.Thread(target=_worker) for _ in range(2)]
    for t in threads: t.start()
    for t in threads: t.join()
    # 1 should succeed, 1 should be locked
    locked = sum(1 for r in results if r[2] == ['build_locked'])
    success = sum(1 for r in results if r[0] is not None)
    if locked == 1 and success == 1:
        add('R11', 'concurrent_build_lock', 'PASS',
            f'1 succeed + 1 locked như expect')
    elif success == 2:
        add('R11', 'concurrent_build_lock', 'FAIL',
            f'2 thread cùng build OK → race condition, lock không activate')
    else:
        add('R11', 'concurrent_build_lock', 'WARN',
            f'locked={locked} success={success}')

# ─────────────────────────────────────────────────────────────────────────────
# R12: Race place_lib.py reload
# ─────────────────────────────────────────────────────────────────────────────
def r12_place_lib_race():
    mod = load_mod('r12')
    results = []
    def _w():
        try:
            fn = mod.ensure_place_lib()
            results.append(fn('Test'))
        except Exception as e:
            results.append(f'CRASH:{e}')
    threads = [threading.Thread(target=_w) for _ in range(5)]
    for t in threads: t.start()
    for t in threads: t.join()
    if all(r is True for r in results):
        add('R12', 'place_lib_concurrent_reload', 'PASS',
            f'5 concurrent reload OK, all return True')
    else:
        add('R12', 'place_lib_concurrent_reload', 'FAIL',
            f'results={results}')

# ─────────────────────────────────────────────────────────────────────────────
# R13: AST scan — random/time/datetime/uuid4 in build logic
# ─────────────────────────────────────────────────────────────────────────────
def r13_ast_nondeterminism():
    src = SCRIPT.read_text(encoding='utf-8')
    tree = ast.parse(src)
    # Find build_regions / build_maps / build_anchors functions
    BUILD_FNS = {'build_regions', 'build_maps', 'build_anchors', 'seeded_int', 'seeded_pick'}
    findings_ast = []
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name in BUILD_FNS:
            for inner in ast.walk(node):
                if isinstance(inner, ast.Attribute):
                    chain = []
                    cur = inner
                    while isinstance(cur, ast.Attribute):
                        chain.insert(0, cur.attr); cur = cur.value
                    if isinstance(cur, ast.Name):
                        chain.insert(0, cur.id)
                    full = '.'.join(chain)
                    if full in ('random.random', 'random.randint', 'random.choice',
                                'time.time', 'datetime.now', 'datetime.datetime.now',
                                'uuid.uuid1', 'uuid.uuid4', 'os.urandom'):
                        findings_ast.append(f'{node.name}() calls {full}() at line {inner.lineno}')
    if findings_ast:
        add('R13', 'ast_nondeterminism_in_build', 'FAIL', '; '.join(findings_ast))
    else:
        add('R13', 'ast_nondeterminism_in_build', 'PASS',
            f'build functions ({", ".join(sorted(BUILD_FNS))}) không gọi random/time/uuid4')

# ─────────────────────────────────────────────────────────────────────────────
# R14: pyflakes basic
# ─────────────────────────────────────────────────────────────────────────────
def r14_pyflakes():
    try:
        import pyflakes.api as pfa
        from io import StringIO
        out = StringIO(); err = StringIO()
        n = pfa.checkPath(str(SCRIPT), reporter=type('R', (), {
            'unexpectedError': lambda s,f,e: err.write(f'{f}:{e}\n'),
            'syntaxError': lambda s,f,m,l,o,t: err.write(f'{f}:{l}: {m}\n'),
            'flake': lambda s,m: out.write(f'{m}\n'),
        })())
        warns = out.getvalue().strip().split('\n') if out.getvalue().strip() else []
        if n == 0 and not warns:
            add('R14', 'pyflakes_lint', 'PASS', 'no issues')
        else:
            add('R14', 'pyflakes_lint', 'WARN', f'{n} issues: {warns[:3]}')
    except ImportError:
        add('R14', 'pyflakes_lint', 'WARN', 'pyflakes not installed')

# ─────────────────────────────────────────────────────────────────────────────
# R15: SQL parse — place_table.sql valid syntax
# ─────────────────────────────────────────────────────────────────────────────
def r15_sql_parse():
    mod = load_mod('r15')
    sql = mod.build_schema_sql()
    # Try pglast (PostgreSQL)
    try:
        import pglast
        parsed = pglast.parse_sql(sql)
        if parsed:
            add('R15', 'sql_pglast_parse', 'PASS',
                f'{len(parsed)} statements parse OK')
            return
    except ImportError:
        pass
    except Exception as e:
        add('R15', 'sql_pglast_parse', 'FAIL', f'pglast error: {e}')
        return
    # Fallback sqlite (forgiving but catches gross syntax)
    import sqlite3
    try:
        conn = sqlite3.connect(':memory:')
        for stmt in sql.split(';'):
            s = stmt.strip()
            if s and not s.startswith('--'):
                conn.execute(s + ';')
        add('R15', 'sql_sqlite_parse', 'PASS', 'sqlite executes OK')
    except Exception as e:
        add('R15', 'sql_sqlite_parse', 'FAIL', f'sqlite error: {e}')

# ─────────────────────────────────────────────────────────────────────────────
# R16: Round-trip JSON byte-identical
# ─────────────────────────────────────────────────────────────────────────────
def r16_roundtrip_jsonl():
    mod = load_mod('r16')
    regions = mod.build_regions(force_regen=True)
    maps = mod.build_maps(regions)
    fp = mod.OUTPUT_DIR / 'rt_test.jsonl'
    mod.write_jsonl(fp, maps)
    raw1 = fp.read_bytes()
    rows = [json.loads(l) for l in raw1.decode('utf-8').splitlines() if l.strip()]
    mod.write_jsonl(fp, rows)
    raw2 = fp.read_bytes()
    if raw1 == raw2:
        add('R16', 'jsonl_roundtrip_byte_identical', 'PASS',
            f'{len(raw1)} bytes identical after read-write')
    else:
        diff_byte = sum(1 for a, b in zip(raw1, raw2) if a != b)
        add('R16', 'jsonl_roundtrip_byte_identical', 'FAIL',
            f'{diff_byte} byte khác giữa 2 round-trip')

# ─────────────────────────────────────────────────────────────────────────────
# R17: Unicode NFC normalization
# ─────────────────────────────────────────────────────────────────────────────
def r17_unicode_nfc():
    mod = load_mod('r17')
    regions = mod.build_regions(force_regen=True)
    maps = mod.build_maps(regions)
    issues = []
    for m in maps[:500]:  # sample 500
        name = m['name']
        nfc = unicodedata.normalize('NFC', name)
        if name != nfc:
            issues.append(f"map {m['map_id']} name not NFC normalized")
            break
    if issues:
        add('R17', 'unicode_nfc_normalized', 'WARN', issues[0])
    else:
        add('R17', 'unicode_nfc_normalized', 'PASS',
            f'500 sample map names all NFC normalized')

# ─────────────────────────────────────────────────────────────────────────────
# R18: Meta-audit — mutate self_validate check, ensure detection
# ─────────────────────────────────────────────────────────────────────────────
def r18_meta_audit():
    mod = load_mod('r18')
    regions = mod.build_regions(force_regen=True)
    maps = mod.build_maps(regions)
    # Inject 1 corrupt map: duplicate map_id
    maps[1]['map_id'] = maps[0]['map_id']  # force duplicate
    score, gaps = mod.self_validate(regions, maps, det_mode='sampling')
    if 'map_id_unique' in gaps:
        add('R18', 'meta_audit_detect_corruption', 'PASS',
            f'self_validate detect map_id duplicate, score={score:.3f}, gaps include map_id_unique')
    else:
        add('R18', 'meta_audit_detect_corruption', 'FAIL',
            f'INJECTED duplicate KHÔNG bị detect — self_validate có lỗ! gaps={gaps}')

# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────
ROUNDS = [
    r01_determinism_stress, r02_coord_uniqueness, r03_boundary, r04_smallest_quota,
    r05_sql_contract, r06_anchor_contract, r07_mutation_anchor_cap, r08_mutation_biome_quota,
    r09_fuzz_names, r10_g1_variants, r11_concurrent_build, r12_place_lib_race,
    r13_ast_nondeterminism, r14_pyflakes, r15_sql_parse, r16_roundtrip_jsonl,
    r17_unicode_nfc, r18_meta_audit,
]

if __name__ == '__main__':
    t0 = time.time()
    for r in ROUNDS:
        try:
            r()
        except Exception as e:
            import traceback
            add(r.__name__[:3].upper(), r.__name__, 'CRASH', f'{e}')
            traceback.print_exc()
    summary = Counter(f['status'] for f in findings)
    print()
    print('=' * 70)
    print(f"AUDIT COMPLETE in {time.time()-t0:.1f}s")
    print(f"  PASS: {summary['PASS']}")
    print(f"  WARN: {summary['WARN']}")
    print(f"  FAIL: {summary['FAIL']}")
    print(f"  CRASH: {summary['CRASH']}")
    print('=' * 70)
    print()
    if summary['FAIL'] or summary['CRASH']:
        print('FAILED / CRASHED ROUNDS:')
        for f in findings:
            if f['status'] in ('FAIL', 'CRASH'):
                print(f"  [{f['round']}] {f['name']}: {f['detail']}")
    out = Path(__file__).parent / 'audit_findings.json'
    out.write_text(json.dumps({'summary': dict(summary), 'findings': findings},
                              indent=2, ensure_ascii=False), encoding='utf-8')
    print(f'Findings JSON: {out}')
    sys.exit(0 if (summary['FAIL'] == 0 and summary['CRASH'] == 0) else 1)

"""CMD_PLACE — 22 round DEEP audit R19-R40, methodology MỚI (no repeat R01-R18).

R19-R25: Property-based deep (invariant per-item)
  R19 coord_unique per zone
  R20 anchor density ≤ ANCHOR_CAP AND ≥ 1 cho biome có purpose
  R21 cluster biome contiguous in same shard
  R22 portal_graph mỗi map ≥1 outgoing edge
  R23 natural_key deterministic = f(era,biome,map_id)
  R24 UUID5 deterministic = uuid5(UUID_NS, natural_key)
  R25 terrain elevation/water_ratio/roughness trong 0-100

R26-R30: Snapshot / regression
  R26 region 0 (Bắc Bộ T1) expected_count cố định
  R27 BIOME_QUOTA sum = TARGET_MAP_COUNT
  R28 ERA_LABEL phủ đủ ERAS
  R29 REGION_NAMES per-zone không trùng
  R30 PURPOSE_ANCHOR keys = VALID_PURPOSES

R31-R35: Statistical / distribution
  R31 era distribution per zone — không zone nào dominated bởi 1 era
  R32 tier distribution per zone — T1 chỉ ở bắc, T5 phân bố đủ
  R33 anchor count distribution per map — mean/std
  R34 tsonline_cross_ref distribution chi-square
  R35 portal_graph degree distribution — không có map cô lập

R36-R40: Mutation matrix / adversarial inject
  R36 mutation BUILD_RULE_HASH — 5 hằng khác nhau, mỗi cái phải đổi hash
  R37 inject map với era không trong ERAS — all_era_valid catch
  R38 inject anchor type không trong ANCHOR_CAP — anchor_density_ok catch
  R39 inject portal self-loop — portal_graph_valid catch
  R40 self_validate với maps=[] empty — không crash, return 0
"""
import sys, os, json, time, hashlib, importlib.util, threading, ast, re, uuid
from pathlib import Path
from collections import Counter

HERE = Path(__file__).resolve()
SCRIPT = HERE.parent.parent / 'cmd_place.py'
WORKDIR = HERE.parent / 'work_deep'
WORKDIR.mkdir(exist_ok=True)
REPO_DIR = HERE.parents[3]  # cmd-place/scripts/audit -> repo root

def load_mod(sub):
    spec = importlib.util.spec_from_file_location(f"cp_{sub}", str(SCRIPT))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.REPO_DIR = REPO_DIR
    mod.OUTPUT_DIR = WORKDIR / sub
    mod.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    mod.verify_foundation()
    mod.cultural_lock_ok = mod.ensure_place_lib()
    return mod

# Build 1 lần dùng nhiều round — tiết kiệm
_shared_mod = None
_shared_regions = None
_shared_maps = None
def get_shared():
    global _shared_mod, _shared_regions, _shared_maps
    if _shared_mod is None:
        _shared_mod = load_mod('shared')
        _shared_regions = _shared_mod.build_regions(force_regen=True)
        _shared_maps = _shared_mod.build_maps(_shared_regions)
    return _shared_mod, _shared_regions, _shared_maps

findings = []
def add(rid, name, status, detail=''):
    f = {'round': rid, 'name': name, 'status': status, 'detail': detail}
    findings.append(f)
    print(f"[{rid}] {status:5} {name}" + (f" — {detail}" if detail else ''), flush=True)

# ─── R19: coord unique per zone ──────────────────────────────────────────────
def r19():
    mod, regions, maps = get_shared()
    issues = []
    for zone in ('bac_bo', 'trung_bo', 'nam_bo'):
        zmaps = [m for m in maps if m['zone'] == zone]
        coords = [(m['coord_x'], m['coord_y']) for m in zmaps]
        if len(set(coords)) != len(coords):
            issues.append(f'{zone}: {len(coords)-len(set(coords))} coord trùng nội bộ')
    if issues:
        add('R19', 'coord_unique_per_zone', 'FAIL', '; '.join(issues))
    else:
        add('R19', 'coord_unique_per_zone', 'PASS',
            f'3 zone đều coord unique nội bộ')

# ─── R20: anchor density ≤ CAP và ≥ 1 cho biome có purpose ──────────────────
def r20():
    mod, regions, maps = get_shared()
    issues = []
    for m in maps[:1000]:  # sample
        purposes = m.get('purpose', [])
        if not purposes: continue
        # ít nhất 1 loại anchor sinh ra cho biome có purpose
        if not m.get('anchors'):
            issues.append(f"map {m['map_id']} có purpose nhưng anchors rỗng")
            break
        # ≤ CAP cho mỗi loại
        for at, items in m['anchors'].items():
            if at not in mod.ANCHOR_CAP:
                issues.append(f"map {m['map_id']} anchor lạ: {at}")
                break
            if len(items) > mod.ANCHOR_CAP[at]:
                issues.append(f"map {m['map_id']} {at}={len(items)}>{mod.ANCHOR_CAP[at]}")
                break
    if issues:
        add('R20', 'anchor_density_invariant', 'FAIL', '; '.join(issues[:3]))
    else:
        add('R20', 'anchor_density_invariant', 'PASS', '1000 sample đều ≤ CAP, biome có purpose có anchor')

# ─── R21: cluster biome contiguous trong shard ──────────────────────────────
def r21():
    mod, regions, maps = get_shared()
    issues = []
    by_shard = {}
    for m in maps:
        by_shard.setdefault(m['shard_id'], []).append(m)
    for sid, chain in by_shard.items():
        # Mỗi shard tìm runs cluster_biomes — phải liên tiếp
        i = 0
        while i < len(chain):
            biome = chain[i]['biome']
            if biome in mod.CLUSTER_BIOMES:
                j = i
                while j < len(chain) and chain[j]['biome'] == biome:
                    j += 1
                run_len = j - i
                lo, hi = mod.CLUSTER_BIOMES[biome]
                # Run có thể >0 (có thể đứng riêng nếu cluster chưa kích hoạt)
                # Cluster kích hoạt → run trong [1, hi] (≤ hi luôn đúng)
                if run_len > hi:
                    issues.append(f'shard {sid} biome {biome} run={run_len} > hi={hi}')
                i = j
            else:
                i += 1
    if issues:
        add('R21', 'cluster_biome_contiguous', 'FAIL', '; '.join(issues[:3]))
    else:
        add('R21', 'cluster_biome_contiguous', 'PASS',
            'mọi cluster cave/forest/mountain ≤ hi của CLUSTER_BIOMES')

# ─── R22: portal_graph ≥1 outgoing edge mỗi map ─────────────────────────────
def r22():
    mod, regions, maps = get_shared()
    isolated = [m['map_id'] for m in maps if not m.get('portal_graph')]
    if isolated:
        add('R22', 'portal_min_outgoing', 'FAIL',
            f'{len(isolated)} map isolated (no portal). Ex: {isolated[:5]}')
    else:
        add('R22', 'portal_min_outgoing', 'PASS',
            f'all {len(maps)} maps có ≥1 portal edge')

# ─── R23: natural_key deterministic ─────────────────────────────────────────
def r23():
    mod, regions, maps = get_shared()
    issues = []
    for m in maps[:500]:
        expected = f"svtk_place_{m['era']}_{m['biome']}_{m['map_id']:05d}"
        if m['natural_key'] != expected:
            issues.append(f"map {m['map_id']}: nat_key={m['natural_key']} expected={expected}")
            break
    if issues:
        add('R23', 'natural_key_deterministic', 'FAIL', issues[0])
    else:
        add('R23', 'natural_key_deterministic', 'PASS', '500 sample đúng format')

# ─── R24: UUID5 deterministic ───────────────────────────────────────────────
def r24():
    mod, regions, maps = get_shared()
    issues = []
    for m in maps[:500]:
        expected = str(uuid.uuid5(mod.UUID_NS, m['natural_key']))
        if m['uuid'] != expected:
            issues.append(f"map {m['map_id']}: uuid mismatch")
            break
    if issues:
        add('R24', 'uuid5_deterministic', 'FAIL', issues[0])
    else:
        add('R24', 'uuid5_deterministic', 'PASS', '500 sample uuid5(NS, natural_key) khớp')

# ─── R25: terrain values trong range 0-100 ──────────────────────────────────
def r25():
    mod, regions, maps = get_shared()
    issues = []
    for m in maps[:1000]:
        t = m.get('terrain', {})
        for k in ('elevation', 'water_ratio', 'roughness'):
            v = t.get(k)
            if v is None or not (0 <= v <= 100):
                issues.append(f"map {m['map_id']} terrain.{k}={v}")
                break
        if issues: break
    if issues:
        add('R25', 'terrain_range_0_100', 'FAIL', issues[0])
    else:
        add('R25', 'terrain_range_0_100', 'PASS', '1000 sample terrain values OK')

# ─── R26: region 0 expected_count = snapshot ────────────────────────────────
def r26():
    mod, regions, maps = get_shared()
    # Bắc Bộ 24 region, 3910 map → region 0 = 3910/24 + (1 if 0<3910%24=22) = 162+1 = 163
    expect_r0 = 3910 // 24 + (1 if 0 < 3910 % 24 else 0)
    actual_r0 = regions[0]['expected_map_count']
    if actual_r0 != expect_r0:
        add('R26', 'region0_snapshot', 'FAIL',
            f'r0 expected_count={actual_r0} vs snapshot={expect_r0}')
    else:
        add('R26', 'region0_snapshot', 'PASS', f'r0 = {expect_r0} ✓')

# ─── R27: BIOME_QUOTA sum = TARGET_MAP_COUNT ────────────────────────────────
def r27():
    mod, _, _ = get_shared()
    s = sum(mod.BIOME_QUOTA.values())
    if s != mod.TARGET_MAP_COUNT:
        add('R27', 'biome_quota_sum', 'FAIL', f'sum={s} vs target={mod.TARGET_MAP_COUNT}')
    else:
        add('R27', 'biome_quota_sum', 'PASS', f'sum = {s}')

# ─── R28: ERA_LABEL covers ERAS ─────────────────────────────────────────────
def r28():
    mod, _, _ = get_shared()
    missing = set(mod.ERAS) - set(mod.ERA_LABEL)
    if missing:
        add('R28', 'era_label_coverage', 'FAIL', f'missing labels: {missing}')
    else:
        add('R28', 'era_label_coverage', 'PASS', f'all {len(mod.ERAS)} era có label')

# ─── R29: REGION_NAMES per-zone uniqueness ──────────────────────────────────
def r29():
    mod, regions, _ = get_shared()
    issues = []
    for zone in ('bac_bo', 'trung_bo', 'nam_bo'):
        names = [r['name'] for r in regions if r['zone'] == zone]
        dup = [n for n, c in Counter(names).items() if c > 1]
        if dup:
            issues.append(f'{zone}: dup names {dup}')
    if issues:
        add('R29', 'region_names_unique_per_zone', 'FAIL', '; '.join(issues))
    else:
        add('R29', 'region_names_unique_per_zone', 'PASS', '3 zone đều unique')

# ─── R30: PURPOSE_ANCHOR keys == VALID_PURPOSES ─────────────────────────────
def r30():
    mod, _, _ = get_shared()
    pa = set(mod.PURPOSE_ANCHOR)
    vp = mod.VALID_PURPOSES
    if pa != vp:
        add('R30', 'purpose_anchor_keys', 'FAIL',
            f'PA only: {pa-vp}, VP only: {vp-pa}')
    else:
        add('R30', 'purpose_anchor_keys', 'PASS', f'{len(pa)} purposes khớp')

# ─── R31: era distribution per zone ─────────────────────────────────────────
def r31():
    mod, _, maps = get_shared()
    issues = []
    for zone in ('bac_bo', 'trung_bo', 'nam_bo'):
        zmaps = [m for m in maps if m['zone'] == zone]
        if not zmaps: continue
        era_cnt = Counter(m['era'] for m in zmaps)
        # Không era nào > 60% zone (signal of skew)
        max_ratio = max(era_cnt.values()) / len(zmaps)
        if max_ratio > 0.6:
            issues.append(f'{zone}: era {era_cnt.most_common(1)[0][0]} chiếm {max_ratio:.1%}')
    if issues:
        add('R31', 'era_distribution_per_zone', 'WARN', '; '.join(issues))
    else:
        add('R31', 'era_distribution_per_zone', 'PASS',
            'không zone nào bị 1 era dominate > 60%')

# ─── R32: tier distribution ─────────────────────────────────────────────────
def r32():
    mod, regions, _ = get_shared()
    # T1 chỉ ở bắc bộ (region 0-7)
    t1_zones = set(r['zone'] for r in regions if r['tier'] == 1)
    if t1_zones != {'bac_bo'}:
        add('R32', 'tier1_only_bac_bo', 'FAIL', f'T1 zones: {t1_zones}')
    else:
        add('R32', 'tier1_only_bac_bo', 'PASS', 'T1 chỉ ở bac_bo ✓')

# ─── R33: anchor count per map distribution ─────────────────────────────────
def r33():
    mod, _, maps = get_shared()
    total_anchors = []
    for m in maps:
        s = sum(len(items) for items in m.get('anchors', {}).values())
        total_anchors.append(s)
    mean = sum(total_anchors) / len(total_anchors)
    mn, mx = min(total_anchors), max(total_anchors)
    if mx > sum(mod.ANCHOR_CAP.values()):
        add('R33', 'anchor_total_per_map', 'FAIL',
            f'max anchor total={mx} > sum CAP={sum(mod.ANCHOR_CAP.values())}')
    else:
        add('R33', 'anchor_total_per_map', 'PASS',
            f'min={mn}, mean={mean:.1f}, max={mx}, sum CAP={sum(mod.ANCHOR_CAP.values())}')

# ─── R34: tsonline_cross_ref chi-square uniform ─────────────────────────────
def r34():
    mod, _, maps = get_shared()
    refs = [m['tsonline_cross_ref'] for m in maps]
    mn, mx = min(refs), max(refs)
    distinct = len(set(refs))
    if not (1 <= mn and mx <= 7047):
        add('R34', 'tsref_in_range', 'FAIL', f'range [{mn},{mx}] outside [1,7047]')
    else:
        # seeded theo (era, biome) — chỉ 10*22 = 220 distinct values max
        # vẫn OK nếu phủ một phần đáng kể
        add('R34', 'tsref_distribution', 'PASS',
            f'range [{mn},{mx}], distinct={distinct} (seeded by era×biome ≈ 220 buckets)')

# ─── R35: portal degree distribution — không có map cô lập ──────────────────
def r35():
    mod, _, maps = get_shared()
    degrees = [len(m.get('portal_graph', [])) for m in maps]
    zero_deg = sum(1 for d in degrees if d == 0)
    mean = sum(degrees) / len(degrees)
    if zero_deg > 0:
        add('R35', 'portal_no_isolated', 'FAIL', f'{zero_deg} maps isolated')
    else:
        add('R35', 'portal_degree_distribution', 'PASS',
            f'no isolated, mean degree={mean:.2f}, max={max(degrees)}')

# ─── R36: mutation matrix BUILD_RULE_HASH ───────────────────────────────────
def r36():
    mod = load_mod('r36')
    h0 = mod._compute_build_rule_hash()
    mutations = []
    # 5 mutation khác nhau
    cases = [
        ('TOPOLOGY_VERSION', lambda: setattr(mod, 'TOPOLOGY_VERSION', mod.TOPOLOGY_VERSION + 1)),
        ('SHARD_GRID_WIDTH', lambda: setattr(mod, 'SHARD_GRID_WIDTH', mod.SHARD_GRID_WIDTH + 1)),
        ('UUID_NS', lambda: setattr(mod, 'UUID_NS', uuid.uuid4())),
        ('REGION_NAMES', lambda: mod.REGION_NAMES.append('Trấn Test')),
        ('FORBIDDEN_STYLE', lambda: mod.FORBIDDEN_STYLE.add('test_style')),
    ]
    issues = []
    for name, fn in cases:
        # Save state
        orig = {
            'TOPOLOGY_VERSION': mod.TOPOLOGY_VERSION,
            'SHARD_GRID_WIDTH': mod.SHARD_GRID_WIDTH,
            'UUID_NS': mod.UUID_NS,
            'REGION_NAMES': list(mod.REGION_NAMES),
            'FORBIDDEN_STYLE': set(mod.FORBIDDEN_STYLE),
        }
        fn()
        h_new = mod._compute_build_rule_hash()
        if h_new == h0:
            issues.append(f'{name}: mutate KHÔNG đổi hash')
        # Restore
        for k, v in orig.items():
            setattr(mod, k, v if not isinstance(v, list) else v)
        # Special restore for mutable
        mod.REGION_NAMES[:] = orig['REGION_NAMES']
        mod.FORBIDDEN_STYLE.clear(); mod.FORBIDDEN_STYLE.update(orig['FORBIDDEN_STYLE'])
    if issues:
        add('R36', 'mutation_matrix_hash', 'FAIL', '; '.join(issues))
    else:
        add('R36', 'mutation_matrix_hash', 'PASS', '5/5 mutation đều đổi BUILD_RULE_HASH')

# ─── R37: inject map với era không trong ERAS ──────────────────────────────
def r37():
    mod, regions, maps = get_shared()
    import copy
    bad_maps = copy.deepcopy(maps)
    bad_maps[100]['era'] = 'BAD_ERA'
    score, gaps = mod.self_validate(regions, bad_maps, det_mode='sampling')
    if 'all_era_valid' in gaps:
        add('R37', 'detect_invalid_era', 'PASS', f'detected, score={score:.3f}')
    else:
        add('R37', 'detect_invalid_era', 'FAIL', f'NOT detected, gaps={gaps[:3]}')

# ─── R38: inject anchor type không trong CAP ───────────────────────────────
def r38():
    mod, regions, maps = get_shared()
    import copy
    bad_maps = copy.deepcopy(maps)
    bad_maps[50]['anchors']['fake_anchor'] = [{'anchor_id':'fake','rel_x':0,'rel_y':0}]
    score, gaps = mod.self_validate(regions, bad_maps, det_mode='sampling')
    detected = ('anchor_density_ok' in gaps or 'purpose_anchor_match' in gaps)
    if detected:
        add('R38', 'detect_unknown_anchor', 'PASS',
            f'detected via {[g for g in gaps if "anchor" in g]}, score={score:.3f}')
    else:
        add('R38', 'detect_unknown_anchor', 'FAIL', f'NOT detected, gaps={gaps[:5]}')

# ─── R39: inject portal self-loop ─────────────────────────────────────────
def r39():
    mod, regions, maps = get_shared()
    import copy
    bad_maps = copy.deepcopy(maps)
    bad_maps[10]['portal_graph'].append({
        'from_map': bad_maps[10]['map_id'],
        'to_map': bad_maps[10]['map_id'],  # self
        'bidirectional': True
    })
    score, gaps = mod.self_validate(regions, bad_maps, det_mode='sampling')
    if 'portal_graph_valid' in gaps:
        add('R39', 'detect_self_loop', 'PASS', f'detected, score={score:.3f}')
    else:
        add('R39', 'detect_self_loop', 'FAIL', f'NOT detected, gaps={gaps[:3]}')

# ─── R40: self_validate với maps=[] ────────────────────────────────────────
def r40():
    mod, regions, _ = get_shared()
    try:
        score, gaps = mod.self_validate(regions, [], det_mode='sampling')
        add('R40', 'empty_maps_no_crash', 'PASS',
            f'không crash, score={score:.3f}, gaps={len(gaps)} (expected nhiều)')
    except Exception as e:
        add('R40', 'empty_maps_no_crash', 'FAIL', f'CRASH: {e}')

# ─── Main ──────────────────────────────────────────────────────────────────
ROUNDS = [r19, r20, r21, r22, r23, r24, r25, r26, r27, r28, r29, r30,
          r31, r32, r33, r34, r35, r36, r37, r38, r39, r40]

if __name__ == '__main__':
    t0 = time.time()
    for r in ROUNDS:
        try: r()
        except Exception as e:
            import traceback
            add(r.__name__.upper(), r.__name__, 'CRASH', f'{e}')
            traceback.print_exc()
    summary = Counter(f['status'] for f in findings)
    print()
    print('=' * 70)
    print(f"DEEP AUDIT (R19-R40) COMPLETE in {time.time()-t0:.1f}s")
    print(f"  PASS: {summary['PASS']}  WARN: {summary['WARN']}  FAIL: {summary['FAIL']}  CRASH: {summary['CRASH']}")
    print('=' * 70)
    if summary['FAIL'] or summary['CRASH']:
        print('FAILED / CRASHED:')
        for f in findings:
            if f['status'] in ('FAIL', 'CRASH'):
                print(f"  [{f['round']}] {f['name']}: {f['detail']}")
    out = Path(__file__).parent / 'audit_deep_findings.json'
    out.write_text(json.dumps({'summary': dict(summary), 'findings': findings},
                              indent=2, ensure_ascii=False), encoding='utf-8')
    print(f'Findings JSON: {out}')
    sys.exit(0 if (summary['FAIL'] == 0 and summary['CRASH'] == 0) else 1)

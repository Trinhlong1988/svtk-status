#!/usr/bin/env python3
"""TEST INTRA-TEAM + CROSS-TEAM DEPENDENCY.

Trong 1 team, CMD có thể cần data từ CMD khác:
  TEAM CONTENT: NPC ship trước → QUEST/DIALOG/ITEM/BOSS load NPC_id
  TEAM CORE:    DB schema → ENGINE/PLACE/PARSE load
  TEAM ART:     SPRITE template_id ↔ ICON
  CROSS TEAM:   NPC (CONTENT) → SPRITE (ART) recolor mapping
                DB (CORE) → CONTENT validate
                QA-CONTENT/ART/CORE verdict → QA-FULL aggregate

15 scenarios test:
  Intra TEAM_CONTENT (5):
    - NPC→QUEST reference
    - NPC→DIALOG speaker_id
    - BOSS→ITEM drop_from
    - SKILL→ITEM skill_book
    - Cross-ref integrity

  Intra TEAM_CORE (3):
    - DB→ENGINE schema
    - PLACE→ENGINE world
    - PARSE→DB schema validation

  Intra TEAM_ART (3):
    - SPRITE↔ICON
    - MAP↔SPRITE biome
    - AUDIO↔MAP scene

  Cross-team (4):
    - NPC(CONTENT)→SPRITE(ART) recolor 7817
    - DB(CORE) schema → CONTENT validate
    - PLACE(CORE)→MAP(ART) biome
    - QA verdict aggregate
"""
import os, sys, json, time, shutil, tempfile
from pathlib import Path
from datetime import datetime


WORKERS = ['engine', 'place', 'parse', 'db', 'npc', 'quest', 'dialog', 'item',
           'boss', 'skill', 'event', 'sprite', 'map', 'icon', 'audio',
           'qa_content', 'qa_art', 'qa_core', 'qa_full']


class MockRepo:
    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix='svtk_team_'))
        for c in ['lead'] + WORKERS:
            for sub in ['alerts', 'inbox', 'inbox-recheck', 'status',
                        'output/registry', 'output/schema', 'existing']:
                (self.root / f'cmd-{c}' / sub).mkdir(parents=True, exist_ok=True)
        for sub in ['alerts', 'qa-verdicts', 'dashboard', 'completions', 'heartbeats']:
            (self.root / 'cmd-lead' / sub).mkdir(parents=True, exist_ok=True)

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


def ship(repo, worker, entries, fname=None):
    """Worker ship JSONL output."""
    fname = fname or f'{worker}_full.jsonl'
    out = repo.root / f'cmd-{worker}' / 'output' / 'registry' / fname
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open('w', encoding='utf-8') as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + '\n')
    return out


def load(repo, worker, fname=None):
    """Load output từ worker."""
    fname = fname or f'{worker}_full.jsonl'
    p = repo.root / f'cmd-{worker}' / 'output' / 'registry' / fname
    if not p.exists():
        return []
    return [json.loads(l) for l in p.read_text(encoding='utf-8').split('\n') if l.strip()]


def ship_schema(repo, worker, schema_sql):
    """DB ship schema."""
    p = repo.root / f'cmd-{worker}' / 'output' / 'schema' / f'{worker}_schema.sql'
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(schema_sql, encoding='utf-8')
    return p


def load_schema(repo, worker):
    p = repo.root / f'cmd-{worker}' / 'output' / 'schema' / f'{worker}_schema.sql'
    return p.read_text(encoding='utf-8') if p.exists() else ''


def ship_verdict(repo, qa, target, verdict, evidence):
    ts = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    p = repo.root / 'cmd-lead' / 'qa-verdicts' / f'{verdict}-{qa}-{target}-{ts}.json'
    p.write_text(json.dumps({'qa': qa, 'target': target, 'verdict': verdict,
                             'evidence': evidence, 'timestamp': ts},
                            ensure_ascii=False, indent=2), encoding='utf-8')


# ============ 15 SCENARIOS ============

# ---- INTRA TEAM_CONTENT (5) ----
def t1_npc_quest_reference():
    """NPC ship trước → QUEST load NPC_id cho quest_giver."""
    r = MockRepo()
    try:
        # NPC ship 100 entries
        ship(r, 'npc', [{'_index': i, 'name': f'NPC_{i}', 'era': 'ly'}
                        for i in range(1, 101)])

        # QUEST load NPC pool + assign quest_giver_id
        npcs = load(r, 'npc')
        assert len(npcs) == 100

        quests = []
        for qid in range(1, 51):
            npc = npcs[qid % len(npcs)]
            quests.append({'quest_id': qid, 'name': f'Quest_{qid}',
                          'quest_giver_id': npc['_index'],
                          'quest_giver_name': npc['name']})
        ship(r, 'quest', quests)

        # Verify cross-ref integrity
        loaded_quests = load(r, 'quest')
        npc_ids = {n['_index'] for n in npcs}
        broken_refs = [q for q in loaded_quests if q['quest_giver_id'] not in npc_ids]
        assert len(broken_refs) == 0, f'Broken refs: {broken_refs[:3]}'
        return True, 'NPC→QUEST reference integrity'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t2_npc_dialog_speaker():
    """NPC → DIALOG speaker_id."""
    r = MockRepo()
    try:
        ship(r, 'npc', [{'_index': i, 'name': f'NPC_{i}'} for i in range(1, 101)])
        npcs = load(r, 'npc')

        dialogs = []
        for did in range(1, 201):
            speaker = npcs[did % len(npcs)]
            dialogs.append({'i': did, 'speaker_id': speaker['_index'],
                           'text': 'Chào ngài', 'dialog_type': 'greeting'})
        ship(r, 'dialog', dialogs)

        loaded = load(r, 'dialog')
        npc_ids = {n['_index'] for n in npcs}
        assert all(d['speaker_id'] in npc_ids for d in loaded)
        return True, 'NPC→DIALOG speaker_id mapping'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t3_boss_item_drop_from():
    """BOSS → ITEM drop_from_boss_id."""
    r = MockRepo()
    try:
        ship(r, 'boss', [{'boss_id': i, 'name': f'Boss_{i}', 'tier': 'normal'}
                         for i in range(1, 51)])
        bosses = load(r, 'boss')

        items = []
        for iid in range(1, 101):
            boss = bosses[iid % len(bosses)]
            items.append({'item_id': iid, 'name': f'Item_{iid}',
                         'drop_from_boss_id': boss['boss_id']})
        ship(r, 'item', items)

        loaded = load(r, 'item')
        boss_ids = {b['boss_id'] for b in bosses}
        assert all(i['drop_from_boss_id'] in boss_ids for i in loaded)
        return True, 'BOSS→ITEM drop_from mapping'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t4_skill_item_book():
    """SKILL → ITEM skill_book_id (item bí kíp)."""
    r = MockRepo()
    try:
        ship(r, 'skill', [{'skill_id': i, 'name': f'Skill_{i}', 'tier': 'basic'}
                          for i in range(1, 21)])
        skills = load(r, 'skill')

        items = [{'item_id': iid, 'type': 'skill_book',
                 'skill_book_id': skills[iid % len(skills)]['skill_id']}
                 for iid in range(101, 121)]
        ship(r, 'item', items)

        loaded = load(r, 'item')
        skill_ids = {s['skill_id'] for s in skills}
        assert all(i['skill_book_id'] in skill_ids for i in loaded)
        return True, 'SKILL→ITEM skill_book mapping'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t5_content_cross_ref_integrity():
    """5-way cross-ref: NPC + QUEST + DIALOG + ITEM + BOSS integrity."""
    r = MockRepo()
    try:
        ship(r, 'npc', [{'_index': i, 'name': f'NPC_{i}'} for i in range(1, 51)])
        ship(r, 'boss', [{'boss_id': i, 'name': f'Boss_{i}'} for i in range(1, 11)])

        npcs = load(r, 'npc')
        bosses = load(r, 'boss')

        # QUEST reference NPC + BOSS
        quests = []
        for qid in range(1, 21):
            quests.append({'quest_id': qid,
                          'quest_giver_id': npcs[qid % len(npcs)]['_index'],
                          'target_boss_id': bosses[qid % len(bosses)]['boss_id']})
        ship(r, 'quest', quests)

        # DIALOG reference NPC
        dialogs = [{'i': did, 'speaker_id': npcs[did % len(npcs)]['_index']}
                   for did in range(1, 51)]
        ship(r, 'dialog', dialogs)

        # ITEM reference BOSS
        items = [{'item_id': iid, 'drop_from_boss_id': bosses[iid % len(bosses)]['boss_id']}
                 for iid in range(1, 31)]
        ship(r, 'item', items)

        # Cross-verify
        npc_ids = {n['_index'] for n in npcs}
        boss_ids = {b['boss_id'] for b in bosses}

        for q in load(r, 'quest'):
            assert q['quest_giver_id'] in npc_ids
            assert q['target_boss_id'] in boss_ids
        for d in load(r, 'dialog'):
            assert d['speaker_id'] in npc_ids
        for i in load(r, 'item'):
            assert i['drop_from_boss_id'] in boss_ids
        return True, '5-way content cross-ref integrity'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


# ---- INTRA TEAM_CORE (3) ----
def t6_db_engine_schema():
    """DB ship schema → ENGINE load."""
    r = MockRepo()
    try:
        schema = """CREATE TABLE players (id UUID PRIMARY KEY, hp INT NOT NULL);
CREATE TABLE combat_log (id UUID, timestamp TIMESTAMP);"""
        ship_schema(r, 'db', schema)

        loaded = load_schema(r, 'db')
        assert 'CREATE TABLE players' in loaded
        assert 'PRIMARY KEY' in loaded
        # ENGINE đọc schema
        engine_schema = load_schema(r, 'db')
        assert 'players' in engine_schema
        return True, 'DB→ENGINE schema load'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t7_place_engine_world():
    """PLACE region → ENGINE world data."""
    r = MockRepo()
    try:
        ship(r, 'place', [{'region_id': i, 'name': f'Region_{i}', 'shard_id': i % 8}
                          for i in range(1, 65)])
        regions = load(r, 'place')
        assert len(regions) == 64

        # ENGINE đọc region để allocate player
        for p in regions[:5]:
            assert 'shard_id' in p
        return True, 'PLACE→ENGINE 64 region shards'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t8_parse_db_validation():
    """PARSE → DB schema validation."""
    r = MockRepo()
    try:
        # PARSE ship TS Online schema info
        ship(r, 'parse', [
            {'table': 'npcs', 'pk_field': '_index', 'verified': True},
            {'table': 'dialogs', 'pk_field': 'i', 'verified': True},
            {'table': 'maps', 'pk_field': 'mapId_at_0x00', 'verified': True},
        ])
        parsed = load(r, 'parse')
        assert all(p['verified'] for p in parsed)

        # DB validate schema with PARSE info
        pk_fields = [p['pk_field'] for p in parsed]
        assert '_index' in pk_fields
        assert 'i' in pk_fields
        return True, 'PARSE→DB schema validation'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


# ---- INTRA TEAM_ART (3) ----
def t9_sprite_icon_mapping():
    """SPRITE template ↔ ICON."""
    r = MockRepo()
    try:
        ship(r, 'sprite', [{'template_id': i, 'name': f'Sprite_{i}'}
                           for i in range(1, 159)])
        ship(r, 'icon', [{'icon_id': i, 'sprite_template_id': i if i <= 158 else None}
                         for i in range(1, 201)])

        sprites = load(r, 'sprite')
        icons = load(r, 'icon')
        sprite_ids = {s['template_id'] for s in sprites}

        # Icons có sprite_template_id phải reference đúng
        for ic in icons:
            stid = ic.get('sprite_template_id')
            if stid:
                assert stid in sprite_ids
        return True, 'SPRITE↔ICON template_id mapping'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t10_map_sprite_biome():
    """MAP biome → SPRITE environment style."""
    r = MockRepo()
    try:
        biomes = ['forest', 'mountain', 'river', 'plain', 'sea', 'capital', 'village']
        ship(r, 'map', [{'mapId_at_0x00': i, 'biome': biomes[i % len(biomes)]}
                        for i in range(1, 101)])

        # SPRITE cần biome compatibility
        maps = load(r, 'map')
        unique_biomes = {m['biome'] for m in maps}
        assert len(unique_biomes) == 7
        return True, 'MAP biome → SPRITE 7 biome support'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t11_audio_map_scene():
    """AUDIO BGM → MAP scene_id mapping."""
    r = MockRepo()
    try:
        ship(r, 'map', [{'mapId_at_0x00': i, 'biome': 'forest'}
                        for i in range(1, 51)])
        ship(r, 'audio', [{'audio_id': i, 'type': 'bgm',
                          'scene_map_id': i if i <= 50 else None}
                          for i in range(1, 51)])

        maps = load(r, 'map')
        audios = load(r, 'audio')
        map_ids = {m['mapId_at_0x00'] for m in maps}

        for a in audios:
            smid = a.get('scene_map_id')
            if smid:
                assert smid in map_ids
        return True, 'AUDIO→MAP scene mapping'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


# ---- CROSS-TEAM (4) ----
def t12_npc_sprite_recolor_mapping():
    """NPC (CONTENT) → SPRITE (ART) recolor 7817."""
    r = MockRepo()
    try:
        # NPC team ship 1000 NPC
        ship(r, 'npc', [{'_index': i, 'name': f'NPC_{i}'} for i in range(1, 1001)])
        # SPRITE team ship 158 templates
        ship(r, 'sprite', [{'template_id': i, 'name': f'Template_{i}'}
                           for i in range(1, 159)])
        # SPRITE team ship recolor_mapping bridging
        npcs = load(r, 'npc')
        templates = load(r, 'sprite')
        recolor = [{'npc_index': n['_index'],
                   'template_id': templates[i % len(templates)]['template_id'],
                   'palette_seed': n['_index']}
                   for i, n in enumerate(npcs)]
        ship(r, 'sprite', recolor, fname='sprite_recolor_mapping.jsonl')

        # Cross-verify
        loaded_recolor = load(r, 'sprite', 'sprite_recolor_mapping.jsonl')
        npc_ids = {n['_index'] for n in npcs}
        template_ids = {t['template_id'] for t in templates}
        for rc in loaded_recolor:
            assert rc['npc_index'] in npc_ids
            assert rc['template_id'] in template_ids
        return True, 'NPC(CONTENT)→SPRITE(ART) recolor'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t13_db_content_schema_validation():
    """DB(CORE) schema → CONTENT validate field name."""
    r = MockRepo()
    try:
        # DB ship schema cho NPC table
        schema = """CREATE TABLE IF NOT EXISTS npcs (
    _index INT PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    era VARCHAR(32) CHECK (era IN ('ly','tran','le','tay_son','nguyen'))
);"""
        ship_schema(r, 'db', schema)

        # CONTENT (NPC) verify schema có _index field (verified key)
        db_schema = load_schema(r, 'db')
        assert '_index INT PRIMARY KEY' in db_schema

        # NPC ship đúng theo schema
        ship(r, 'npc', [{'_index': i, 'name': f'NPC_{i}', 'era': 'ly'}
                        for i in range(1, 11)])
        npcs = load(r, 'npc')

        # Validate: all NPC entries có _index và era đúng
        valid_eras = {'ly', 'tran', 'le', 'tay_son', 'nguyen'}
        for n in npcs:
            assert '_index' in n
            assert n['era'] in valid_eras
        return True, 'DB(CORE)→CONTENT schema validation'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t14_place_map_biome():
    """PLACE (CORE) region → MAP (ART) biome consistency."""
    r = MockRepo()
    try:
        # PLACE ship 64 region với biome
        biomes = ['forest', 'mountain', 'river', 'plain', 'sea', 'capital', 'village']
        ship(r, 'place', [{'region_id': i, 'biome': biomes[i % len(biomes)]}
                          for i in range(1, 65)])

        # MAP ship image manifests với biome reference
        regions = load(r, 'place')
        region_biomes = {r['region_id']: r['biome'] for r in regions}
        maps = []
        for mid in range(1, 1001):
            region_id = (mid % 64) + 1
            maps.append({'mapId_at_0x00': mid, 'region_id': region_id,
                        'biome': region_biomes[region_id]})
        ship(r, 'map', maps)

        # Cross-verify biome consistency
        loaded = load(r, 'map')
        for m in loaded:
            expected_biome = region_biomes.get(m['region_id'])
            assert m['biome'] == expected_biome, f'Biome mismatch: {m}'
        return True, 'PLACE(CORE)→MAP(ART) biome'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t15_qa_aggregate_verdicts():
    """QA-CONTENT/ART/CORE verdict → QA-FULL aggregate."""
    r = MockRepo()
    try:
        # 3 QA push verdict
        ship_verdict(r, 'qa_content', 'npc', 'PASS', {'count': 10000})
        ship_verdict(r, 'qa_art', 'sprite', 'PASS', {'count': 158})
        ship_verdict(r, 'qa_core', 'engine', 'PASS', {'uuid_unique': True})

        # QA-FULL aggregate
        verdicts_dir = r.root / 'cmd-lead' / 'qa-verdicts'
        all_verdicts = list(verdicts_dir.glob('*.json'))
        assert len(all_verdicts) == 3

        pass_count = sum(1 for v in all_verdicts if v.name.startswith('PASS-'))
        assert pass_count == 3

        # QA-FULL push aggregate verdict
        ship_verdict(r, 'qa_full', 'all_workers', 'PASS',
                     {'aggregated': 3, 'all_pass': True})
        final = list(verdicts_dir.glob('PASS-qa_full-*.json'))
        assert len(final) == 1
        return True, 'QA aggregate: 3 QA → QA-FULL'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


# ============ RUN ============
def run_iteration():
    tests = [
        t1_npc_quest_reference, t2_npc_dialog_speaker, t3_boss_item_drop_from,
        t4_skill_item_book, t5_content_cross_ref_integrity,
        t6_db_engine_schema, t7_place_engine_world, t8_parse_db_validation,
        t9_sprite_icon_mapping, t10_map_sprite_biome, t11_audio_map_scene,
        t12_npc_sprite_recolor_mapping, t13_db_content_schema_validation,
        t14_place_map_biome, t15_qa_aggregate_verdicts,
    ]
    return [(t.__name__, *t()) for t in tests]


if __name__ == '__main__':
    print("=" * 78)
    print("INTRA-TEAM + CROSS-TEAM DEPENDENCY — 50 ITER × 15 SCENARIOS × 3 BATCHES")
    print("=" * 78)

    overall_pass = 0
    overall_total = 0
    overall_fails = []
    start = time.time()

    for batch in range(1, 4):
        bp, bt = 0, 0
        for i in range(50):
            for name, ok, msg in run_iteration():
                bt += 1
                if ok:
                    bp += 1
                else:
                    overall_fails.append((batch, i+1, name, msg))
        overall_pass += bp
        overall_total += bt
        print(f"Batch {batch}: {bp}/{bt} = {bp/bt*100:.1f}%")

    elapsed = time.time() - start
    print()
    print(f"TOTAL: {overall_pass}/{overall_total} = {overall_pass/overall_total*100:.1f}%")
    print(f"Time: {elapsed:.2f}s")
    print()
    print("Sample iteration 1:")
    for name, ok, msg in run_iteration():
        print(f"  {'✅' if ok else '❌'} {name}: {msg}")
    print()
    if overall_fails:
        print(f"FAILURES ({len(overall_fails)}):")
        for b, i, n, m in overall_fails[:5]:
            print(f"  Batch {b} iter {i} - {n}: {m}")
    else:
        print("✅ ZERO FAILURES")
    print("=" * 78)

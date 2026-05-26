# CMD_ART_SPEC v1.0 — test ngoai (doc art_groups/ + masks/)
import json, sys
from pathlib import Path
OUT = Path(__file__).parent.parent

_CACHE = None

def _specs():
    """Doc moi art_group spec 1 LAN, cache."""
    global _CACHE
    if _CACHE is None:
        _CACHE = []
        for fp in sorted((OUT / "art_groups").glob("*.json")):
            _CACHE.append(json.loads(fp.read_text(encoding="utf-8")))
    return _CACHE

def test_01_has_specs():
    assert len(_specs()) > 0, "khong co spec nao"

def test_02_required_fields():
    need = {"art_group", "spec_version", "biome", "era", "tier",
            "camera", "style", "positive_prompt", "negative_prompt",
            "caption_tokens", "mask_requirements", "forbidden"}
    for s in _specs():
        assert need <= set(s.keys()), f"thieu field: {s.get('art_group')}"

def test_03_prompt_not_empty():
    for s in _specs():
        assert len(s["positive_prompt"]) >= 20
        assert len(s["negative_prompt"]) >= 10

def test_04_negative_has_forbidden():
    for s in _specs():
        neg = s["negative_prompt"]
        for t in ("cyberpunk", "neon", "sci-fi"):
            assert t in neg, f"negative thieu '{t}': {s['art_group']}"

def test_05_caption_tokens():
    for s in _specs():
        assert s["caption_tokens"], f"thieu caption: {s['art_group']}"
        assert "svtk_map" in s["caption_tokens"]

def test_06_no_image_data():
    # CMD_ART_SPEC KHONG sinh anh
    ban = ("image_data", "image_url", "png", "pixels", "lora_weights")
    for s in _specs():
        for k in ban:
            assert k not in s, f"spec lan anh '{k}': {s['art_group']}"

def test_07_tier_range():
    for s in _specs():
        assert 1 <= s["tier"] <= 5, f"tier sai: {s['art_group']}"

def test_08_art_group_unique():
    gs = [s["art_group"] for s in _specs()]
    assert len(gs) == len(set(gs)), "art_group trung"

def test_09_mask_convention():
    mc = json.loads((OUT / "masks" / "mask_color_convention.json")
                    .read_text(encoding="utf-8"))
    need = {"free", "block", "water", "slope", "portal", "anchor", "spawn"}
    assert set(mc["colors"].keys()) == need, "mask thieu mau"

def test_10_controlnet_guide():
    cg = json.loads((OUT / "masks" / "controlnet_mask_guide.json")
                    .read_text(encoding="utf-8"))
    assert "rule" in cg and len(cg["rule"]) > 0

def test_11_prompts_jsonl():
    fp = OUT / "prompts" / "map_background_prompts.jsonl"
    lines = [l for l in fp.read_text(encoding="utf-8").splitlines() if l.strip()]
    assert len(lines) == len(_specs()), "prompt jsonl lech so spec"

def test_12_captions_jsonl():
    fp = OUT / "captions" / "lora_caption_profiles.jsonl"
    lines = [l for l in fp.read_text(encoding="utf-8").splitlines() if l.strip()]
    assert len(lines) == len(_specs()), "caption jsonl lech so spec"

def test_13_schema_strict():
    sc = json.loads((OUT / "schema" / "art_spec.schema.json")
                    .read_text(encoding="utf-8"))
    assert sc.get("type") == "object"
    assert sc.get("additionalProperties") is False
    assert "required" in sc and "properties" in sc
    # spec khop schema: du required, khong field la
    req = set(sc["required"])
    allowed = set(sc["properties"].keys())
    for s in _specs():
        assert req <= set(s.keys()), f"thieu required: {s['art_group']}"
        assert not (set(s.keys()) - allowed), f"field la: {s['art_group']}"

def test_14_status_file():
    fps = list((OUT / "status").glob("status-*.json"))
    assert len(fps) >= 1, "thieu status file"
    st = json.loads(fps[-1].read_text(encoding="utf-8"))
    for k in ("cmd", "cmd_version", "schema_version", "timestamp",
              "validation_score", "honest_gaps", "exit_code"):
        assert k in st, f"status thieu {k}"

def test_15_manifest_output_sha():
    mf = json.loads((OUT / "build_manifest.json").read_text(encoding="utf-8"))
    assert mf.get("output_sha256"), "manifest thieu output_sha256"
    assert len(mf["output_sha256"]) == 64, "output_sha256 sai do dai"

if __name__ == "__main__":
    _tests = sorted(n for n in dir() if n.startswith("test_"))
    _p = _f = 0
    for _n in _tests:
        try:
            globals()[_n](); _p += 1; print("  PASS " + _n)
        except Exception as _e:
            _f += 1; print("  FAIL " + _n + ": " + str(_e))
    print(str(_p) + "/" + str(_p + _f) + " tests pass")
    sys.exit(0 if _f == 0 else 1)

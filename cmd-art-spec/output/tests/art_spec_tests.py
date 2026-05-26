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

# ── B4 — 4 test defense-in-depth (audit 20 round) ──
def test_16_mask_colors_exact():
    """B4 M08 catch: mask color RGB phai khop hard-coded expected."""
    mc = json.loads((OUT / "masks" / "mask_color_convention.json")
                    .read_text(encoding="utf-8"))
    expected = {
        "free":   "#3CB043",
        "block":  "#4A4A4A",
        "water":  "#2E6FB0",
        "slope":  "#C9A227",
        "portal": "#E03C3C",
        "anchor": "#B040C0",
        "spawn":  "#76FF03",
    }
    actual = {k: v["rgb"] for k, v in mc["colors"].items()}
    assert actual == expected, f"mask color drift: {actual} vs {expected}"

def test_17_schema_required_intact():
    """B4 M10 catch: schema required phai chua field cot loi."""
    sc = json.loads((OUT / "schema" / "art_spec.schema.json")
                    .read_text(encoding="utf-8"))
    core = {"art_group", "spec_version", "biome", "era", "tier",
            "positive_prompt", "negative_prompt",
            "caption_tokens", "mask_requirements", "forbidden"}
    assert core <= set(sc.get("required", [])),         f"schema required thieu core: {core - set(sc.get('required',[]))}"

def test_18_art_group_safe_regex():
    """B4 B1 catch: moi art_group phai khop ^[a-z][a-z0-9_]{2,63}$."""
    import re
    safe = re.compile(r"^[a-z][a-z0-9_]{2,63}$")
    for s in _specs():
        assert safe.match(s["art_group"]), f"art_group lan path: {s['art_group']!r}"

def test_19_mask_rgb_distinct():
    """B4 B3 catch: 7 mau Euclidean RGB >= 80 doi cap."""
    import math
    mc = json.loads((OUT / "masks" / "mask_color_convention.json")
                    .read_text(encoding="utf-8"))
    def rgb(h):
        h = h.lstrip("#")
        return int(h[:2],16), int(h[2:4],16), int(h[4:6],16)
    colors = [(k, rgb(v["rgb"])) for k, v in mc["colors"].items()]
    bad = []
    for i in range(len(colors)):
        for j in range(i+1, len(colors)):
            d = math.sqrt(sum((x-y)**2 for x,y in zip(colors[i][1], colors[j][1])))
            if d < 80:
                bad.append((colors[i][0], colors[j][0], round(d,1)))
    assert not bad, f"mask color too close: {bad}"

def test_20_manifest_honest_gap_upstream():
    """B5: manifest must honest-report 3 dropped upstream fields."""
    mf = json.loads((OUT / "build_manifest.json").read_text(encoding="utf-8"))
    drops = mf.get("dropped_upstream_fields", [])
    assert set(drops) >= {"art_prompt", "negative_prompt", "lora_tags"},         f"manifest thieu honest report dropped_upstream_fields: {drops}"
    assert mf.get("dropped_upstream_reason"), "thieu dropped_upstream_reason"

def test_21_lf_line_endings():
    """B2: moi JSON/JSONL output phai LF, khong CRLF (deterministic cross-OS)."""
    crlf = bytes([13, 10])
    for sub, ext in (("art_groups","*.json"), ("prompts","*.jsonl"),
                     ("captions","*.jsonl"), ("masks","*.json"),
                     ("schema","*.json")):
        for fp in (OUT/sub).glob(ext):
            raw = fp.read_bytes()
            assert crlf not in raw, f"CRLF leaked: {fp}"

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

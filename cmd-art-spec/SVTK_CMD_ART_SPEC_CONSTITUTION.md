# 🎨 SVTK — CMD_ART_SPEC CONSTITUTION v1.0

> CMD sau CMD_MAP. Đọc output CMD_MAP → sinh ĐẶC TẢ vẽ map background
> cho LoRA / ControlNet / Artist. KHÔNG sinh ảnh.

## VAI TRÒ

CMD_ART_SPEC biến `art_group` + biome/era/tier + walk_mask/portal/
anchor/spawn_zone của CMD_MAP thành: prompt vẽ, negative prompt,
caption tokens (LoRA dataset), mask color convention, ControlNet guide,
style rule. Đây là TÀI LIỆU ĐẶC TẢ — không phải ảnh.

Câu khóa: **"CMD_MAP là xương. CMD_ART_SPEC là bản vẽ kỹ thuật.
LoRA mới là người thợ vẽ da."**

## 14 ĐIỀU KHÓA

| # | Điều khóa | Nội dung |
|---|---|---|
| 1 | Không sinh ảnh | CMD_ART_SPEC CHỈ sinh spec/prompt/caption/mask-guide. KHÔNG ảnh, KHÔNG gọi image API, KHÔNG train LoRA |
| 2 | Không sinh sprite/NPC | Sprite nhân vật/quái/NPC là việc CMD_SPRITE (CMD riêng, làm sau) |
| 3 | Đọc CMD_MAP, không sửa | Input từ cmd-map/output. KHÔNG sửa walk_mask/portal/anchor/spawn_zone |
| 4 | Không tạo art_group mới | art_group lấy nguyên từ CMD_MAP. KHÔNG bịa nhóm mới |
| 5 | 1 spec / 1 art_group | Mỗi art_group của CMD_MAP -> đúng 1 file đặc tả |
| 6 | DNA readability | Spec phải ép: đường đi rõ, portal rõ, anchor/spawn không bị che. Đây là DNA TS Online |
| 7 | Cultural lock | positive_prompt theo sử Việt. forbidden chặn Hán/Nhật/hiện đại/sci-fi |
| 8 | Không copy TS asset | Spec mô tả phong cách, KHÔNG dẫn chiếu file ảnh TS Online |
| 9 | Caption cho LoRA | caption_tokens chuẩn hoá: prefix + biome + era + tier + readability |
| 10 | Mask convention cố định | Bảng màu mask (walkable/block/portal/anchor/spawn) khoá 1 lần, mọi map dùng chung |
| 11 | Verified, không đoán | Đọc field thật từ layout. Field thiếu -> honest report, KHÔNG bịa |
| 12 | Self-validate | Mỗi build tự kiểm: đủ art_group, prompt hợp lệ, mask đủ màu, forbidden đủ |
| 13 | Foundation first | Verify foundation hash trước. Mismatch -> exit 99 |
| 14 | Push GitHub | Output push repo svtk-status, branch staging. KHÔNG lưu local |

## INPUT

```
cmd-map/output/art_profiles/*.json      -- ~942 nhóm
cmd-map/output/maps/map_*/map_layout.json
cmd-map/output/build_manifest.json
cmd-map/output/schema/map_layouts.sql
```

Field gián tiếp (từ CMD_PLACE, đã trong layout): map_id, uuid,
natural_key, biome, era, tier, zone, safe_zone, art_group, walk_mask,
portal_points, anchor_points, spawn_zones, spawn_zone_status.

KHÔNG đọc NPC registry — CMD_NPC chưa build.

## OUTPUT

```
cmd-art-spec/output/
  art_groups/<art_group>.json          -- 1 spec / nhóm
  prompts/map_background_prompts.jsonl  -- prompt vẽ từng nhóm
  captions/lora_caption_profiles.jsonl  -- caption LoRA dataset
  masks/mask_color_convention.json      -- bảng màu mask
  masks/controlnet_mask_guide.json      -- hướng dẫn ControlNet
  schema/art_spec.schema.json           -- schema validate
  tests/art_spec_tests.py               -- test ngoài
  build_manifest.json
  status/status-<ts>.json
```

## MASK COLOR CONVENTION (điều 10 — khoá)

walk_mask 4 trạng thái -> màu mask cố định (LoRA/ControlNet đọc):

| Trạng thái | Mã | Màu RGB | Ý nghĩa |
|---|---|---|---|
| FREE | 0 | #3CB043 (xanh lá) | ô đi được |
| BLOCK | 1 | #4A4A4A (xám đậm) | vật cản |
| WATER | 2 | #2E6FB0 (xanh dương) | nước |
| SLOPE | 3 | #C9A227 (vàng) | dốc |
| PORTAL | - | #E03C3C (đỏ) | ô cửa di chuyển |
| ANCHOR | - | #B040C0 (tím) | chỗ NPC đứng |
| SPAWN_ZONE | - | #E0902C (cam) | vùng quái |

## QUY TẮC /goal

Viết -> tự audit -> fix tối đa 2 lần. >= 95% -> ship. KHÔNG perfect
100%, KHÔNG ship dở. Decisive khi đủ ngưỡng.

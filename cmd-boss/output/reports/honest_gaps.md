# CMD_BOSS v1.4 Honest Gaps

1. **skill_ids[] = []** — defer wire khi cmd-skill ship registry ≥300 skill. preferred_skills (string names) đã có per archetype + named roster override. (LOW)
2. **Drop table không có** — defer CMD_ITEM wire ngọc drop + reward. (MED)
3. **Spawn coordinates không có** — defer CMD_MAP wire (map_zone abstract chỉ có ở v1.0/v1.1, v1.4 chưa restore). (MED)
4. **Threat manager runtime không có** — defer CMD_ENGINE impl threat_manager + phase_controller + scaling. behavior_tree là DATA, runtime sẽ consume. (HIGH defer)
5. **Path = none cho 1100 generic** — R86 stipulates path là RB3-unlock cho NAMED. Generic boss không có rebirth path (giữ none).
6. **Phase override khi named.phases = phases brief default** — nếu roster named phases khớp tier default thì không thay đổi gì. Phase < tier default sẽ truncate.

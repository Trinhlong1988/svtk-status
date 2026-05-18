-- SVTK Phase 13 Tuần 1 — CMD3 persistence addendum rollback.

BEGIN;
DROP TABLE IF EXISTS save_rate_limit;
DROP TABLE IF EXISTS companion_affinity;
DROP TABLE IF EXISTS progression_snapshots;
COMMIT;

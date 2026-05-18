-- Rollback for 001_init.sql.
-- CASCADE drops FK-dependent rows; intentional for full schema revert.

BEGIN;

DROP TABLE IF EXISTS economy_transactions CASCADE;
DROP TABLE IF EXISTS combat_replays      CASCADE;
DROP TABLE IF EXISTS quest_progress      CASCADE;
DROP TABLE IF EXISTS inventory_items     CASCADE;
DROP TABLE IF EXISTS characters          CASCADE;
DROP TABLE IF EXISTS players             CASCADE;

COMMIT;

-- Rollback CMD2 Week 2 Day 1 — R44 anti-dupe schema
DROP FUNCTION IF EXISTS find_free_inventory_slot(VARCHAR);
DROP TABLE IF EXISTS inventory;
DROP TABLE IF EXISTS currency_change_log;
DROP TABLE IF EXISTS item_transfer_log;
DROP TABLE IF EXISTS item_instances;
DROP TABLE IF EXISTS transaction_log;
DROP TABLE IF EXISTS gm_action_log;
DROP TABLE IF EXISTS pending_actions;
ALTER TABLE players DROP COLUMN IF EXISTS gold;

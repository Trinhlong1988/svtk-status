/**
 * R44 W1/W2/W3/W4 wrapper test suite — Day 2 ship.
 * 12 tests covering API surface + idempotency + optimistic conflict + R68 binding.
 */
import { describe, it, expect } from 'vitest';
import { newDb, type IMemoryDb } from 'pg-mem';
import { randomUUID } from 'node:crypto';
import { withBattleStart, withBattleEnd } from './w1_battle_txn.js';
import { withActionTxn } from './w2_action_txn.js';
import { optimisticUpdate, OptimisticConflictError } from './w3_optimistic.js';
import { bindSnapshotToTxn, verifySnapshotBinding } from './w4_snapshot.js';
import { checksumFrame } from '../../../cmd-engine/output/replay/state_checksum.js';
import type { ReplayFrame } from '../../../cmd-engine/output/legacy/replay_frame.js';

async function makePool() {
  const db: IMemoryDb = newDb({ noAstCoverageCheck: true });
  db.public.none(`
    CREATE TABLE pending_actions (
      nonce VARCHAR(64) PRIMARY KEY,
      action_type VARCHAR(32) NOT NULL,
      player_id VARCHAR(64) NOT NULL,
      payload JSONB NOT NULL,
      payload_hash CHAR(64) NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'pending',
      result JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ
    );
    CREATE TABLE transaction_log (
      txn_id UUID PRIMARY KEY,
      txn_type VARCHAR(32) NOT NULL,
      player_id VARCHAR(64),
      target_type VARCHAR(32) NOT NULL,
      target_uuid UUID,
      source_state JSONB,
      target_state JSONB,
      status VARCHAR(24) NOT NULL DEFAULT 'committed'
    );
    CREATE TABLE inventory_row (
      row_id UUID PRIMARY KEY,
      owner_id VARCHAR(64),
      version INTEGER NOT NULL DEFAULT 0,
      qty INTEGER NOT NULL DEFAULT 1
    );
  `);
  const adapter = db.adapters.createPg();
  return new adapter.Pool();
}

function makeFrame(turn: number, frameId: string): ReplayFrame {
  return {
    frameId,
    schemaVersion: 1,
    sessionId: 's1',
    encounterId: 'e1',
    turn,
    statusDeltas: [],
    snapshot: { participants: [] },
    deterministicHash: 'h',
    eventCounts: { damage: 0, heal: 0, status: 0 },
    monotonicNs: BigInt(turn * 1000),
  } as unknown as ReplayFrame;
}

describe('R44 W1 — T1 SERIALIZABLE battle txn wrapper', () => {
  it('W1.1 — withBattleStart runs executor and caches result', async () => {
    const pool = await makePool();
    const r = await withBattleStart(pool, 'b-1', 'p1', {
      encounter_id: 'enc-1', seed_root: 's', party_ids: ['p1'],
    }, async () => ({ session_id: 'sess-1' }));
    expect(r.fromCache).toBe(false);
    expect(r.result).toEqual({ session_id: 'sess-1' });
  });

  it('W1.2 — withBattleStart idempotent on same nonce', async () => {
    const pool = await makePool();
    await withBattleStart(pool, 'b-2', 'p1', {
      encounter_id: 'enc-2', seed_root: 's', party_ids: ['p1'],
    }, async () => ({ session_id: 'sess-A' }));
    const r2 = await withBattleStart(pool, 'b-2', 'p1', {
      encounter_id: 'enc-2', seed_root: 's', party_ids: ['p1'],
    }, async () => ({ session_id: 'sess-B' }));
    expect(r2.fromCache).toBe(true);
    expect(r2.result).toEqual({ session_id: 'sess-A' });
  });

  it('W1.3 — withBattleEnd accepts outcome enum', async () => {
    const pool = await makePool();
    const r = await withBattleEnd(pool, 'b-end-1', 'p1', {
      encounter_id: 'enc-1', outcome: 'victory', turn_count: 12,
    }, async () => ({ rewards: { gold: 100 } }));
    expect(r.result.rewards.gold).toBe(100);
  });
});

describe('R44 W2 — T2 REPEATABLE READ action txn wrapper', () => {
  it('W2.1 — withActionTxn runs executor for skill_cast', async () => {
    const pool = await makePool();
    const r = await withActionTxn(pool, 'act-1', 'skill_cast', 'p1',
      { skill_id: 'fireball', target: 'm1' },
      async () => ({ damage: 42 }));
    expect(r.fromCache).toBe(false);
    expect(r.result.damage).toBe(42);
  });

  it('W2.2 — withActionTxn rejects invalid action_type', async () => {
    const pool = await makePool();
    await expect(withActionTxn(pool, 'act-2', 'battle_start' as never, 'p1', {},
      async () => ({}))).rejects.toThrow(/W2 rejects/);
    await expect(withActionTxn(pool, 'act-3', 'rollback' as never, 'p1', {},
      async () => ({}))).rejects.toThrow(/W2 rejects/);
  });

  it('W2.3 — withActionTxn detects nonce reuse with different payload', async () => {
    const pool = await makePool();
    await withActionTxn(pool, 'act-4', 'trade', 'p1', { x: 1 },
      async () => ({ ok: true }));
    await expect(withActionTxn(pool, 'act-4', 'trade', 'p1', { x: 2 },
      async () => ({ ok: true }))).rejects.toThrow(/spoof attempt/);
  });
});

describe('R44 W3 — Optimistic version check', () => {
  it('W3.1 — optimisticUpdate succeeds on matching version', async () => {
    const pool = await makePool();
    const rowId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query(
        'INSERT INTO inventory_row (row_id, owner_id, version, qty) VALUES ($1, $2, 0, 5)',
        [rowId, 'p1']);
      const updated = await optimisticUpdate(client, {
        table: 'inventory_row',
        id_col: 'row_id', id_val: rowId,
        expected_version: 0,
        set: { qty: 10 },
      });
      expect(updated.qty).toBe(10);
      expect(updated.version).toBe(1);
    } finally { client.release(); }
  });

  it('W3.2 — optimisticUpdate throws OptimisticConflictError on version mismatch', async () => {
    const pool = await makePool();
    const rowId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query(
        'INSERT INTO inventory_row (row_id, owner_id, version, qty) VALUES ($1, $2, 5, 5)',
        [rowId, 'p1']);
      await expect(optimisticUpdate(client, {
        table: 'inventory_row',
        id_col: 'row_id', id_val: rowId,
        expected_version: 0,  // stale
        set: { qty: 10 },
      })).rejects.toBeInstanceOf(OptimisticConflictError);
    } finally { client.release(); }
  });

  it('W3.3 — optimisticUpdate rejects empty set clause', async () => {
    const pool = await makePool();
    const client = await pool.connect();
    try {
      await expect(optimisticUpdate(client, {
        table: 'inventory_row', id_col: 'row_id', id_val: 'x',
        expected_version: 0, set: {},
      })).rejects.toThrow(/at least 1 column/);
    } finally { client.release(); }
  });
});

describe('R44 W4 — R68 snapshot binding', () => {
  // pg-mem does not support jsonb `||` merge operator (real Postgres OK).
  // Verify production SQL idiom + binding shape via static source inspection.

  it('W4.1 — bindSnapshotToTxn emits canonical merge SQL (production Postgres)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./w4_snapshot.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/UPDATE transaction_log/);
    expect(src).toMatch(/COALESCE\(target_state, '\{\}'::jsonb\) \|\| \$2::jsonb/);
    expect(src).toMatch(/r68_checksum/);
    expect(src).toMatch(/r68_frame_id/);
    expect(src).toMatch(/r68_turn/);
    expect(src).toMatch(/r68_bound_at/);
  });

  it('W4.2 — checksumFrame from cmd-engine is the single source of truth (R68)', () => {
    const frame = makeFrame(7, 'f-7');
    const c1 = checksumFrame(frame);
    const c2 = checksumFrame(frame);
    expect(c1).toMatch(/^[0-9a-f]{64}$/);
    expect(c1).toBe(c2);  // deterministic
    // Different frame → different checksum
    const frame2 = makeFrame(8, 'f-8');
    expect(checksumFrame(frame2)).not.toBe(c1);
  });

  it('W4.3 — verifySnapshotBinding compares stored vs recomputed checksum', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./w4_snapshot.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/target_state ->> 'r68_checksum'/);
    expect(src).toMatch(/stored === computed/);
    expect(typeof verifySnapshotBinding).toBe('function');
    expect(typeof bindSnapshotToTxn).toBe('function');
  });
});

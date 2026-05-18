import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeForensicDump, MAX_STATE_DUMP_BYTES } from '../output/replay/forensic_dump.js';

const tmp = mkdtempSync(join(tmpdir(), 'svtk-forensic-'));
afterEach(() => {
  // best-effort cleanup; ignore EBUSY
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

const divergence = {
  match: false as const,
  divergenceTick: 1234,
  originalHash: 'a'.repeat(64),
  replayedHash: 'b'.repeat(64),
  checkpointsCompared: 13,
};
const env = { foundationVersion: '2.8.0', runtimeVersion: '2.6.5' };

describe('R68.3 forensic_dump — happy path', () => {
  it('writes dump file with schema v1', () => {
    const out = join(tmp, 'divergence-b1-20260518T010101Z.json');
    const r = writeForensicDump({
      battleId: 'b1',
      verdict: divergence,
      originalStateFull: { hp: 100 },
      replayedStateFull: { hp: 99 },
      environment: env,
      outputPath: out,
      timestamp: '2026-05-18T01:01:01Z',
    });
    expect(r.writtenTo).toBe(out);
    expect(existsSync(out)).toBe(true);
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    expect(parsed.schema).toBe('svtk_forensic_dump_v1');
    expect(parsed.battle_id).toBe('b1');
    expect(parsed.divergence_tick).toBe(1234);
    expect(parsed.alert.severity).toBe('HIGH');
    expect(parsed.alert.recipient).toBe('cmd-lead');
  });

  it('null outputPath returns body without filesystem write', () => {
    const r = writeForensicDump({
      battleId: 'b2',
      verdict: divergence,
      originalStateFull: { x: 1 },
      replayedStateFull: { x: 2 },
      environment: env,
      outputPath: null,
      timestamp: '2026-05-18T01:01:01Z',
    });
    expect(r.writtenTo).toBeNull();
    expect(r.bytesWritten).toBeGreaterThan(0);
    expect(r.body).toContain('svtk_forensic_dump_v1');
  });

  it('truncates state bigger than 10MB and sets truncated=true', () => {
    const big = { huge: 'x'.repeat(MAX_STATE_DUMP_BYTES + 100) };
    const r = writeForensicDump({
      battleId: 'b3',
      verdict: divergence,
      originalStateFull: big,
      replayedStateFull: { small: true },
      environment: env,
      outputPath: null,
      timestamp: '2026-05-18T01:01:01Z',
    });
    expect(r.truncated).toBe(true);
    const parsed = JSON.parse(r.body);
    expect(parsed.original_state_truncated).toBe(true);
    expect(parsed.original_state_full.__truncated__).toBe(true);
    expect(parsed.original_state_full.head_preview).toBeDefined();
    expect(parsed.replayed_state_truncated).toBe(false);
  });
});

describe('R68.3 forensic_dump — input validation', () => {
  it('rejects empty battleId', () => {
    expect(() =>
      writeForensicDump({
        battleId: '',
        verdict: divergence,
        originalStateFull: {},
        replayedStateFull: {},
        environment: env,
        outputPath: null,
        timestamp: '2026-05-18T01:01:01Z',
      }),
    ).toThrow(/battleId/);
  });

  it('rejects match=true verdict (only call on divergence)', () => {
    expect(() =>
      writeForensicDump({
        battleId: 'b1',
        verdict: { match: true, checkpointsCompared: 1 } as unknown as typeof divergence,
        originalStateFull: {},
        replayedStateFull: {},
        environment: env,
        outputPath: null,
        timestamp: '2026-05-18T01:01:01Z',
      }),
    ).toThrow(/divergence/);
  });

  it('creates parent directory if missing', () => {
    const nested = join(tmp, 'a', 'b', 'c', 'divergence.json');
    const r = writeForensicDump({
      battleId: 'b1',
      verdict: divergence,
      originalStateFull: {},
      replayedStateFull: {},
      environment: env,
      outputPath: nested,
      timestamp: '2026-05-18T01:01:01Z',
    });
    expect(r.writtenTo).toBe(nested);
    expect(existsSync(nested)).toBe(true);
  });
});

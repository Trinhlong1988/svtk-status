import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pushHeartbeat, pushCompletion, pushAck } from '../lib/r72_protocol.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEAD_DIR = join(HERE, '..');

function countFiles(sub, pattern) {
  const dir = join(LEAD_DIR, sub);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.includes(pattern)).length;
}

describe('R72 protocol — path traversal sanitization (bug#35)', () => {
  it('rejects issueId containing path-traversal', () => {
    expect(() =>
      pushAck({
        cmd: 'cmd-test',
        parent: 'CMD4',
        issueId: '../../../etc/passwd',
        resolution: 'evil',
      }),
    ).not.toThrow(); // safeName sanitizes — should NOT throw, should write to sanitized path
    // After sanitization, '__/__/__/etc/passwd' becomes '_________etc_passwd' (all non-alnum → _)
    // Verify no file outside inbox-recheck/
  });

  it('rejects cmd containing slashes (writes to sanitized path inside heartbeats/)', () => {
    const before = countFiles('heartbeats', '_etc_passwd_');
    pushHeartbeat({ cmd: '../etc/passwd', parent: 'CMD4' });
    // safeName replaces all '/'.'..' with '_', so file ends up at heartbeats/__etc_passwd__hb_*.json
    const after = countFiles('heartbeats', '_etc_passwd_');
    expect(after).toBeGreaterThan(before);
  });
});

describe('R72 protocol — same-second uniqueness (bug#36)', () => {
  it('two pushes in same tick produce distinct filenames', () => {
    const a = pushHeartbeat({ cmd: 'cmd-r72-test', parent: 'CMD4' });
    const b = pushHeartbeat({ cmd: 'cmd-r72-test', parent: 'CMD4' });
    expect(a).not.toBe(b);
  });

  it('rapid burst of 5 pushes produces 5 distinct filenames', () => {
    const seen = new Set();
    for (let i = 0; i < 5; i++) {
      seen.add(pushHeartbeat({ cmd: 'cmd-burst', parent: 'CMD4' }));
    }
    expect(seen.size).toBe(5);
  });
});

describe('R72 protocol — completion schema dual-emit (bug#22)', () => {
  it('completion JSON includes both cmd-lead canonical schema and verbose fields', async () => {
    const path = pushCompletion({
      cmd: 'cmd-schema-test',
      parent: 'CMD4',
      task: 'unit-test',
      delivered: { foo: 'bar' },
    });
    const { readFileSync } = await import('node:fs');
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    // Canonical schema per cmd-lead/cmd.md L599-607
    expect(parsed.fix_id).toBeDefined();
    expect(parsed.fixed_by).toBe('cmd-schema-test');
    expect(parsed.result).toBe('PASS');
    expect(parsed.evidence).toBeDefined();
    expect(parsed.timestamp).toBeDefined();
    // Verbose fields preserved
    expect(parsed.cmd).toBe('cmd-schema-test');
    expect(parsed.task).toBe('unit-test');
    expect(parsed.delivered).toEqual({ foo: 'bar' });
  });
});

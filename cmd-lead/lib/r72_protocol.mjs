/**
 * R72 — Reverse Channel Protocol (Foundation v2.8.0)
 *
 * Reusable Node ESM helpers for sub-CMDs to push heartbeat / completion / ack
 * to cmd-lead. Replaces inline `cat > ... << EOF` JSON write patterns.
 *
 * Usage:
 *   import { pushHeartbeat, pushCompletion, pushAck } from '../cmd-lead/lib/r72_protocol.mjs';
 *   pushHeartbeat({ cmd: 'cmd-network', parent: 'CMD4' });
 *   pushCompletion({ cmd: 'cmd-network', parent: 'CMD4', task: 'Tuần 2 R69 done', delivered: {...} });
 *   pushAck({ cmd: 'cmd-parse', parent: 'CMD4', issueId: 'cmd_parse_stale_foundation_hash', resolution: '...' });
 *
 * All writes are sync (caller doesn't need await). Foundation hash is read
 * dynamically from foundation/INDEX.sha256 so stale-hash alerts don't fire.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const LEAD_DIR = join(REPO_ROOT, 'cmd-lead');

// Audit bug#36: 1-second granularity caused same-second pushes to overwrite.
// Monotonic counter ensures within-second uniqueness even if Date precision
// truncates milliseconds (some OS clocks have ~16ms granularity).
let __tsCounter = 0;
let __tsLast = '';
function nowTs() {
  // ISO compact UTC with millis preserved: 20260518T143125-487Z
  const d = new Date();
  const base = d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('.', '-');
  if (base === __tsLast) {
    __tsCounter += 1;
    return base.replace('Z', `n${__tsCounter}Z`);
  }
  __tsLast = base;
  __tsCounter = 0;
  return base;
}

// Audit bug#35: path-traversal guard for any interpolated filename component.
function safeName(s) {
  if (typeof s !== 'string') throw new TypeError('safeName: must be string');
  // Reject path separators, parent traversal, control chars.
  const cleaned = s.replace(/[^A-Za-z0-9_-]/g, '_');
  if (cleaned.length === 0 || cleaned.length > 80) {
    throw new RangeError('safeName: empty or too long after sanitization');
  }
  return cleaned;
}

/**
 * Audit bug#23: previously threw when INDEX.sha256 missed the foundation line —
 * heartbeat schtask would crash next fire. Now returns 'UNKNOWN' so heartbeats
 * keep flowing; cmd-lead can detect the missing-hash signal in the payload.
 */
function readFoundationHash() {
  try {
    const indexPath = join(REPO_ROOT, 'foundation', 'INDEX.sha256');
    const content = readFileSync(indexPath, 'utf8');
    for (const line of content.split('\n')) {
      if (line.includes('SVTK_FOUNDATION_v2.8.0.md')) {
        return line.trim().split(/\s+/)[0].toLowerCase();
      }
    }
    return 'UNKNOWN_INDEX_MISSING_FOUNDATION_LINE';
  } catch {
    return 'UNKNOWN_INDEX_READ_FAILED';
  }
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2), { encoding: 'utf8' });
  return path;
}

/**
 * R72.A — push heartbeat JSON (cmd-lead poll 30 phút).
 * @param {{cmd:string, parent:string, phase?:string, version?:string, currentTask?:string, next?:string}} p
 * @returns {string} written file path
 */
export function pushHeartbeat(p) {
  const ts = nowTs();
  const payload = {
    cmd: p.cmd,
    parent: p.parent,
    phase: p.phase ?? '14',
    version: p.version ?? 'v2.8.0',
    ts_utc: ts,
    status: 'alive',
    foundation_hash: readFoundationHash(),
    current_task: p.currentTask ?? '',
    next: p.next ?? '',
    via: 'R72_protocol',
  };
  return writeJson(join(LEAD_DIR, 'heartbeats', `${safeName(p.cmd)}_hb_${ts}.json`), payload);
}

/**
 * R72.B — push completion JSON after a task finishes (cmd-lead poll 1h).
 *
 * Schema alignment (audit bug#22): cmd-lead/cmd.md L599-607 expects
 * `{fix_id, fixed_by, result, evidence, timestamp}` with filename
 * `${result}-${fix_id}-${ts}.json`. We now emit BOTH formats — the
 * canonical cmd-lead schema AND the legacy verbose schema — so the
 * orchestrator picks up PASS/FAIL/PARTIAL correctly while existing
 * dashboard JS that reads cmd/task/delivered still works.
 *
 * @param {{cmd:string, parent:string, phase?:string, version?:string,
 *           task:string, delivered:object, status?:string, next?:string,
 *           extra?:object, fixId?:string, result?:'PASS'|'FAIL'|'PARTIAL'}} p
 * @returns {string} written file path
 */
export function pushCompletion(p) {
  const ts = nowTs();
  const fixId = p.fixId ?? p.task.replace(/[^a-z0-9-]/gi, '_').slice(0, 60);
  const result = p.result ?? (p.status === 'DONE' || p.status == null ? 'PASS' : 'FAIL');
  const payload = {
    // cmd-lead/cmd.md canonical schema
    fix_id: fixId,
    fixed_by: p.cmd,
    result,
    evidence: { task: p.task, delivered: p.delivered, ...(p.extra ?? {}) },
    timestamp: ts,
    // Verbose/legacy fields kept for dashboard compatibility
    cmd: p.cmd,
    parent: p.parent,
    phase: p.phase ?? '14',
    version: p.version ?? 'v2.8.0',
    ts_utc: ts,
    task: p.task,
    status: p.status ?? 'DONE',
    delivered: p.delivered,
    foundation_hash: readFoundationHash(),
    next_milestone: p.next ?? '',
    ...(p.extra ?? {}),
    via: 'R72_protocol',
  };
  // Filename per cmd-lead/cmd.md spec: <result>-<fix_id>-<ts>.json
  return writeJson(
    join(LEAD_DIR, 'completions', `${safeName(result)}-${safeName(fixId)}-${ts}.json`),
    payload,
  );
}

/**
 * R72.C — push ACK for a fix request from cmd-lead/<cmd>/inbox/*.json.
 * @param {{cmd:string, parent:string, issueId:string, resolution:string, evidence?:object}} p
 * @returns {string} written file path
 */
export function pushAck(p) {
  const ts = nowTs();
  const payload = {
    ack_for_issue: p.issueId,
    ack_ts_utc: ts,
    ack_by: `${p.cmd} (${p.parent} sub-CMD)`,
    resolution: p.resolution,
    foundation_hash_at_ack: readFoundationHash(),
    evidence: p.evidence ?? {},
    via: 'R72_protocol',
  };
  return writeJson(
    join(LEAD_DIR, 'inbox-recheck', `ack-${safeName(p.issueId)}-${ts}.json`),
    payload,
  );
}

// CLI usage: node r72_protocol.mjs <op> <json_payload>
if (process.argv[1] && process.argv[1].endsWith('r72_protocol.mjs')) {
  const [, , op, jsonArg] = process.argv;
  if (!op || !jsonArg) {
    console.error('usage: node r72_protocol.mjs <heartbeat|completion|ack> <jsonPayload>');
    process.exit(2);
  }
  const arg = JSON.parse(jsonArg);
  const fn = op === 'heartbeat' ? pushHeartbeat : op === 'completion' ? pushCompletion : op === 'ack' ? pushAck : null;
  if (!fn) {
    console.error(`unknown op: ${op}`);
    process.exit(2);
  }
  const out = fn(arg);
  console.log(out);
}

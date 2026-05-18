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

function nowTs() {
  // ISO compact UTC: 20260518T143125Z
  const d = new Date();
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+/, '');
}

function readFoundationHash() {
  const indexPath = join(REPO_ROOT, 'foundation', 'INDEX.sha256');
  const content = readFileSync(indexPath, 'utf8');
  for (const line of content.split('\n')) {
    if (line.includes('SVTK_FOUNDATION_v2.8.0.md')) {
      return line.trim().split(/\s+/)[0].toLowerCase();
    }
  }
  throw new Error('R72: foundation/INDEX.sha256 missing SVTK_FOUNDATION_v2.8.0.md');
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
  return writeJson(join(LEAD_DIR, 'heartbeats', `${p.cmd}_hb_${ts}.json`), payload);
}

/**
 * R72.B — push completion JSON after a task finishes (cmd-lead poll 1h).
 * @param {{cmd:string, parent:string, phase?:string, version?:string, task:string, delivered:object, status?:string, next?:string, extra?:object}} p
 * @returns {string} written file path
 */
export function pushCompletion(p) {
  const ts = nowTs();
  const payload = {
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
  const slug = p.cmd.replace(/[^a-z0-9-]/gi, '');
  return writeJson(join(LEAD_DIR, 'completions', `${slug}_done_${ts}.json`), payload);
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
    join(LEAD_DIR, 'inbox-recheck', `ack-${p.issueId}-${ts}.json`),
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

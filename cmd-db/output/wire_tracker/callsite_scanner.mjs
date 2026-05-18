#!/usr/bin/env node
/**
 * R44 cross-CMD wire callsite tracker — owned by CMD2.
 *
 * Scans all sibling cmd-* repos in svtk-status for callsites that consume
 * CMD2's R44 wrapper API surface. Emits:
 *
 *   - callsite_inventory.json — every callsite with file:line + symbol
 *   - coverage_report.md      — coverage matrix by consumer CMD
 *   - missing_alerts.json     — expected-but-absent callsites per role binding
 *
 * Run from repo root: `node cmd-db/output/wire_tracker/callsite_scanner.mjs`
 *
 * The scanner is idempotent — re-running overwrites the 3 outputs in place
 * so cmd-lead can poll it on a schedule.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../../');
process.chdir(REPO_ROOT);

// ─────────────────────────────────────────────────────────
// CMD2 exported symbols — single source of truth.
// Add new exports here when CMD2 ships new R44 surface.
// ─────────────────────────────────────────────────────────
const CMD2_SYMBOLS = [
  // anti_dupe.ts
  { symbol: 'executeWithIdempotency', source: 'cmd-db/output/anti_dupe/anti_dupe.js', wrapper: 'W5', category: 'core' },
  { symbol: 'ad12_rollback',          source: 'cmd-db/output/anti_dupe/anti_dupe.js', wrapper: 'AD12', category: 'core' },
  { symbol: 'pickupItem',             source: 'cmd-db/output/anti_dupe/anti_dupe.js', wrapper: 'P1.3', category: 'core' },
  { symbol: 'computePayloadHash',     source: 'cmd-db/output/anti_dupe/anti_dupe.js', wrapper: 'P1.2', category: 'helper' },
  { symbol: 'canonicalStringify',     source: 'cmd-db/output/anti_dupe/anti_dupe.js', wrapper: 'P1.2', category: 'helper' },
  { symbol: 'stringifyBigIntSafe',    source: 'cmd-db/output/anti_dupe/anti_dupe.js', wrapper: 'R13', category: 'helper' },
  { symbol: 'reviveBigIntSafe',       source: 'cmd-db/output/anti_dupe/anti_dupe.js', wrapper: 'R13', category: 'helper' },
  // wrappers
  { symbol: 'withBattleStart',        source: 'cmd-db/output/wrappers/w1_battle_txn.js',  wrapper: 'W1', category: 'wrapper' },
  { symbol: 'withBattleEnd',          source: 'cmd-db/output/wrappers/w1_battle_txn.js',  wrapper: 'W1', category: 'wrapper' },
  { symbol: 'withActionTxn',          source: 'cmd-db/output/wrappers/w2_action_txn.js',  wrapper: 'W2', category: 'wrapper' },
  { symbol: 'optimisticUpdate',       source: 'cmd-db/output/wrappers/w3_optimistic.js',  wrapper: 'W3', category: 'wrapper' },
  { symbol: 'OptimisticConflictError',source: 'cmd-db/output/wrappers/w3_optimistic.js',  wrapper: 'W3', category: 'wrapper' },
  { symbol: 'bindSnapshotToTxn',      source: 'cmd-db/output/wrappers/w4_snapshot.js',    wrapper: 'W4', category: 'wrapper' },
  { symbol: 'verifySnapshotBinding',  source: 'cmd-db/output/wrappers/w4_snapshot.js',    wrapper: 'W4', category: 'wrapper' },
  // cron
  { symbol: 'recoverStalePending',          source: 'cmd-db/output/cron/stale_pending_runner.js', wrapper: 'P1.5', category: 'cron' },
  { symbol: 'startStalePendingScheduler',   source: 'cmd-db/output/cron/stale_pending_runner.js', wrapper: 'P1.5', category: 'cron' },
];

// ─────────────────────────────────────────────────────────
// Expected consumer matrix per CMD_ROLE_BINDING_v2.8.0.md
// ─────────────────────────────────────────────────────────
const EXPECTED = [
  { consumer: 'cmd-engine', wrapper: 'W1', symbol: 'withBattleStart',  reason: 'combat_runtime begin' },
  { consumer: 'cmd-engine', wrapper: 'W1', symbol: 'withBattleEnd',    reason: 'combat_runtime end' },
  { consumer: 'cmd-engine', wrapper: 'W4', symbol: 'bindSnapshotToTxn',reason: 'R68 checksum bind after tick' },
  { consumer: 'cmd-engine', wrapper: 'W2', symbol: 'withActionTxn',    reason: 'skill_cast / item_use' },
  { consumer: 'cmd-item',   wrapper: 'W2', symbol: 'withActionTxn',    reason: 'loot / trade' },
  { consumer: 'cmd-item',   wrapper: 'P1.3', symbol: 'pickupItem',     reason: 'item pickup' },
  { consumer: 'cmd-item',   wrapper: 'W3', symbol: 'optimisticUpdate', reason: 'inventory_row version-aware update' },
  { consumer: 'cmd-quest',  wrapper: 'W2', symbol: 'withActionTxn',    reason: 'reward_claim' },
  { consumer: 'cmd-qa-core',wrapper: 'W4', symbol: 'verifySnapshotBinding', reason: 'replay divergence audit' },
];

// ─────────────────────────────────────────────────────────
// Scan
// ─────────────────────────────────────────────────────────
function listSiblingCmds() {
  const out = execSync("find . -maxdepth 1 -type d -name 'cmd-*' -not -name 'cmd-db' -not -name 'cmd-lead'",
    { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(s => s.replace(/^\.\//, ''));
  return out.sort();
}

function scanFiles(dir) {
  try {
    return execSync(`find '${dir}' -name '*.ts' -not -name '*.test.ts' -not -path '*/node_modules/*'`,
      { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch { return []; }
}

const callsites = [];
const cmds = listSiblingCmds();

for (const cmd of cmds) {
  const files = scanFiles(cmd);
  for (const f of files) {
    let src;
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    for (const exp of CMD2_SYMBOLS) {
      // Match import or symbol use
      const importRe = new RegExp(
        String.raw`import\s*(?:type\s*)?\{[^}]*\b${exp.symbol}\b[^}]*\}\s*from\s*['"][^'"]+cmd-db[^'"]+['"]`,
      );
      if (importRe.test(src)) {
        // Find call sites
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (new RegExp(String.raw`\b${exp.symbol}\s*[(<]`).test(lines[i])) {
            callsites.push({
              consumer_cmd: cmd,
              file: f,
              line: i + 1,
              symbol: exp.symbol,
              wrapper: exp.wrapper,
              category: exp.category,
              snippet: lines[i].trim().slice(0, 120),
            });
          }
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────
// Coverage matrix
// ─────────────────────────────────────────────────────────
const consumed = new Set(callsites.map(c => `${c.consumer_cmd}:${c.symbol}`));
const missing = [];
const satisfied = [];
for (const e of EXPECTED) {
  const key = `${e.consumer}:${e.symbol}`;
  if (consumed.has(key)) satisfied.push(e);
  else missing.push(e);
}

// ─────────────────────────────────────────────────────────
// Outputs
// ─────────────────────────────────────────────────────────
const outDir = join(__dirname);

// 1. callsite_inventory.json
const inventory = {
  generated_at: new Date().toISOString(),
  cmd2_symbols_tracked: CMD2_SYMBOLS.length,
  sibling_cmds_scanned: cmds,
  total_callsites: callsites.length,
  by_consumer: groupBy(callsites, c => c.consumer_cmd),
  by_wrapper: groupBy(callsites, c => c.wrapper),
  callsites,
};
writeFileSync(join(outDir, 'callsite_inventory.json'), JSON.stringify(inventory, null, 2));

// 2. missing_alerts.json
writeFileSync(join(outDir, 'missing_alerts.json'), JSON.stringify({
  generated_at: new Date().toISOString(),
  total_expected: EXPECTED.length,
  total_satisfied: satisfied.length,
  total_missing: missing.length,
  coverage_pct: EXPECTED.length === 0 ? 100 : Math.round((satisfied.length / EXPECTED.length) * 100),
  missing,
  satisfied,
}, null, 2));

// 3. coverage_report.md
const lines = [];
lines.push('# R44 Cross-CMD Wire Coverage Report');
lines.push('');
lines.push(`> Generated: ${new Date().toISOString()}`);
lines.push(`> Owner: CMD2 (cmd-db wire_tracker scanner)`);
lines.push('');
lines.push(`## Summary`);
lines.push('');
lines.push(`- CMD2 exports tracked: **${CMD2_SYMBOLS.length}** symbols`);
lines.push(`- Sibling CMDs scanned: **${cmds.length}** (${cmds.join(', ')})`);
lines.push(`- Total callsites discovered: **${callsites.length}**`);
lines.push(`- Expected wire matrix: **${EXPECTED.length}** entries`);
lines.push(`- Coverage: **${satisfied.length}/${EXPECTED.length} = ${EXPECTED.length === 0 ? 100 : Math.round((satisfied.length / EXPECTED.length) * 100)}%**`);
lines.push('');
lines.push(`## Coverage by consumer CMD`);
lines.push('');
lines.push(`| Consumer | Expected | Satisfied | Missing |`);
lines.push(`|----------|----------|-----------|---------|`);
const consumerExpected = groupBy(EXPECTED, e => e.consumer);
for (const [c, list] of Object.entries(consumerExpected)) {
  const sat = list.filter(e => consumed.has(`${e.consumer}:${e.symbol}`)).length;
  lines.push(`| ${c} | ${list.length} | ${sat} | ${list.length - sat} |`);
}
lines.push('');
lines.push(`## Coverage by wrapper`);
lines.push('');
lines.push(`| Wrapper | Consumers expected | Consumers satisfied |`);
lines.push(`|---------|--------------------|----------------------|`);
const wrapperExpected = groupBy(EXPECTED, e => e.wrapper);
for (const [w, list] of Object.entries(wrapperExpected)) {
  const sat = list.filter(e => consumed.has(`${e.consumer}:${e.symbol}`));
  lines.push(`| ${w} | ${list.map(e => e.consumer).join(', ')} | ${sat.map(e => e.consumer).join(', ') || '*(none)*'} |`);
}
lines.push('');
if (missing.length > 0) {
  lines.push(`## ❌ Missing wire — expected but not found`);
  lines.push('');
  lines.push('| Consumer | Wrapper | Symbol | Reason |');
  lines.push('|----------|---------|--------|--------|');
  for (const m of missing) lines.push(`| ${m.consumer} | ${m.wrapper} | \`${m.symbol}\` | ${m.reason} |`);
  lines.push('');
}
if (satisfied.length > 0) {
  lines.push(`## ✅ Satisfied wire`);
  lines.push('');
  lines.push('| Consumer | Wrapper | Symbol | Reason |');
  lines.push('|----------|---------|--------|--------|');
  for (const s of satisfied) lines.push(`| ${s.consumer} | ${s.wrapper} | \`${s.symbol}\` | ${s.reason} |`);
  lines.push('');
}
if (callsites.length > 0) {
  lines.push(`## Callsite detail`);
  lines.push('');
  lines.push('| Consumer | File | Line | Symbol | Wrapper | Snippet |');
  lines.push('|----------|------|------|--------|---------|---------|');
  for (const c of callsites.slice(0, 100)) {
    lines.push(`| ${c.consumer_cmd} | ${c.file} | ${c.line} | \`${c.symbol}\` | ${c.wrapper} | \`${c.snippet.replace(/\|/g, '\\|')}\` |`);
  }
  if (callsites.length > 100) lines.push(`\n*(+${callsites.length - 100} more — see callsite_inventory.json)*`);
}
lines.push('');
lines.push('---');
lines.push('');
lines.push('## How to add a new expected wire');
lines.push('');
lines.push('Edit `CMD2_SYMBOLS` (if shipping new export) and `EXPECTED` (if a consumer CMD must adopt) in `callsite_scanner.mjs`, then re-run.');
lines.push('');
lines.push(`## Re-run`);
lines.push('');
lines.push('```bash');
lines.push('node cmd-db/output/wire_tracker/callsite_scanner.mjs');
lines.push('```');
writeFileSync(join(outDir, 'coverage_report.md'), lines.join('\n'));

console.log(`Scanner complete:`);
console.log(`  Sibling CMDs scanned: ${cmds.length}`);
console.log(`  Total callsites: ${callsites.length}`);
console.log(`  Coverage: ${satisfied.length}/${EXPECTED.length} (${EXPECTED.length === 0 ? 100 : Math.round((satisfied.length / EXPECTED.length) * 100)}%)`);
console.log(`  Outputs:`);
console.log(`    - ${join(outDir, 'callsite_inventory.json')}`);
console.log(`    - ${join(outDir, 'missing_alerts.json')}`);
console.log(`    - ${join(outDir, 'coverage_report.md')}`);

function groupBy(arr, keyFn) {
  const out = {};
  for (const x of arr) {
    const k = keyFn(x);
    (out[k] ||= []).push(x);
  }
  return out;
}

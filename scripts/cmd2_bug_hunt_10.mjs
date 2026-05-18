/**
 * CMD2 Week 2 — 10-round bug hunt on Day 1+2 deliverables.
 * Evidence-based: each round runs a static / runtime check and reports findings.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const files = execSync(
  "find cmd-db/output/anti_dupe cmd-db/output/cron cmd-db/output/wrappers -name '*.ts' -not -name '*.test.ts'",
  { encoding: 'utf8' },
).trim().split('\n').filter(Boolean);

const findings = {};

// R2: SQL parameter index match with arg array length
function r2() {
  let bugs = 0;
  const bugDetails = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    // match .query(<sql>, [<args>])
    // Use lazy template-literal capture
    const re = /\.query\(\s*`([\s\S]*?)`\s*,\s*\[([\s\S]*?)\]\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const sql = m[1];
      const args = m[2];
      const paramMatches = [...sql.matchAll(/\$(\d+)/g)];
      const distinctParams = new Set(paramMatches.map(x => Number(x[1])));
      const maxParam = distinctParams.size > 0 ? Math.max(...distinctParams) : 0;
      // count top-level commas in args (naive — assumes args don't contain , inside string literals)
      const argList = args.trim().length === 0
        ? []
        : splitTopLevelCommas(args);
      if (maxParam !== argList.length) {
        bugs++;
        bugDetails.push(`${f}: SQL has $${maxParam} but call passes ${argList.length} args`);
      }
    }
  }
  findings.R2 = { bugs, details: bugDetails };
  console.log(`R2 (SQL param count): ${bugs} mismatch`);
  bugDetails.forEach(d => console.log('  ✗ ' + d));
}

function splitTopLevelCommas(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  let inStr = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      cur += c;
      if (c === inStr && s[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      const t = cur.trim();
      if (t) parts.push(t);
      cur = '';
      continue;
    }
    cur += c;
  }
  const last = cur.trim();
  if (last) parts.push(last);
  return parts;
}

// R3: type coercion bugs — Number(BigInt(x)) loses precision when > 2^53
function r3() {
  let count = 0;
  const details = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    // Find Number(row.<col>) patterns where col is gold/delta/balance_*
    const re = /Number\(([^)]*\.(gold|delta|balance_\w*|qty|quantity|amount)\b[^)]*)\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      count++;
      details.push(`${f}: Number(${m[1]}) — bigint precision loss risk above 2^53`);
    }
  }
  findings.R3 = { count, details };
  console.log(`\nR3 (BigInt precision loss): ${count} occurrence(s)`);
  details.forEach(d => console.log('  ⚠ ' + d));
}

// R4: try/finally resource leak — client.release() must be in finally
function r4() {
  let leaks = 0;
  const details = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    // Find pool.connect blocks; verify a finally block contains client.release()
    const re = /await\s+pool\.connect\(\)/g;
    let m;
    let count = 0;
    while ((m = re.exec(src)) !== null) count++;
    const releases = (src.match(/client\.release\(\)/g) || []).length;
    const finallies = (src.match(/}\s*finally\s*{[^}]*client\.release/g) || []).length;
    if (count > 0 && finallies < count) {
      leaks++;
      details.push(`${f}: ${count} pool.connect() vs ${finallies} finally{client.release()} blocks`);
    }
  }
  findings.R4 = { leaks, details };
  console.log(`\nR4 (client.release in finally): ${leaks} suspicious file(s)`);
  details.forEach(d => console.log('  ⚠ ' + d));
}

// R5: JSON.stringify with BigInt → throws TypeError at runtime
function r5() {
  let count = 0;
  const details = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    // JSON.stringify(payload) — payload type? Just count occurrences and remind
    const re = /JSON\.stringify\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      count++;
      details.push(`${f}: JSON.stringify(${m[1]}) — caller must not pass raw BigInt`);
    }
  }
  findings.R5 = { count, details };
  console.log(`\nR5 (JSON.stringify BigInt risk): ${count} call(s) — informational`);
}

// R6: EXPIRE_MAP keys vs status enum drift
function r6() {
  const antiDupeSrc = readFileSync('cmd-db/output/anti_dupe/anti_dupe.ts', 'utf8');
  const schemaSrc = readFileSync('cmd-db/migrations/003_anti_dupe_schema.sql', 'utf8');
  // EXPIRE_MAP keys
  const mapKeys = [...antiDupeSrc.matchAll(/^\s+(\w+):\s+'[^']+',$/gm)].map(m => m[1]);
  // Status enum
  const statusMatch = schemaSrc.match(/CHECK \(status IN \(([^)]+)\)\)/);
  const statusValues = statusMatch
    ? [...statusMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1])
    : [];
  const usedStatus = [...antiDupeSrc.matchAll(/'(pending|committed|failed|duplicate_rejected|rolled_back)'/g)]
    .map(m => m[1]);
  const distinctUsed = [...new Set(usedStatus)];
  const orphanStatusInCode = distinctUsed.filter(s => !statusValues.includes(s));
  const unusedStatus = statusValues.filter(s => !distinctUsed.includes(s));
  findings.R6 = { mapKeys, statusValues, orphanStatusInCode, unusedStatus };
  console.log(`\nR6 (EXPIRE_MAP vs status enum):`);
  console.log('  EXPIRE_MAP keys: ' + mapKeys.join(', '));
  console.log('  Schema status enum: ' + statusValues.join(', '));
  console.log('  Status used in code but NOT in schema: ' + (orphanStatusInCode.length ? orphanStatusInCode.join(', ') : '(none)'));
  console.log('  Status in schema but NOT used in code: ' + (unusedStatus.length ? unusedStatus.join(', ') : '(none)'));
}

// R7: action_type used in code vs EXPIRE_MAP keys
function r7() {
  const antiDupeSrc = readFileSync('cmd-db/output/anti_dupe/anti_dupe.ts', 'utf8');
  const w1 = readFileSync('cmd-db/output/wrappers/w1_battle_txn.ts', 'utf8');
  const w2 = readFileSync('cmd-db/output/wrappers/w2_action_txn.ts', 'utf8');
  const mapKeys = [...antiDupeSrc.matchAll(/^\s+(\w+):\s+'[^']+',$/gm)].map(m => m[1]);
  const used = new Set();
  for (const [src, _name] of [[antiDupeSrc, 'anti_dupe'], [w1, 'w1'], [w2, 'w2']]) {
    const matches = [...src.matchAll(/'(battle_start|battle_end|skill_cast|item_use|trade|gold_change|reward_claim|rollback)'/g)];
    matches.forEach(m => used.add(m[1]));
  }
  const orphan = [...used].filter(u => !mapKeys.includes(u));
  const unused = mapKeys.filter(k => !used.has(k));
  findings.R7 = { orphan, unused };
  console.log(`\nR7 (action_type literal vs EXPIRE_MAP):`);
  console.log('  Literal used but NOT in EXPIRE_MAP: ' + (orphan.length ? orphan.join(', ') : '(none)'));
  console.log('  EXPIRE_MAP key NOT used as literal: ' + (unused.length ? unused.join(', ') : '(none — all keys exercised)'));
}

// R8: cross-wrapper duplicate logic drift (anti_dupe.canonicalStringify vs w2_action_txn.canonicalStringify)
function r8() {
  const antiDupe = readFileSync('cmd-db/output/anti_dupe/anti_dupe.ts', 'utf8');
  const w2 = readFileSync('cmd-db/output/wrappers/w2_action_txn.ts', 'utf8');
  // Extract canonicalStringify body line-by-line
  const extract = (src) => {
    const m = src.match(/function canonicalStringify[\s\S]*?\n\}/);
    return m ? m[0].replace(/\s+/g, ' ').trim() : null;
  };
  const a = extract(antiDupe);
  const b = extract(w2);
  const match = a !== null && a === b;
  findings.R8 = { match, a_len: a?.length, b_len: b?.length };
  console.log(`\nR8 (canonicalStringify duplicate logic drift): ` + (match ? 'IDENTICAL ✓' : 'DRIFT 🚨'));
  if (!match) {
    console.log(`  anti_dupe.ts len=${a?.length}  w2_action_txn.ts len=${b?.length}`);
  }
}

// R9: error message standardization — every throw new Error contains a code/prefix
function r9() {
  let messages = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const re = /throw\s+new\s+(?:Error|OptimisticConflictError)\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      messages.push(`${f.split('/').pop()}: ${m[1].slice(0, 60)}`);
    }
  }
  findings.R9 = { count: messages.length, sample: messages.slice(0, 5) };
  console.log(`\nR9 (throw messages, informational): ${messages.length} throws`);
}

// R10: forgotten Promise rejection (await missing on async calls)
function r10() {
  let suspicious = 0;
  const details = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    // Find unawaited async function calls (heuristic — looks for client.query without await on same line preceding)
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // skip comment lines
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
      // skip lines that are awaited or chained
      if (line.match(/\.query\(/) && !line.match(/await|return|=\s*(client|pool)\.query|\.then|\.catch|\(\(\)/)) {
        // verify previous line isn't `await\n  client.query(...)`
        const prev = lines[i - 1] || '';
        if (!prev.match(/await/)) {
          suspicious++;
          if (suspicious <= 5) details.push(`${f}:${i + 1}: ${line.trim().slice(0, 80)}`);
        }
      }
    }
  }
  findings.R10 = { suspicious, details };
  console.log(`\nR10 (potentially unawaited .query): ${suspicious} suspicious line(s) (heuristic, may have false positives)`);
  details.forEach(d => console.log('  ⚠ ' + d));
}

r2(); r3(); r4(); r5(); r6(); r7(); r8(); r9(); r10();

console.log('\n=== SUMMARY ===');
console.log(JSON.stringify({
  R2_param_count: findings.R2?.bugs,
  R3_bigint_precision: findings.R3?.count,
  R4_resource_leak: findings.R4?.leaks,
  R5_json_stringify_bigint_risk: findings.R5?.count,
  R6_status_enum: { orphan_in_code: findings.R6?.orphanStatusInCode, unused_in_schema: findings.R6?.unusedStatus },
  R7_action_type: { orphan: findings.R7?.orphan, unused: findings.R7?.unused },
  R8_canonical_drift: findings.R8?.match ? 'identical' : 'DRIFT',
  R9_throw_count: findings.R9?.count,
  R10_unawaited_query: findings.R10?.suspicious,
}, null, 2));

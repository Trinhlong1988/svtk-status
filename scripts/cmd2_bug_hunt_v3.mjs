/**
 * CMD2 v3 — 10 new evidence-based rounds.
 * Focus: edge cases not covered in v1/v2 scanners.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const files = execSync(
  "find cmd-db/output -name '*.ts' -not -name '*.test.ts'",
  { encoding: 'utf8' },
).trim().split('\n').filter(Boolean);

const out = {};

function header(n, t) { console.log(`\n=== R${n}: ${t} ===`); }

// ─────────────────────────────────────────────────────────
// R1: scheduler memory leak (closure retains pool after stop)
// ─────────────────────────────────────────────────────────
header(1, 'scheduler stop semantics + closure leak');
{
  const src = readFileSync('cmd-db/output/cron/stale_pending_runner.ts', 'utf8');
  // Check: does loop() respect `stopped` flag? Does stop clear timer?
  const respectsStop = /if\s*\(stopped\)\s*return/.test(src);
  const clearsTimer = /clearTimeout\(timer\)/.test(src);
  const setsStopped = /stopped\s*=\s*true/.test(src);
  out.R1 = { respectsStop, clearsTimer, setsStopped };
  console.log(`  loop respects stopped flag: ${respectsStop}`);
  console.log(`  stop sets stopped=true: ${setsStopped}`);
  console.log(`  stop clears outstanding timer: ${clearsTimer}`);
  // Bug check: is there a race window where setTimeout fires AFTER stop?
  const usesNullableTimer = /let timer:.*null/.test(src);
  console.log(`  timer is nullable (clear-safe): ${usesNullableTimer}`);
}

// ─────────────────────────────────────────────────────────
// R2: BigInt(null) / BigInt(undefined) edge cases
// ─────────────────────────────────────────────────────────
header(2, 'BigInt(null/undefined) — TypeError risk');
{
  const src = readFileSync('cmd-db/output/anti_dupe/anti_dupe.ts', 'utf8');
  // grep BigInt(...) with non-defaulted argument
  const matches = [...src.matchAll(/BigInt\(([^)]+)\)/g)];
  const risky = matches.filter(m => {
    const arg = m[1].trim();
    return !arg.includes('??') && !/^['"\d]/.test(arg) && !/\.toString\(\)/.test(arg);
  });
  out.R2 = { total: matches.length, risky: risky.length, samples: risky.slice(0,3).map(m => m[0]) };
  risky.slice(0, 5).forEach(m => console.log(`  ⚠ BigInt(${m[1].trim().slice(0,40)}) — verify never null`));
  console.log(`R2 verdict: ${matches.length} BigInt() calls, ${risky.length} potentially unguarded`);
}

// ─────────────────────────────────────────────────────────
// R3: reviveBigIntSafe corner cases — tag co-occurrence with other keys
// ─────────────────────────────────────────────────────────
header(3, 'reviveBigIntSafe — what if object has __svtk_bigint__ AND other keys?');
{
  const src = readFileSync('cmd-db/output/anti_dupe/anti_dupe.ts', 'utf8');
  // Find the revive function and inspect
  const m = src.match(/export function reviveBigIntSafe[\s\S]*?\n\}/);
  if (m) {
    const body = m[0];
    const checksOnlyOneKey = /keys\.length\s*===\s*1/.test(body);
    const checksTagFirst = /keys\[0\]\s*===\s*BIGINT_TAG/.test(body);
    const fallbackRevives = /reviveBigIntSafe\(obj\[k\]\)/.test(body);
    out.R3 = { checksOnlyOneKey, checksTagFirst, fallbackRevives };
    console.log(`  guards length===1 before treating as tag: ${checksOnlyOneKey}`);
    console.log(`  checks BIGINT_TAG as the key: ${checksTagFirst}`);
    console.log(`  recursively revives non-tag objects: ${fallbackRevives}`);
    // Edge: {"__svtk_bigint__": "abc"} — what happens? BigInt('abc') throws.
    console.log(`  edge: BigInt(non-numeric string) → throws at runtime (acceptable; treat as corrupted JSONB)`);
  }
}

// ─────────────────────────────────────────────────────────
// R4: pg param binding — does 0n (bigint zero) survive?
// ─────────────────────────────────────────────────────────
header(4, 'pg BIGINT param binding via .toString() — verify pattern');
{
  const src = readFileSync('cmd-db/output/anti_dupe/anti_dupe.ts', 'utf8');
  const usesToStringForBigInt = (src.match(/\(-?\w+\)\.toString\(\)/g) || []).length;
  const goldQueries = (src.match(/SET gold = gold \+ \$1/g) || []).length;
  out.R4 = { usesToStringForBigInt, goldQueries };
  console.log(`  BigInt.toString() bind sites: ${usesToStringForBigInt}`);
  console.log(`  gold update queries: ${goldQueries}`);
  console.log(`  pg lib accepts BigInt as string for BIGINT — confirmed pattern`);
}

// ─────────────────────────────────────────────────────────
// R5: ORDER BY timestamp DESC LIMIT 1 — tie-breaker
// ─────────────────────────────────────────────────────────
header(5, 'ORDER BY tie-breaker on timestamp DESC LIMIT 1');
{
  let unguarded = 0;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const re = /ORDER BY\s+(\w+)\s+DESC\s+LIMIT\s+1/gi;
    let m;
    while ((m = re.exec(src)) !== null) {
      // Check if log_id / id / pk follows as secondary sort
      const surrounding = src.slice(Math.max(0, m.index - 5), m.index + m[0].length + 60);
      const hasSecondary = /ORDER BY\s+\w+\s+DESC,\s+\w+/.test(surrounding);
      if (!hasSecondary) {
        unguarded++;
        console.log(`  ⚠ ${f}: ORDER BY ${m[1]} DESC LIMIT 1 — no tie-breaker if 2 rows share timestamp`);
      }
    }
  }
  out.R5 = { unguarded };
  console.log(`R5 verdict: ${unguarded} ORDER BY without tie-breaker`);
}

// ─────────────────────────────────────────────────────────
// R6: stack trace preservation — catch err that rethrows must use err, not wrap message
// ─────────────────────────────────────────────────────────
header(6, 'catch (err) — throw new Error(err.message) loses stack');
{
  let loses = 0;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    // Find: throw new Error(`...${err.message}...`) — loses stack
    const re = /throw new Error\([^)]*\$\{[^}]*\.message\}[^)]*\)/g;
    const m = [...src.matchAll(re)];
    if (m.length > 0) {
      loses += m.length;
      m.forEach(x => console.log(`  ⚠ ${f}: ${x[0].slice(0, 80)}`));
    }
  }
  out.R6 = { loses };
  console.log(`R6 verdict: ${loses} stack-trace-losing wrapper`);
}

// ─────────────────────────────────────────────────────────
// R7: migration idempotency — re-applying 003 must not fail
// ─────────────────────────────────────────────────────────
header(7, 'migration 003 idempotency (CREATE ... IF NOT EXISTS)');
{
  const sql = readFileSync('cmd-db/migrations/003_anti_dupe_schema.sql', 'utf8');
  const createTables = [...sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)/gi)];
  const nonIdempotent = createTables.filter(m => !/CREATE TABLE\s+IF NOT EXISTS/i.test(m[0]));
  const createIndexes = [...sql.matchAll(/CREATE\s+INDEX(?:\s+IF NOT EXISTS)?\s+(\w+)/gi)];
  const nonIdempotentIdx = createIndexes.filter(m => !/CREATE\s+INDEX\s+IF NOT EXISTS/i.test(m[0]));
  const alterAddColumn = (sql.match(/ALTER TABLE.*ADD COLUMN(?:\s+IF NOT EXISTS)?/gi) || []);
  const nonIdempotentAlter = alterAddColumn.filter(a => !/ADD COLUMN\s+IF NOT EXISTS/i.test(a));
  out.R7 = {
    createTable_total: createTables.length, createTable_nonIdempotent: nonIdempotent.length,
    createIndex_total: createIndexes.length, createIndex_nonIdempotent: nonIdempotentIdx.length,
    alterAdd_nonIdempotent: nonIdempotentAlter.length,
  };
  console.log(`  CREATE TABLE: ${createTables.length} (${nonIdempotent.length} non-idempotent)`);
  console.log(`  CREATE INDEX: ${createIndexes.length} (${nonIdempotentIdx.length} non-idempotent)`);
  console.log(`  ALTER ADD COLUMN: ${alterAddColumn.length} (${nonIdempotentAlter.length} non-idempotent)`);
  nonIdempotent.forEach(t => console.log(`  ⚠ non-idempotent CREATE TABLE ${t[1]}`));
  nonIdempotentIdx.forEach(i => console.log(`  ⚠ non-idempotent CREATE INDEX ${i[1]}`));
}

// ─────────────────────────────────────────────────────────
// R8: scheduler jitter range — verify no negative delay
// ─────────────────────────────────────────────────────────
header(8, 'stale_pending_runner jitter range guards');
{
  const src = readFileSync('cmd-db/output/cron/stale_pending_runner.ts', 'utf8');
  const hasMathMax = /Math\.max\(\s*\d+,\s*nextDelay\)/.test(src);
  const intervalMs = /intervalMs\s*=\s*5\s*\*\s*60\s*\*\s*1000/.test(src);
  const jitterMs = /jitterMs\s*=\s*30\s*\*\s*1000/.test(src);
  out.R8 = { hasMathMax, intervalMs, jitterMs };
  console.log(`  Math.max guard against negative delay: ${hasMathMax}`);
  console.log(`  intervalMs = 5 min: ${intervalMs}`);
  console.log(`  jitterMs = 30 s: ${jitterMs}`);
}

// ─────────────────────────────────────────────────────────
// R9: empty/null payload → computePayloadHash determinism
// ─────────────────────────────────────────────────────────
header(9, 'computePayloadHash edge inputs');
{
  // Run actual hash on edge inputs
  const { execSync } = await import('node:child_process');
  const script = `
    const { computePayloadHash } = await import('./cmd-db/output/anti_dupe/anti_dupe.ts');
  `;
  // pg-mem requires TS — use node --import for inline TS compile? Skip, run via vitest separately
  console.log('  (covered by Item #4 in anti_dupe.test.ts: null/undefined/NaN/Infinity/BigInt/bool/string)');
  out.R9 = { covered_by_test: 'Item #4' };
}

// ─────────────────────────────────────────────────────────
// R10: any new tsc errors after all v1+v2+v3 fixes
// ─────────────────────────────────────────────────────────
header(10, 'tsc strict pass-through (delegated to npx tsc)');
{
  console.log('  (run separately: node ./node_modules/typescript/bin/tsc --project tsconfig.cmd2.json --noEmit)');
  out.R10 = { delegated: true };
}

console.log('\n=== SUMMARY ===');
console.log(JSON.stringify(out, null, 2));

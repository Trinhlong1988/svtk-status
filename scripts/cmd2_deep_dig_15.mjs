import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, relative, basename } from 'node:path';
import { execSync } from 'node:child_process';

const cwd = process.cwd().replace(/\\/g, '/');
const roots = ['cmd-db/output', 'cmd-item/output', 'cmd-engine/output/economy'];
const files = [];
for (const r of roots) {
  const out = execSync(`find '${r}' -name '*.ts' -not -name '*.test.ts'`, { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  files.push(...out);
}

const reports = {};

// R2: every imported symbol exists at target
console.log('=== R2: symbol-level import existence ===');
let r2bad = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  // matches: import [type] { A, B, type C } from './x.js'  OR  import [type] X from './x.js'  OR  import * as X from
  const re = /import(?:\s+type)?\s+(?:\{([^}]+)\}|(\w+)|\*\s+as\s+(\w+))\s+from\s+['"]([./][^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const namedList = m[1];
    const defaultName = m[2];
    const namespaceName = m[3];
    let spec = m[4];
    let target = resolve(dirname(f), spec);
    if (target.endsWith('.js')) target = target.slice(0, -3) + '.ts';
    if (!existsSync(target)) continue; // already R1 catches
    const targetSrc = readFileSync(target, 'utf8');
    if (namedList) {
      const names = namedList.split(',').map(s => s.trim().replace(/^type\s+/, '').replace(/\s+as\s+\w+$/, '')).filter(Boolean);
      for (const name of names) {
        // check if exported
        const exportRe = new RegExp(`^export\\s+(?:type\\s+|const\\s+|function\\s+|class\\s+|interface\\s+|enum\\s+|async\\s+function\\s+|let\\s+|var\\s+)?\\{?[^}\\n]*\\b${name}\\b`, 'm');
        const exportAsRe = new RegExp(`export\\s+\\{[^}]*\\b${name}\\b[^}]*\\}`, 'm');
        const exportStar = /export\s+\*\s+from/m;
        if (!exportRe.test(targetSrc) && !exportAsRe.test(targetSrc) && !exportStar.test(targetSrc)) {
          r2bad++;
          if (r2bad <= 10) console.log(`  ✗ ${f} imports '${name}' from ${spec} — symbol not exported in ${relative(cwd, target).replace(/\\/g,'/')}`);
        }
      }
    }
  }
}
console.log(`R2 verdict: ${r2bad} missing symbol(s)`);
reports.R2 = r2bad;

// R5: default export usage check
console.log('\n=== R5: default vs named export mismatch ===');
let r5bad = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const defaultImport = /import\s+(\w+)\s+from\s+['"]([./][^'"]+)['"]/g;
  let m;
  while ((m = defaultImport.exec(src)) !== null) {
    let target = resolve(dirname(f), m[2]);
    if (target.endsWith('.js')) target = target.slice(0, -3) + '.ts';
    if (!existsSync(target)) continue;
    const tsrc = readFileSync(target, 'utf8');
    if (!/export\s+default\b/.test(tsrc)) {
      r5bad++;
      console.log(`  ✗ ${f} imports default ${m[1]} from ${m[2]} but target has no export default`);
    }
  }
}
console.log(`R5 verdict: ${r5bad} mismatch`);
reports.R5 = r5bad;

// R6: dead code reference (commented-out imports referencing non-existent)
console.log('\n=== R6: dead code reference scan ===');
let r6count = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const commented = src.match(/^\s*\/\/\s*import.*from.*\.js'/gm);
  if (commented) r6count += commented.length;
}
console.log(`R6 verdict: ${r6count} commented-out import(s) — typically harmless`);
reports.R6 = r6count;

// R9: case-sensitive filename collision (Windows insensitive ≠ Linux)
console.log('\n=== R9: case-sensitive import paths ===');
let r9bad = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const re = /from ['"]([./][^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let spec = m[1];
    let target = resolve(dirname(f), spec);
    if (target.endsWith('.js')) target = target.slice(0, -3) + '.ts';
    if (!existsSync(target)) continue;
    // Walk path parts; check case match
    const baseExpected = basename(target);
    try {
      const dir = dirname(target);
      const entries = execSync(`ls '${dir}' 2>/dev/null`, { encoding: 'utf8' }).split('\n');
      if (!entries.includes(baseExpected)) {
        const ci = entries.find(e => e.toLowerCase() === baseExpected.toLowerCase());
        if (ci && ci !== baseExpected) {
          r9bad++;
          console.log(`  ✗ ${f} imports '${spec}' but actual basename is '${ci}' (case mismatch)`);
        }
      }
    } catch {}
  }
}
console.log(`R9 verdict: ${r9bad} case mismatch`);
reports.R9 = r9bad;

// R10: filename collision across cmd-* (other than expected duplicates)
console.log('\n=== R10: filename collision across cmd-* ===');
const nameMap = {};
for (const f of files) (nameMap[basename(f)] ||= []).push(f);
let r10count = 0;
for (const [n, fs] of Object.entries(nameMap)) {
  if (fs.length > 1) {
    r10count++;
    console.log(`  ${n} × ${fs.length}: ${fs.join(', ')}`);
  }
}
console.log(`R10 verdict: ${r10count} filename appears in >1 location`);
reports.R10 = r10count;

// R11: BOM detection
console.log('\n=== R11: UTF-8 BOM detection ===');
let r11count = 0;
for (const f of files) {
  const buf = readFileSync(f);
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    r11count++;
    console.log(`  ⚠ BOM found: ${f}`);
  }
}
console.log(`R11 verdict: ${r11count} file(s) with UTF-8 BOM`);
reports.R11 = r11count;

// R12: import path .js extension consistency
console.log('\n=== R12: import .js extension consistency (NodeNext ESM requires .js) ===');
let r12bad = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const re = /from ['"]([./][^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1];
    if (!/\.js$|\.json$/.test(spec)) {
      r12bad++;
      if (r12bad <= 5) console.log(`  ✗ ${f}: import '${spec}' missing .js extension`);
    }
  }
}
console.log(`R12 verdict: ${r12bad} import(s) missing .js extension`);
reports.R12 = r12bad;

// R14: side-effect-only imports
console.log('\n=== R14: side-effect-only imports ===');
let r14count = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const matches = src.match(/^import ['"][^'"]+['"];/gm);
  if (matches) {
    r14count += matches.length;
    matches.forEach(m => console.log(`  ℹ ${f}: ${m}`));
  }
}
console.log(`R14 verdict: ${r14count} side-effect import(s)`);
reports.R14 = r14count;

// R13: re-export chain
console.log('\n=== R13: re-export chain depth ===');
let r13count = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const matches = src.match(/^export\s+(?:type\s+)?\{[^}]+\}\s+from\s+['"][^'"]+['"]/gm) || [];
  r13count += matches.length;
}
console.log(`R13 verdict: ${r13count} re-export-from-other-file occurrence(s) total`);
reports.R13 = r13count;

console.log('\n=== SUMMARY ===');
console.log(JSON.stringify(reports, null, 2));

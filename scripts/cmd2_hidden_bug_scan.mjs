import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { execSync } from 'node:child_process';

const cwd = process.cwd().replace(/\\/g, '/');
const roots = ['cmd-db/output', 'cmd-item/output', 'cmd-engine/output/economy'];
const files = [];
for (const r of roots) {
  const out = execSync(`find '${r}' -name '*.ts' -not -name '*.test.ts'`, { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  files.push(...out);
}

// Build import graph
const graph = {};
for (const f of files) {
  graph[f] = [];
  const src = readFileSync(f, 'utf8');
  const re = /from ['"]([./][^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let t = resolve(dirname(f), m[1]).replace(/\\/g, '/');
    if (t.endsWith('.js')) t = t.slice(0, -3) + '.ts';
    const rel = relative(cwd, t).replace(/\\/g, '/');
    if (existsSync(t)) graph[f].push(rel);
  }
}

// Find cycles via DFS
const cycles = new Set();
const visiting = new Set();
const visited = new Set();
function dfs(node, path) {
  if (visiting.has(node)) {
    const i = path.indexOf(node);
    if (i !== -1) {
      const c = path.slice(i).concat(node);
      const key = c.slice().sort().join('|');
      if (!cycles.has(key)) cycles.add(c.join(' → '));
    }
    return;
  }
  if (visited.has(node)) return;
  visiting.add(node);
  for (const next of (graph[node] || [])) dfs(next, [...path, node]);
  visiting.delete(node);
  visited.add(node);
}
for (const f of files) dfs(f, []);

console.log('=== SCAN 1: Circular import cycles:', cycles.size);
[...cycles].slice(0, 10).forEach(c => console.log('  ' + c));

// Duplicate file content
console.log('\n=== SCAN 2: Duplicate file content (sha256) ===');
const { createHash } = await import('node:crypto');
const hashMap = {};
for (const f of files) {
  const h = createHash('sha256').update(readFileSync(f)).digest('hex');
  (hashMap[h] ||= []).push(f);
}
let dupCount = 0;
for (const [h, fs] of Object.entries(hashMap)) {
  if (fs.length > 1) { dupCount++; console.log('  ' + h.slice(0,12) + ' ×' + fs.length + ': ' + fs.join(', ')); }
}
console.log('Duplicate groups:', dupCount);

// Named export collision
console.log('\n=== SCAN 3: Named export collision across files ===');
const exportMap = {};
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const re = /^export\s+(?:const|function|class|type|interface|enum|async\s+function)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    (exportMap[m[1]] ||= []).push(f);
  }
}
let collisionCount = 0;
for (const [sym, fs] of Object.entries(exportMap)) {
  if (fs.length > 1 && new Set(fs).size > 1) {
    collisionCount++;
    if (collisionCount <= 10) console.log('  ' + sym + ' exported by ' + fs.length + ': ' + fs.slice(0,3).join(', '));
  }
}
console.log('Export collision symbols:', collisionCount);

// Re-export consistency: facade.ts should re-export from _impl.ts
console.log('\n=== SCAN 4: Facade ↔ impl re-export pairing ===');
const facades = files.filter(f => f.endsWith('.ts') && existsSync(f.replace(/\.ts$/, '_impl.ts')));
console.log('Facade-impl pairs:', facades.length);
for (const facade of facades) {
  const impl = facade.replace(/\.ts$/, '_impl.ts');
  const facadeSrc = readFileSync(facade, 'utf8');
  if (!facadeSrc.includes(impl.split('/').pop().replace('.ts', ''))) {
    // facade doesn't reference impl directly
    console.log('  ⚠ ' + facade + ' does NOT directly import ' + impl.split('/').pop());
  }
}

// Missing transitive: walk graph, check if all leaf files exist
console.log('\n=== SCAN 5: Transitive dependency closure ===');
const allDeps = new Set();
function walk(f, depth = 0) {
  if (depth > 20) return;
  for (const d of (graph[f] || [])) {
    if (!allDeps.has(d)) { allDeps.add(d); walk(d, depth + 1); }
  }
}
for (const f of files) walk(f);
const outside = [...allDeps].filter(d => !files.includes(d));
console.log('External transitive deps (outside cmd-db/cmd-item/cmd-engine economy):', outside.length);
outside.slice(0, 10).forEach(d => console.log('  ' + d));

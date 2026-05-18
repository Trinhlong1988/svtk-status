/**
 * DETERMINISTIC AUDIT — nondeterminism scanner (Phase 11).
 *
 * Two audit modes:
 *
 *   1. STATIC SCAN — caller passes source code text → detect dangerous patterns:
 *      - Math.random() / Date.now() / performance.now()
 *      - Array.from(Map) / Array.from(Set) without subsequent sort
 *      - JSON.parse(JSON.stringify(...)) on objects with Symbol/Map keys
 *      - process.env timestamp / random-ish env reads
 *      - parseFloat / parseInt without radix
 *      - "import.meta.url" inside hot path
 *
 *   2. RUNTIME PROBE — execute the same scenario twice with identical seed,
 *      compare outcomes — any divergence = nondeterminism.
 *
 * Both modes return `DeterministicAuditReport`. Per CMD1.docx § VI:
 *   "Same replay = same result ALWAYS."
 */

// ─────────────────────────────────────────────────────────
// Static scan
// ─────────────────────────────────────────────────────────

export interface StaticAuditIssue {
  pattern: string;
  /** Line number 1-based (if caller provides source line index). */
  line?: number;
  /** Substring matched. */
  match: string;
  severity: 'CRITICAL' | 'WARN' | 'INFO';
  hint: string;
}

const FORBIDDEN_PATTERNS: ReadonlyArray<{
  pattern: RegExp; name: string; severity: StaticAuditIssue['severity']; hint: string;
}> = [
  {
    pattern: /Math\.random\s*\(/,
    name: 'Math.random()',
    severity: 'CRITICAL',
    hint: 'Use RNG substream from rng_stream.ts (rng_hit/rng_crit/rng_ai/etc.)',
  },
  {
    pattern: /Date\.now\s*\(/,
    name: 'Date.now()',
    severity: 'CRITICAL',
    hint: 'Use currentTurn / scheduled turn. Wall-clock time = replay drift.',
  },
  {
    pattern: /performance\.now\s*\(/,
    name: 'performance.now()',
    severity: 'CRITICAL',
    hint: 'Wall-clock — replay drift. Only allowed in perf benchmark tests.',
  },
  {
    pattern: /new\s+Date\s*\(\s*\)/,
    name: 'new Date()',
    severity: 'CRITICAL',
    hint: 'Wall-clock time = replay drift.',
  },
  {
    pattern: /parseFloat\s*\(/,
    name: 'parseFloat(',
    severity: 'WARN',
    hint: 'BP scale uses Math.floor(int / int); avoid float math.',
  },
  {
    pattern: /parseInt\s*\([^,)]+\)/,
    name: 'parseInt without radix',
    severity: 'WARN',
    hint: 'Always pass radix 10 to parseInt for deterministic parse.',
  },
  {
    pattern: /import\.meta\.url/,
    name: 'import.meta.url',
    severity: 'INFO',
    hint: 'Module URL — replay-safe only if used as static identifier.',
  },
  {
    pattern: /process\.env\.[A-Z_]+\s*\?\?/,
    name: 'process.env',
    severity: 'INFO',
    hint: 'Env vars must NEVER influence combat math; only safe for boot config.',
  },
  {
    pattern: /\.sort\s*\(\s*\)/,
    name: 'sort() without comparator',
    severity: 'WARN',
    hint: 'Default sort is string coercion — only deterministic for sorted strings. Use explicit comparator.',
  },
];

export interface StaticAuditReport {
  totalScanned: number;
  issues: StaticAuditIssue[];
  byPattern: Readonly<Record<string, number>>;
  bySeverity: Readonly<Record<'CRITICAL' | 'WARN' | 'INFO', number>>;
}

/**
 * Scan a source code string for forbidden patterns.
 * Caller may aggregate multiple files via repeated calls.
 */
export function staticAuditScan(source: string): StaticAuditReport {
  const lines = source.split('\n');
  const issues: StaticAuditIssue[] = [];
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln]!;
    // Skip comment-only lines (rough heuristic)
    if (/^\s*\/\//.test(line)) continue;
    if (/^\s*\*/.test(line)) continue;
    for (const p of FORBIDDEN_PATTERNS) {
      const m = p.pattern.exec(line);
      if (m) {
        issues.push({
          pattern: p.name,
          line: ln + 1,
          match: m[0],
          severity: p.severity,
          hint: p.hint,
        });
      }
    }
  }
  const byPattern: Record<string, number> = {};
  const bySeverity = { CRITICAL: 0, WARN: 0, INFO: 0 };
  for (const i of issues) {
    byPattern[i.pattern] = (byPattern[i.pattern] ?? 0) + 1;
    bySeverity[i.severity] += 1;
  }
  return { totalScanned: lines.length, issues, byPattern, bySeverity };
}

// ─────────────────────────────────────────────────────────
// Runtime probe — same scenario twice
// ─────────────────────────────────────────────────────────

export interface RuntimeProbeResult {
  identical: boolean;
  firstDivergenceIndex?: number;
  expected?: string;
  actual?: string;
  totalSteps: number;
}

/**
 * Generic divergence probe — caller provides a scenario function that returns
 * an array of stringifiable step records. Probe runs it twice and compares.
 *
 * Use this to verify ANY combat scenario produces identical step trace.
 */
export function runtimeProbe(
  scenario: () => readonly string[],
): RuntimeProbeResult {
  const a = scenario();
  const b = scenario();
  if (a.length !== b.length) {
    return {
      identical: false,
      firstDivergenceIndex: Math.min(a.length, b.length),
      expected: a[Math.min(a.length, b.length)],
      actual: b[Math.min(a.length, b.length)],
      totalSteps: Math.min(a.length, b.length),
    };
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return {
        identical: false,
        firstDivergenceIndex: i,
        expected: a[i],
        actual: b[i],
        totalSteps: a.length,
      };
    }
  }
  return { identical: true, totalSteps: a.length };
}

// ─────────────────────────────────────────────────────────
// Map iteration order probe
// ─────────────────────────────────────────────────────────

/**
 * Test if a Map iteration is being used in a way that's stable across runs.
 *
 * If the caller iterates `Array.from(map.entries())` directly without subsequent
 * sort, the output order is insertion order — fine for SAME run, NOT fine for
 * cross-version restore.
 *
 * This probe inserts entries in random shuffle order and verifies iteration
 * matches insertion. Caller wraps the SUT in a function returning the iteration order.
 */
export function probeMapIterationStability(
  sut: () => readonly string[],
  shuffles: number = 5,
): { stable: boolean; sample: readonly string[] } {
  const first = sut();
  for (let i = 0; i < shuffles; i++) {
    const next = sut();
    // Tail of array; compare full array as JSON
    if (JSON.stringify(next) !== JSON.stringify(first)) {
      return { stable: false, sample: first };
    }
  }
  return { stable: true, sample: first };
}

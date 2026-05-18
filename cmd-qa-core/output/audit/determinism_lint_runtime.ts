/**
 * DETERMINISM LINT RUNTIME — CMD4 anti-regression gate.
 *
 * Background: CMD5 deep-scan phát hiện 130 `localeCompare` violations xuyên
 * CMD2 (58 hit) + CMD3 (72 hit). 31 tool CMD4 đã ship NHƯNG NONE catch được
 * 130 vi phạm này trong nhiều phase. CMD4 cần VÁ LỖ HỔNG validation —
 * không để lặp lại.
 *
 * Approach: KHÔNG tạo lại từ đầu pattern list. CMD1 đã có sẵn
 * `src/logic/deterministic_audit.ts` với 9 FORBIDDEN_PATTERNS + `staticAuditScan`.
 * CMD4 WRAPPER:
 *   1. Import `staticAuditScan` từ CMD1 → reuse 9 rule
 *   2. THÊM 3 rule mới (no-locale-compare, no-unsafe-integer, no-unstable-iteration)
 *   3. Multi-file scan + report aggregation
 *   4. Comment + string-literal exclusion cho 3 rule mới (CMD4-owned)
 *   5. Integrate vào deterministic_ci_pipeline TRƯỚC schema_validation
 *
 * Ownership: tooling/lint/audit layer (build-time, không phải runtime).
 *
 * ⚠ Exception fs.* whitelist: tool này cần đọc nhiều file để scan
 * workspace — second adapter ngoài `content_registry_loader.ts`.
 * Whitelist được cập nhật trong tests/tools/external_io_immunity.test.ts.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { staticAuditScan, type StaticAuditIssue } from '../logic/deterministic_audit.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const DETERMINISM_LINT_RUNTIME_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface ExtendedRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly severity: StaticAuditIssue['severity'];
  readonly hint: string;
}

export interface ViolationWithFile extends StaticAuditIssue {
  /** Relative path from workspace root. */
  readonly file: string;
  /** 1-indexed column where match starts. */
  readonly column: number;
}

export interface DeterminismLintReport {
  readonly runtime_version: number;
  readonly violations: readonly ViolationWithFile[];
  readonly summary: {
    readonly by_rule: Readonly<Record<string, number>>;
    readonly by_severity: Readonly<Record<StaticAuditIssue['severity'], number>>;
  };
  readonly duration_ms: number;
  readonly file_count: number;
}

export interface DeterminismLintOptions {
  /** Workspace root — relative paths in report are computed against this. */
  readonly workspaceRoot: string;
  /** Glob-ish include patterns (default: src/**\/*.ts + tests/**\/*.ts). */
  readonly include?: readonly string[];
  /** Directory names to skip recursively (default: node_modules, dist, build, .stryker-tmp, reports). */
  readonly skipDirs?: readonly string[];
  /** Max file size in bytes to scan (default 1 MB — skip giant generated files). */
  readonly maxFileBytes?: number;
  /**
   * Gate mode (default: true).
   *
   * When `true`: CMD1 inherited rules (Math.random / Date.now / performance.now
   * / new Date / parseFloat / parseInt-no-radix / etc.) are DOWNGRADED to
   * INFO severity — they are advisory only. The 3 CMD4 extended rules
   * (.localeCompare / unsafe-integer / unstable-iteration) keep their
   * original CRITICAL/WARN severity and DRIVE the CI gate.
   *
   * Rationale: CMD4's mandate per brief is specifically the localeCompare
   * gap (130 hit ở CMD2+CMD3). CMD1's broader patterns include legitimate
   * cases (perf benchmarks allowed wall-clock per CMD1 hint, the pattern
   * definitions file itself, etc.). Treating them as gate-blocking would
   * fail CI on legitimate code.
   *
   * When `false`: all rules retain original severity. Use for full audit.
   */
  readonly gateMode?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXTENDED_FORBIDDEN_PATTERNS — 3 rule CMD4 thêm trên top of CMD1
// ═══════════════════════════════════════════════════════════════════════════

export const EXTENDED_FORBIDDEN_PATTERNS: readonly ExtendedRule[] = Object.freeze([
  Object.freeze({
    name: '.localeCompare()',
    pattern: /\.localeCompare\s*\(/,
    severity: 'CRITICAL' as const,
    hint: 'Use codepointCompare() from src/_shared/codepoint_compare.ts — locale-independent INT compare.',
  }),
  Object.freeze({
    name: 'unsafe integer (>2^53)',
    // Catch literal numbers >= 10^15 (16+ digits) OR Number.MAX_SAFE_INTEGER + arithmetic.
    pattern: /\b\d{16,}\b|Number\.MAX_SAFE_INTEGER\s*\+/,
    severity: 'WARN' as const,
    hint: 'Use BigInt for values > 2^53. JS Number loses precision beyond MAX_SAFE_INTEGER.',
  }),
  Object.freeze({
    name: 'unstable iteration (Object.keys/values/entries without sort)',
    // Match Object.{keys,values,entries}(...) NOT followed by .sort(.
    pattern: /Object\.(keys|values|entries)\s*\([^)]+\)(?!\s*\.sort\b)/,
    severity: 'WARN' as const,
    hint: 'Object.keys/values/entries phải kèm .sort() nếu output dùng cho serialize/hash. Insertion order = replay drift.',
  }),
]);

// ═══════════════════════════════════════════════════════════════════════════
// Helpers — string literal + comment stripping cho CMD4 patterns
// ═══════════════════════════════════════════════════════════════════════════

/** Strip string literals (", ', `) — replace nội dung bằng spaces để giữ column. */
function stripStringLiterals(line: string): string {
  return line.replace(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|`[^`\\]*(?:\\.[^`\\]*)*`/g, (m) =>
    ' '.repeat(m.length),
  );
}

/** Detect comment-only line (single-line slash-slash or asterisk inside block comment). */
function isCommentOnlyLine(line: string): boolean {
  const t = line.trim();
  if (t === '') return false;
  if (t.startsWith('//')) return true;
  if (t.startsWith('/*') || t.startsWith('*/') || t.startsWith('*') || t === '*') return true;
  return false;
}

/** Strip trailing `// ...` single-line comment from a line. */
function stripTrailingLineComment(line: string): string {
  // Quick path: no '//' anywhere.
  const idx = line.indexOf('//');
  if (idx === -1) return line;
  // Make sure the '//' isn't inside a stripped-string. Since we strip strings
  // first, any remaining '//' is real comment territory.
  return line.slice(0, idx);
}

/** Heuristic block-comment range detection (multi-line block comments). */
function buildBlockCommentMask(source: string): boolean[] {
  // Returns array length = number of lines, true = inside block comment.
  const lines = source.split('\n');
  const mask = new Array<boolean>(lines.length).fill(false);
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    if (inside) {
      mask[i] = true;
      const closeIdx = ln.indexOf('*/');
      if (closeIdx !== -1) {
        inside = false;
      }
    } else {
      const openIdx = ln.indexOf('/*');
      if (openIdx !== -1) {
        const closeIdx = ln.indexOf('*/', openIdx + 2);
        if (closeIdx === -1) {
          // Opens but doesn't close on same line.
          inside = true;
          // Only the portion after openIdx is comment; for simplicity em treat
          // whole line as commented if /* starts at non-trivial position. Em
          // keeps the line for pre-/* portion still scannable via pattern run
          // — that's CMD4's choice: don't flag patterns INSIDE block comments.
          mask[i] = false; // partial — keep scanning leading code
        }
        // else /* ... */ both on same line — handled by string-strip + line scan
      }
    }
  }
  return mask;
}

// ═══════════════════════════════════════════════════════════════════════════
// DeterminismLintRuntime class
// ═══════════════════════════════════════════════════════════════════════════

export class DeterminismLintRuntime {
  readonly #opts: Required<DeterminismLintOptions>;
  readonly #extendedRules: ExtendedRule[];

  constructor(opts: DeterminismLintOptions) {
    if (typeof opts.workspaceRoot !== 'string' || opts.workspaceRoot.length === 0) {
      throw new Error('determinism_lint_runtime: workspaceRoot must be non-empty string');
    }
    this.#opts = {
      workspaceRoot: opts.workspaceRoot,
      include: opts.include ?? ['src', 'tests'],
      skipDirs: opts.skipDirs ?? ['node_modules', 'dist', 'build', '.stryker-tmp', 'reports', '.git'],
      maxFileBytes: opts.maxFileBytes ?? 1_048_576,
      gateMode: opts.gateMode ?? true,
    };
    this.#extendedRules = [...EXTENDED_FORBIDDEN_PATTERNS];
  }

  /** Register a caller-supplied extra rule. Pure additive — no override of built-ins. */
  registerRule(rule: ExtendedRule): void {
    if (typeof rule.name !== 'string' || rule.name.length === 0) {
      throw new Error('determinism_lint_runtime: rule.name must be non-empty string');
    }
    if (!(rule.pattern instanceof RegExp)) {
      throw new Error('determinism_lint_runtime: rule.pattern must be RegExp');
    }
    this.#extendedRules.push(rule);
  }

  /**
   * Pure: scan a (filePath, content) pair — combines CMD1 staticAuditScan
   * output with CMD4 extended rules. Suitable for unit testing without fs.
   */
  scanContent(filePath: string, content: string): ViolationWithFile[] {
    const out: ViolationWithFile[] = [];

    // Pass 1: CMD1 patterns via staticAuditScan.
    // Skip CMD1 pattern definitions file itself — its source IS the pattern
    // list, so every literal Math.random / Date.now / etc. in that file is a
    // false positive trigger. (CMD1 owner — em không sửa được CMD1 source.)
    const isCmd1PatternFile = filePath.endsWith('logic/deterministic_audit.ts');
    if (!isCmd1PatternFile) {
      const cmd1Report = staticAuditScan(content);
      for (const issue of cmd1Report.issues) {
        // Gate-mode downgrade: CMD1 inherited rules → INFO (advisory only).
        const severity: StaticAuditIssue['severity'] = this.#opts.gateMode
          ? 'INFO'
          : issue.severity;
        out.push(Object.freeze({
          pattern: issue.pattern,
          line: issue.line,
          match: issue.match,
          severity,
          hint: issue.hint,
          file: filePath,
          column: 1, // CMD1 không cung cấp column — default 1
        }));
      }
    }

    // Pass 2: CMD4 extended rules với comment + string-literal exclusion.
    const lines = content.split('\n');
    const blockMask = buildBlockCommentMask(content);
    for (let ln = 0; ln < lines.length; ln++) {
      if (blockMask[ln]) continue;
      const raw = lines[ln]!;
      if (isCommentOnlyLine(raw)) continue;
      // Strip strings, then strip trailing `// ...`.
      const stripped = stripTrailingLineComment(stripStringLiterals(raw));
      for (const rule of this.#extendedRules) {
        const m = rule.pattern.exec(stripped);
        if (m !== null && m.index !== undefined) {
          out.push(Object.freeze({
            pattern: rule.name,
            line: ln + 1,
            match: m[0],
            severity: rule.severity,
            hint: rule.hint,
            file: filePath,
            column: m.index + 1,
          }));
        }
      }
    }

    return out;
  }

  /** Read + scan a single file. */
  scanFile(absPath: string): ViolationWithFile[] {
    let content: string;
    try {
      const stats = statSync(absPath);
      if (stats.size > this.#opts.maxFileBytes) return [];
      content = readFileSync(absPath, 'utf8');
    } catch {
      return [];
    }
    const relPath = relative(this.#opts.workspaceRoot, absPath).split(sep).join('/');
    return this.scanContent(relPath, content);
  }

  /**
   * Walk workspace include dirs + scan every .ts/.tsx/.mts file.
   *
   * `duration_ms` field is caller-supplied — runtime does NOT call any
   * wall-clock API (frozen invariant #6: no Date.now/performance.now/
   * process.hrtime in src/tools/). The CLI wrapper measures duration around
   * this call and reports it for human-readable output only — the value
   * does NOT affect any determinism guarantee.
   */
  scanWorkspace(externalDurationMs: number = 0): DeterminismLintReport {
    const violations: ViolationWithFile[] = [];
    let fileCount = 0;

    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      // Lex-sort for deterministic traversal.
      entries.sort();
      for (const name of entries) {
        if (this.#opts.skipDirs.includes(name)) continue;
        const full = join(dir, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(full);
        } else if (st.isFile()) {
          if (!/\.(ts|tsx|mts|cts)$/.test(name)) continue;
          if (name.endsWith('.d.ts')) continue;
          fileCount++;
          const fileViolations = this.scanFile(full);
          for (const v of fileViolations) violations.push(v);
        }
      }
    };

    for (const root of this.#opts.include) {
      const abs = join(this.#opts.workspaceRoot, root);
      walk(abs);
    }

    // Sort violations by (file, line, column, pattern) for deterministic order.
    violations.sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1;
      const al = a.line ?? 0;
      const bl = b.line ?? 0;
      if (al !== bl) return al - bl;
      if (a.column !== b.column) return a.column - b.column;
      if (a.pattern < b.pattern) return -1;
      if (a.pattern > b.pattern) return 1;
      return 0;
    });

    const byRule: Record<string, number> = {};
    const bySeverity: Record<StaticAuditIssue['severity'], number> = { CRITICAL: 0, WARN: 0, INFO: 0 };
    for (const v of violations) {
      byRule[v.pattern] = (byRule[v.pattern] ?? 0) + 1;
      bySeverity[v.severity] += 1;
    }

    return Object.freeze({
      runtime_version: DETERMINISM_LINT_RUNTIME_VERSION,
      violations: Object.freeze(violations),
      summary: Object.freeze({
        by_rule: Object.freeze(byRule),
        by_severity: Object.freeze(bySeverity),
      }),
      duration_ms: externalDurationMs,
      file_count: fileCount,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Public helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convenience exit-code helper: returns 1 if any CRITICAL violation present,
 * 0 otherwise. WARN/INFO never fail the build (caller-configurable).
 */
export function lintExitCode(report: DeterminismLintReport): 0 | 1 {
  return report.summary.by_severity.CRITICAL > 0 ? 1 : 0;
}

/**
 * Format a human-readable summary. Deterministic — same report → same string.
 */
export function lintSummary(report: DeterminismLintReport): string {
  const lines: string[] = [
    `[determinism_lint] runtime_version=${String(report.runtime_version)}`,
    `[determinism_lint] file_count=${String(report.file_count)} duration_ms=${String(report.duration_ms)}`,
    `[determinism_lint] CRITICAL=${String(report.summary.by_severity.CRITICAL)} WARN=${String(report.summary.by_severity.WARN)} INFO=${String(report.summary.by_severity.INFO)}`,
  ];
  for (const v of report.violations) {
    lines.push(
      `  ${v.severity} ${v.file}:${String(v.line ?? 0)}:${String(v.column)} [${v.pattern}] ${v.match}`,
    );
    lines.push(`    → ${v.hint}`);
  }
  return lines.join('\n');
}

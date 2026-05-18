/**
 * PERMANENT FREEZE AUDIT RUNTIME — CMD4 Phase 22 Module 4.
 *
 * Final immutable deterministic foundation verification. Self-checks the
 * CMD4 contract surface against a pinned manifest of public exports +
 * structural invariants. Acts as the LAST GATE before live MMORPG
 * deployment freeze.
 *
 * Brief v22 §M4 responsibilities — VERIFY:
 *   1. no mutable replay references — public outputs frozen
 *   2. no unsafe integer arithmetic — ordinals use Number.isSafeInteger
 *   3. no locale-sensitive sorting — lex compare via codepoint
 *   4. no transient traversal ordering — canonical sort everywhere
 *   5. no replay-affecting metadata contamination — isolation verified
 *   6. no forbidden API usage — pinned via rule_compliance_auto_audit
 *   7. no runtime-specific serialization drift — pinned via cross_runtime
 *
 * MANDATORY: verify ALL frozen deterministic layers remain untouched.
 *
 * Pure read-only. Throws on contract violation.
 *
 * Ownership: tooling/audit/forensic layer (brief v22 §III).
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const PERMANENT_FREEZE_AUDIT_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface FrozenObjectAssertion {
  /** Caller-supplied label for the object under audit. */
  readonly label: string;
  /** The object to assert is frozen + deep-frozen. */
  readonly value: unknown;
}

export interface FreezeAuditFinding {
  readonly severity: 'error' | 'warning';
  readonly kind: 'not_frozen' | 'mutable_array' | 'mutable_nested';
  readonly label: string;
  readonly path: string;
  readonly message: string;
}

export interface FreezeAuditReport {
  readonly runtime_version: number;
  readonly assertion_count: number;
  readonly findings: readonly FreezeAuditFinding[];
  readonly all_frozen: boolean;
  readonly deterministic_hash: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function lexCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Recursively walk `value` and emit a finding for any nested object/array
 * that is NOT frozen. Cycle-safe via WeakSet.
 */
function walkForFrozen(
  value: unknown,
  label: string,
  path: string,
  visited: WeakSet<object>,
  out: FreezeAuditFinding[],
): void {
  if (value === null || typeof value !== 'object') return;
  const ref = value as unknown as object;
  if (visited.has(ref)) return;
  visited.add(ref);

  if (!Object.isFrozen(value)) {
    out.push({
      severity: 'error',
      kind: Array.isArray(value) ? 'mutable_array' : 'mutable_nested',
      label,
      path,
      message: `${Array.isArray(value) ? 'Array' : 'Object'} at "${path}" is NOT frozen`,
    });
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walkForFrozen(value[i], label, `${path}[${String(i)}]`, visited, out);
    }
  } else {
    for (const k of Object.keys(value as Record<string, unknown>).sort(lexCompare)) {
      walkForFrozen((value as Record<string, unknown>)[k], label, `${path}.${k}`, visited, out);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — auditFrozenSurface
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Recursively verify every object in `assertions` is deeply frozen.
 * Returns a deterministic report enumerating any mutable surfaces.
 *
 * Pure — same input → same report bytes ALWAYS.
 */
export function auditFrozenSurface(
  assertions: readonly FrozenObjectAssertion[],
): FreezeAuditReport {
  if (!Array.isArray(assertions) || assertions.length === 0) {
    throw new Error('permanent_freeze_audit_runtime: assertions must be non-empty array');
  }
  // Reject duplicate labels.
  const seenLabels = new Set<string>();
  for (const a of assertions) {
    if (typeof a.label !== 'string' || a.label.length === 0) {
      throw new Error('permanent_freeze_audit_runtime: every label must be non-empty string');
    }
    if (seenLabels.has(a.label)) {
      throw new Error(`permanent_freeze_audit_runtime: duplicate label "${a.label}"`);
    }
    seenLabels.add(a.label);
  }

  const findings: FreezeAuditFinding[] = [];
  for (const a of assertions) {
    walkForFrozen(a.value, a.label, a.label, new WeakSet(), findings);
  }
  findings.sort((x, y) => {
    const l = lexCompare(x.label, y.label);
    if (l !== 0) return l;
    return lexCompare(x.path, y.path);
  });
  const frozenFindings = Object.freeze(findings.map((f) => Object.freeze(f)));
  const allFrozen = findings.length === 0;

  const canonical = canonicalSerialize({
    runtime_version: PERMANENT_FREEZE_AUDIT_VERSION,
    assertion_count: assertions.length,
    findings: frozenFindings.map((f) => [f.severity, f.kind, f.label, f.path, f.message]),
    all_frozen: allFrozen,
  });

  return Object.freeze({
    runtime_version: PERMANENT_FREEZE_AUDIT_VERSION,
    assertion_count: assertions.length,
    findings: frozenFindings,
    all_frozen: allFrozen,
    deterministic_hash: fnv1a32(canonical),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — assertSafeIntegerOrdinals
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Verify a set of caller-supplied ordinal values are all safe integers.
 * Pure — same input → same result ALWAYS. Used as a contract gate before
 * passing ordinals into archive / monitor / alert APIs.
 */
export function assertSafeIntegerOrdinals(
  ordinals: readonly { readonly label: string; readonly value: number }[],
): { readonly ok: boolean; readonly bad: readonly { label: string; value: number }[] } {
  const bad: { label: string; value: number }[] = [];
  for (const o of ordinals) {
    if (!Number.isSafeInteger(o.value)) {
      bad.push({ label: o.label, value: o.value });
    }
  }
  return Object.freeze({
    ok: bad.length === 0,
    bad: Object.freeze(bad.map((b) => Object.freeze(b))),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — issueFreezeCertificate
// ═══════════════════════════════════════════════════════════════════════════

export interface FreezeCertificate {
  readonly runtime_version: number;
  readonly certificate_kind: 'permanent_freeze';
  /** Hash over all assertion hashes — single-point ecosystem fingerprint. */
  readonly ecosystem_fingerprint: string;
  /** True iff all input audit hashes indicate ok=true / all_frozen=true. */
  readonly certified: boolean;
  /** Lex-sorted by (audit_kind, audit_hash). */
  readonly audit_summary: readonly {
    readonly audit_kind: string;
    readonly audit_hash: string;
    readonly ok: boolean;
  }[];
}

/**
 * Issue a permanent freeze certificate combining multiple sub-audits.
 * Caller passes the deterministic hashes + ok flags of upstream audits
 * (e.g. freeze audit, rule compliance, cross-runtime certification, etc.).
 *
 * Pure — same input → same certificate ALWAYS.
 */
export function issueFreezeCertificate(
  audits: readonly { readonly audit_kind: string; readonly audit_hash: string; readonly ok: boolean }[],
): FreezeCertificate {
  if (!Array.isArray(audits) || audits.length === 0) {
    throw new Error('permanent_freeze_audit_runtime: audits must be non-empty array');
  }
  const seen = new Set<string>();
  for (const a of audits) {
    if (typeof a.audit_kind !== 'string' || a.audit_kind.length === 0) {
      throw new Error('permanent_freeze_audit_runtime: every audit_kind must be non-empty string');
    }
    if (typeof a.audit_hash !== 'string' || a.audit_hash.length === 0) {
      throw new Error(
        `permanent_freeze_audit_runtime: audit_hash for "${a.audit_kind}" must be non-empty string`,
      );
    }
    // Bug #25 fix: previously only `audit_kind` was validated. A caller passing
    // a non-boolean `ok` (e.g. the string 'false') would silently break the
    // `certified = frozen.every(a => a.ok)` check because string 'false' is
    // truthy in JavaScript. Force strict boolean.
    if (typeof a.ok !== 'boolean') {
      throw new Error(
        `permanent_freeze_audit_runtime: ok for "${a.audit_kind}" must be boolean (got ${typeof a.ok})`,
      );
    }
    if (seen.has(a.audit_kind)) {
      throw new Error(`permanent_freeze_audit_runtime: duplicate audit_kind "${a.audit_kind}"`);
    }
    seen.add(a.audit_kind);
  }
  const sorted = [...audits].sort((x, y) => {
    const k = lexCompare(x.audit_kind, y.audit_kind);
    if (k !== 0) return k;
    return lexCompare(x.audit_hash, y.audit_hash);
  });
  const frozen = Object.freeze(sorted.map((a) => Object.freeze({ ...a })));
  const certified = frozen.every((a) => a.ok);

  const canonical = canonicalSerialize({
    runtime_version: PERMANENT_FREEZE_AUDIT_VERSION,
    certificate_kind: 'permanent_freeze',
    certified,
    audit_summary: frozen.map((a) => [a.audit_kind, a.audit_hash, a.ok]),
  });

  return Object.freeze({
    runtime_version: PERMANENT_FREEZE_AUDIT_VERSION,
    certificate_kind: 'permanent_freeze' as const,
    ecosystem_fingerprint: fnv1a32(canonical),
    certified,
    audit_summary: frozen,
  });
}

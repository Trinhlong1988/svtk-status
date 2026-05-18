/**
 * DETERMINISTIC CI PIPELINE — CMD4 Phase 14 Module 1.
 *
 * Production-grade deterministic CI validation runtime — orchestrator that
 * composes Phase 12+13+M4 modules into a single pre-merge gate.
 *
 * Brief v13 §TASK 1 responsibilities:
 *   1. replay-safe validation pipeline (Commit #2 validateProjectContent)
 *   2. export verification chain (Commit #3 serializeProjectContent + verifyExportArtifact)
 *   3. canonical hash gate (Phase 13 M2 validateSerializationHashes)
 *   4. cross-platform deterministic checks (lex sort + INT-only + Math.imul)
 *   5. pre-merge audit verification (Phase 13 M2 auditAgainstBaseline)
 *
 * MANDATORY (brief v13):
 *   - NO GitHub/GitLab API integration
 *   - Tooling-runtime ONLY
 *   - Same source → same export → same CI result ALWAYS
 *
 * In-memory deterministic ONLY — no live DB runtime, no IO except via
 * Commit #2 `ContentRegistryLoader` (which uses injectable FS adapter).
 *
 * Ownership: tooling layer (brief v13 §III).
 */
import {
  canonicalSerialize,
  fnv1a32,
  type SchemaRegistry,
  type AggregateReport,
} from './schema_validation_runtime.js';
import {
  ContentRegistryLoader,
  validateProjectContent,
  defaultSchemaNameFromFile,
  type ContentValidationOptions,
} from './content_registry_loader.js';
import {
  serializeProjectContent,
  verifyExportArtifact,
  type ExportArtifact,
  type VerifyExportResult,
} from './deterministic_export_pipeline.js';
import {
  inspectExportArtifact,
  type InspectionReport,
} from './replay_registry_inspector.js';
import {
  validateSerializationHashes,
  auditAgainstBaseline,
  type HashValidationReport,
  type BaselineAuditResult,
} from './serialization_hash_validator.js';
import {
  TelemetryRegistry,
  createTelemetrySnapshot,
  type TelemetrySnapshot,
} from './operational_telemetry_registry.js';
import {
  DeterminismLintRuntime,
  type DeterminismLintReport,
} from './determinism_lint_runtime.js';

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export const CI_PIPELINE_VERSION = 1 as const;

export interface CiPipelineOptions {
  /** Baseline artifact to compare against (e.g. main branch artifact). */
  readonly baseline_artifact?: ExportArtifact;
  /** Pinned expected `aggregate_hash` for replay verification (CI guard). */
  readonly expect_aggregate_hash?: string;
  /** Pinned expected `artifact.deterministic_hash` for replay verification. */
  readonly expect_artifact_hash?: string;
  /** Caller-provided content validation options (forwarded to Commit #2). */
  readonly validation?: ContentValidationOptions;
  /** Optional telemetry emit at end of pipeline. */
  readonly telemetry?: {
    readonly registry: TelemetryRegistry;
    /** Telemetry schema_id to emit under (e.g. 'ci_pipeline_run'). */
    readonly schema_id: string;
    /** Logical clock for the emission (caller-managed monotonic INT). */
    readonly ordinal: number;
  };
  /**
   * Optional determinism-lint gate. Runs BEFORE all other CI steps — if
   * lint finds CRITICAL violations, `passed` is false even if every other
   * check would have passed. Pure additive: omit to skip the step.
   *
   * Anti-regression gate (CMD4 — vá lỗ hổng 130 localeCompare ở CMD2+CMD3).
   */
  readonly determinism_lint?: {
    readonly workspaceRoot: string;
    readonly include?: readonly string[];
  };
}

export interface CiPipelineResult {
  readonly ci_pipeline_version: number;
  readonly passed: boolean;
  readonly validation: AggregateReport;
  readonly artifact: ExportArtifact;
  readonly verify: VerifyExportResult;
  readonly inspection: InspectionReport;
  readonly hash_validation: HashValidationReport;
  readonly baseline_audit?: BaselineAuditResult;
  readonly expected_aggregate_hash_match?: boolean;
  readonly expected_artifact_hash_match?: boolean;
  readonly telemetry_snapshot?: TelemetrySnapshot;
  /** Determinism-lint report, if `options.determinism_lint` was set. */
  readonly determinism_lint?: DeterminismLintReport;
  /** FNV-1a 32-bit hash of the full CI result (excluding self). */
  readonly ci_deterministic_hash: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal — canonical CI result hash input
// ═══════════════════════════════════════════════════════════════════════════

function canonicalCiResultInput(result: Omit<CiPipelineResult, 'ci_deterministic_hash'>): string {
  return canonicalSerialize({
    ci_pipeline_version: result.ci_pipeline_version,
    passed: result.passed,
    validation_passed: result.validation.passed,
    validation_hash: result.validation.deterministic_hash,
    artifact_hash: result.artifact.deterministic_hash,
    verify_ok: result.verify.ok,
    inspection_ok: result.inspection.ok,
    inspection_hash: result.inspection.deterministic_hash,
    hash_validation_ok: result.hash_validation.ok,
    hash_validation_hash: result.hash_validation.deterministic_hash,
    baseline_audit_ok: result.baseline_audit?.ok ?? null,
    baseline_audit_comparison_hash: result.baseline_audit?.comparison_hash ?? null,
    expected_aggregate_hash_match: result.expected_aggregate_hash_match ?? null,
    expected_artifact_hash_match: result.expected_artifact_hash_match ?? null,
    telemetry_snapshot_hash: result.telemetry_snapshot?.deterministic_hash ?? null,
    determinism_lint_critical: result.determinism_lint?.summary.by_severity.CRITICAL ?? null,
    determinism_lint_file_count: result.determinism_lint?.file_count ?? null,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — runDeterministicCiPipeline
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run the full CI validation pipeline:
 *   1. Load + validate content (Commit #2)
 *   2. Serialize artifact (Commit #3)
 *   3. Verify artifact (Commit #3)
 *   4. Inspect artifact (Phase 13 M1)
 *   5. Validate hash integrity (Phase 13 M2)
 *   6. (Optional) Audit against baseline
 *   7. (Optional) Compare against pinned expected hashes
 *   8. (Optional) Emit telemetry snapshot
 *
 * Returns frozen `CiPipelineResult`. Same input → same result ALWAYS.
 *
 * NEVER throws on validation failure — gate decision is `result.passed`.
 * Caller (CI script) checks `result.passed` and exits 0/1 accordingly.
 *
 * Em DOES throw on caller bugs (e.g. unknown telemetry schema_id, agg/content
 * key mismatch) — those are programmer errors, not validation outcomes.
 */
export function runDeterministicCiPipeline(
  loader: ContentRegistryLoader,
  dirPath: string,
  registry: SchemaRegistry,
  options?: CiPipelineOptions,
): CiPipelineResult {
  // Step 0 (optional): Determinism lint — fail FAST before any other work.
  let lintReport: DeterminismLintReport | undefined;
  if (options?.determinism_lint !== undefined) {
    const lint = new DeterminismLintRuntime({
      workspaceRoot: options.determinism_lint.workspaceRoot,
      ...(options.determinism_lint.include !== undefined
        ? { include: options.determinism_lint.include }
        : {}),
    });
    lintReport = lint.scanWorkspace();
  }

  // Step 1-2: Validate + serialize.
  const aggregate = validateProjectContent(loader, dirPath, registry, options?.validation);

  // Build content map mirror for serialize (matches what validateProjectContent built internally).
  // Em re-load to get the exact frozen content map; loadAllContent is deterministic.
  const contentMap = loader.loadAllContent(dirPath, options?.validation?.load);
  const contentByName: Record<string, unknown> = {};
  const mapper = options?.validation?.schemaNameFromFile ?? defaultSchemaNameFromFile;
  for (const [fileName, value] of contentMap) {
    contentByName[mapper(fileName)] = value;
  }

  const artifact = serializeProjectContent(aggregate, registry, contentByName);

  // Step 3: Verify artifact.
  const verify = verifyExportArtifact(artifact);

  // Step 4: Inspect artifact.
  const inspection = inspectExportArtifact(artifact);

  // Step 5: Validate hashes (collect ALL divergences).
  const hashValidation = validateSerializationHashes(artifact);

  // Step 6: Baseline audit (optional).
  let baselineAudit: BaselineAuditResult | undefined;
  if (options?.baseline_artifact !== undefined) {
    baselineAudit = auditAgainstBaseline(artifact, options.baseline_artifact);
  }

  // Step 7: Expected hash gates (optional).
  let expectedAggMatch: boolean | undefined;
  let expectedArtMatch: boolean | undefined;
  if (options?.expect_aggregate_hash !== undefined) {
    expectedAggMatch = artifact.aggregate_hash === options.expect_aggregate_hash;
  }
  if (options?.expect_artifact_hash !== undefined) {
    expectedArtMatch = artifact.deterministic_hash === options.expect_artifact_hash;
  }

  // Compute aggregate passed flag.
  const lintPassed = lintReport === undefined || lintReport.summary.by_severity.CRITICAL === 0;
  const passed =
    lintPassed &&
    aggregate.passed &&
    verify.ok &&
    inspection.ok &&
    hashValidation.ok &&
    (baselineAudit?.ok ?? true) &&
    (expectedAggMatch ?? true) &&
    (expectedArtMatch ?? true);

  // Step 8: Telemetry (optional, parallel pipeline — does NOT affect any hash above).
  let telemetrySnapshot: TelemetrySnapshot | undefined;
  if (options?.telemetry !== undefined) {
    const t = options.telemetry;
    telemetrySnapshot = createTelemetrySnapshot(
      t.registry,
      t.schema_id,
      {
        artifact_hash: artifact.deterministic_hash,
        passed,
        artifact_content_count: artifact.artifact_content_count,
      },
      t.ordinal,
    );
  }

  const partial: Omit<CiPipelineResult, 'ci_deterministic_hash'> = {
    ci_pipeline_version: CI_PIPELINE_VERSION,
    passed,
    validation: aggregate,
    artifact,
    verify,
    inspection,
    hash_validation: hashValidation,
    baseline_audit: baselineAudit,
    expected_aggregate_hash_match: expectedAggMatch,
    expected_artifact_hash_match: expectedArtMatch,
    telemetry_snapshot: telemetrySnapshot,
    determinism_lint: lintReport,
  };

  return Object.freeze({
    ...partial,
    ci_deterministic_hash: fnv1a32(canonicalCiResultInput(partial)),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// CI exit-code helper (caller convenience)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Translate a `CiPipelineResult` to a POSIX exit code:
 *   0 = passed
 *   1 = failed (any divergence)
 *
 * Pure function — em does NOT call `process.exit`. Caller decides.
 */
export function ciExitCode(result: CiPipelineResult): 0 | 1 {
  return result.passed ? 0 : 1;
}

/**
 * Human-readable summary of CI result for log output.
 * Deterministic — same result → same summary string ALWAYS.
 */
export function ciSummary(result: CiPipelineResult): string {
  const lines: string[] = [
    `[CI] passed=${String(result.passed)}`,
    `[CI] validation_passed=${String(result.validation.passed)} findings=${String(result.validation.total_findings)}`,
    `[CI] artifact_hash=${result.artifact.deterministic_hash}`,
    `[CI] verify_ok=${String(result.verify.ok)}${result.verify.ok ? '' : ` (divergence: ${String(result.verify.divergence_field)})`}`,
    `[CI] inspection_ok=${String(result.inspection.ok)} findings=${String(result.inspection.findings.length)}`,
    `[CI] hash_validation_ok=${String(result.hash_validation.ok)} divergences=${String(result.hash_validation.divergences.length)}`,
  ];
  if (result.baseline_audit !== undefined) {
    lines.push(
      `[CI] baseline_audit_ok=${String(result.baseline_audit.ok)} diverged=${String(result.baseline_audit.diverged_fields.length)}`,
    );
  }
  if (result.expected_aggregate_hash_match !== undefined) {
    lines.push(`[CI] expected_aggregate_hash_match=${String(result.expected_aggregate_hash_match)}`);
  }
  if (result.expected_artifact_hash_match !== undefined) {
    lines.push(`[CI] expected_artifact_hash_match=${String(result.expected_artifact_hash_match)}`);
  }
  if (result.telemetry_snapshot !== undefined) {
    lines.push(`[CI] telemetry_hash=${result.telemetry_snapshot.deterministic_hash}`);
  }
  if (result.determinism_lint !== undefined) {
    const dl = result.determinism_lint;
    lines.push(
      `[CI] determinism_lint files=${String(dl.file_count)} CRITICAL=${String(dl.summary.by_severity.CRITICAL)} WARN=${String(dl.summary.by_severity.WARN)} INFO=${String(dl.summary.by_severity.INFO)}`,
    );
  }
  lines.push(`[CI] ci_deterministic_hash=${result.ci_deterministic_hash}`);
  return lines.join('\n');
}

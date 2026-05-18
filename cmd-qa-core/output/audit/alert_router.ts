/**
 * ALERT ROUTER — Phase 13 Tuần 3 (CMD4, LOCAL variant per addendum 90ee3c2).
 *
 * Single entry point that game code calls to raise an alert:
 *
 *   alertRouter.fire({ severity, kind, source_id, message, context });
 *
 * The router:
 *   1. Stamps an ISO timestamp (wall-clock — alerts are NOT replay-affecting
 *      per `alert_aggregation_runtime.ts` §M2).
 *   2. Fan-outs to every registered `AlertSink` (Console + File + Discord-
 *      scaffold by default).
 *   3. Bumps the `alert_errors_total{severity,kind}` Prometheus counter so
 *      Grafana panel #6 can chart alert rates.
 *
 * Convenience helpers:
 *   - `fireBan(...)`           CMD1 anti-cheat ban pipeline (Tuần 3)
 *   - `observeBotScore(...)`   CMD2 anti-bot score capture + auto-alert
 *                              when score crosses `botScoreAlertThreshold`
 *                              (default 80, per spec §4.3).
 *   - `noteWsDrop(reason)`     bumps the per-reason ws drop counter; rate
 *                              surge is observed via Grafana on
 *                              `rate(ws_drops_total[1m])`.
 *
 * Layer 3 server infrastructure. Sinks own their own IO; the router only
 * fans out. Sink errors are swallowed + logged via the same router to
 * prevent one bad sink from blocking the rest.
 */
import {
  ALERT_SEVERITY,
  type AlertSeverity,
} from '../tools/alert_aggregation_runtime.js';
import type { AlertEvent, AlertSink } from './alert_sink.js';
import type { SvtkMetricSet } from './metrics.js';

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface AlertInput {
  readonly severity: AlertSeverity;
  readonly kind: string;
  readonly source_id: string;
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface BanEventInput {
  readonly source_id: string;
  /** Stable category string identifying the offence (used as alert kind). */
  readonly reason: string;
  readonly message?: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
}

export interface AlertRouterOpts {
  readonly sinks: readonly AlertSink[];
  readonly metrics: SvtkMetricSet;
  /** Override clock for tests — must return ISO-8601 UTC. */
  readonly nowIso?: () => string;
  /** Bot score >= this triggers an auto-alert. Default 80 per spec §4.3. */
  readonly botScoreAlertThreshold?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// AlertRouter
// ═══════════════════════════════════════════════════════════════════════════

export class AlertRouter {
  private readonly sinks: readonly AlertSink[];
  private readonly metrics: SvtkMetricSet;
  private readonly nowIso: () => string;
  private readonly botScoreThreshold: number;

  constructor(opts: AlertRouterOpts) {
    this.sinks = opts.sinks;
    this.metrics = opts.metrics;
    // eslint-disable-next-line no-restricted-syntax
    this.nowIso = opts.nowIso ?? (() => new Date().toISOString());
    this.botScoreThreshold = opts.botScoreAlertThreshold ?? 80;
  }

  /** Primary entry — fan-out to every sink. Sink errors are isolated. */
  async fire(input: AlertInput): Promise<readonly SinkResult[]> {
    const event: AlertEvent = {
      timestamp: this.nowIso(),
      severity: input.severity,
      kind: input.kind,
      source_id: input.source_id,
      message: input.message,
      ...(input.context !== undefined ? { context: input.context } : {}),
    };
    this.metrics.alertErrorsTotal.inc({
      severity: severityMetricLabel(input.severity),
      kind: input.kind,
    });
    const results: SinkResult[] = [];
    for (const sink of this.sinks) {
      try {
        await sink.emit(event);
        results.push({ sink: sink.name, ok: true });
      } catch (err) {
        results.push({
          sink: sink.name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Convenience entry points
  // ───────────────────────────────────────────────────────────────────────

  /** CMD1 anti-cheat ban event — Tuần 3 wire. */
  async fireBan(input: BanEventInput): Promise<readonly SinkResult[]> {
    const ctx: Record<string, unknown> = { reason: input.reason };
    if (input.evidence !== undefined) ctx['evidence'] = input.evidence;
    return this.fire({
      severity: ALERT_SEVERITY.ERROR,
      kind: `ban_${input.reason}`,
      source_id: input.source_id,
      message: input.message ?? `Player ${input.source_id} banned (${input.reason})`,
      context: ctx,
    });
  }

  /**
   * CMD2 anti-bot — feed score (0–100) into the histogram for percentile
   * tracking AND emit an alert when the score crosses the threshold. The
   * threshold-crossing alert is what makes panel #5 (bot score distribution)
   * actionable in the dashboard.
   */
  async observeBotScore(sourceId: string, score: number): Promise<void> {
    this.metrics.botScore.observe(score);
    if (score < this.botScoreThreshold) return;
    await this.fire({
      severity: ALERT_SEVERITY.WARNING,
      kind: 'bot_high_score',
      source_id: sourceId,
      message: `Bot likelihood ${score} ≥ threshold ${this.botScoreThreshold}`,
      context: { score, threshold: this.botScoreThreshold },
    });
  }

  /**
   * Boot.ts wires this from the Socket.IO `disconnect` listener. Bumps the
   * counter; Grafana panel #4 reads `rate(ws_drops_total[1m])` for the
   * surge alert (no code-driven threshold here — Prom rule territory).
   */
  noteWsDrop(reason: string): void {
    this.metrics.wsDropsTotal.inc({ reason });
  }

  /**
   * Optional shutdown flush — boot.ts calls during SIGTERM so the file
   * sink can drain its buffered write chain before the process exits.
   */
  async flush(): Promise<void> {
    for (const sink of this.sinks) {
      if (sink.flush !== undefined) await sink.flush();
    }
  }
}

export interface SinkResult {
  readonly sink: string;
  readonly ok: boolean;
  readonly error?: string;
}

function severityMetricLabel(severity: AlertSeverity): string {
  if (severity === ALERT_SEVERITY.ERROR) return 'error';
  if (severity === ALERT_SEVERITY.WARNING) return 'warning';
  if (severity === ALERT_SEVERITY.INFO) return 'info';
  return `unknown_${severity}`;
}

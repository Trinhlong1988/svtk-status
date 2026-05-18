/**
 * ALERT SINKS — Phase 13 Tuần 3 (CMD4, LOCAL variant per addendum 90ee3c2).
 *
 * The alert router (`alert_router.ts`) fan-outs each emitted `AlertEvent`
 * to every registered sink. Three sinks ship in this phase:
 *
 *   ConsoleAlertSink   — writes a single-line JSON record to stderr so the
 *                        existing docker compose log capture picks it up.
 *   FileAlertSink      — appends NDJSON to `logs/alert-YYYY-MM-DD.log`,
 *                        rotating on UTC date boundary. Mounted as the
 *                        `applogs` Docker volume in docker-compose.yml.
 *   DiscordWebhookSink — scaffold + TODO marker. Deferred per addendum
 *                        until 0-bug 100%. The constructor still accepts a
 *                        webhook URL so a future flip-the-switch CL is
 *                        trivial; the `emit()` method is a no-op while
 *                        `DISCORD_WEBHOOK_URL` is unset.
 *
 * Layer 3 server infrastructure. NOT replay-affecting (per
 * `alert_aggregation_runtime.ts` §M2: alert metadata MUST NEVER affect
 * replay hash / archive checksum). Wall-clock timestamps are fine here
 * because alerts are forensics, not gameplay.
 */
import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';

import { ALERT_SEVERITY, type AlertSeverity } from '../tools/alert_aggregation_runtime.js';

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface AlertEvent {
  /** Wall-clock ISO timestamp — operator-facing only, NOT replay-safe. */
  readonly timestamp: string;
  readonly severity: AlertSeverity;
  /** Stable category (e.g. `bot_high_score`, `ws_drop_surge`, `error_rate_high`). */
  readonly kind: string;
  /** Source identifier — character id, IP hash, anti-cheat module name, etc. */
  readonly source_id: string;
  readonly message: string;
  /** Free-form structured context. JSON-serialised on emit. */
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface AlertSink {
  readonly name: string;
  emit(event: AlertEvent): Promise<void>;
  /** Optional flush — called by router on shutdown. Default no-op. */
  flush?(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Severity label mapping
// ═══════════════════════════════════════════════════════════════════════════

const SEVERITY_LABEL: Readonly<Record<AlertSeverity, string>> = Object.freeze({
  [ALERT_SEVERITY.ERROR]: 'ERROR',
  [ALERT_SEVERITY.WARNING]: 'WARNING',
  [ALERT_SEVERITY.INFO]: 'INFO',
});

export function severityLabel(severity: AlertSeverity): string {
  return SEVERITY_LABEL[severity] ?? `UNKNOWN(${severity})`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Canonical NDJSON serialisation (deterministic for tests)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Stable JSON shape: keys emitted in fixed order so file diffs are
 * deterministic across runs. `context` is opt-in.
 */
export function serializeAlert(event: AlertEvent): string {
  const payload: Record<string, unknown> = {
    timestamp: event.timestamp,
    severity: severityLabel(event.severity),
    kind: event.kind,
    source_id: event.source_id,
    message: event.message,
  };
  if (event.context !== undefined) payload['context'] = event.context;
  return JSON.stringify(payload);
}

// ═══════════════════════════════════════════════════════════════════════════
// ConsoleAlertSink
// ═══════════════════════════════════════════════════════════════════════════

export interface ConsoleWriter {
  write(line: string): void;
}

const STDERR_WRITER: ConsoleWriter = {
  write(line: string): void {
    // eslint-disable-next-line no-console
    process.stderr.write(line + '\n');
  },
};

export class ConsoleAlertSink implements AlertSink {
  readonly name = 'console';
  private readonly writer: ConsoleWriter;

  constructor(writer: ConsoleWriter = STDERR_WRITER) {
    this.writer = writer;
  }

  async emit(event: AlertEvent): Promise<void> {
    this.writer.write(`[alert] ${serializeAlert(event)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FileAlertSink — append-only NDJSON, rotates daily (UTC)
// ═══════════════════════════════════════════════════════════════════════════

export interface FileAlertSinkOpts {
  /** Directory for `alert-YYYY-MM-DD.log` files. Created on first emit. */
  readonly directory: string;
  /** Override clock for tests — must return a YYYY-MM-DD string. */
  readonly dateProvider?: () => string;
}

/** Returns the current UTC date as `YYYY-MM-DD`. */
function defaultDateProvider(): string {
  // eslint-disable-next-line no-restricted-syntax
  return new Date().toISOString().slice(0, 10);
}

export class FileAlertSink implements AlertSink {
  readonly name = 'file';
  private readonly directory: string;
  private readonly dateProvider: () => string;
  private bufferedWriteChain: Promise<void> = Promise.resolve();

  constructor(opts: FileAlertSinkOpts) {
    this.directory = opts.directory;
    this.dateProvider = opts.dateProvider ?? defaultDateProvider;
  }

  private currentPath(): string {
    return join(this.directory, `alert-${this.dateProvider()}.log`);
  }

  async emit(event: AlertEvent): Promise<void> {
    // Serialise writes so concurrent emits do not interleave inside a line.
    const line = serializeAlert(event) + '\n';
    const path = this.currentPath();
    this.bufferedWriteChain = this.bufferedWriteChain.then(async () => {
      await fsp.mkdir(dirname(path), { recursive: true });
      await fsp.appendFile(path, line, { encoding: 'utf8' });
    });
    return this.bufferedWriteChain;
  }

  async flush(): Promise<void> {
    return this.bufferedWriteChain;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DiscordWebhookSink — DEFERRED per addendum 90ee3c2
// ═══════════════════════════════════════════════════════════════════════════

export interface DiscordWebhookSinkOpts {
  /** Webhook URL. Empty / undefined → emit is a no-op (sink is dormant). */
  readonly webhookUrl?: string;
  /** Injectable fetch — default global fetch. */
  readonly httpFetch?: typeof fetch;
}

/**
 * Scaffold for the Discord webhook sink.
 *
 * TODO(addendum 90ee3c2): wire HTTP POST to webhook URL when LOCAL-ONLY
 * is lifted. Until then, `emit()` is a no-op and the constructor accepts
 * an empty URL so production env can run without configuration.
 */
export class DiscordWebhookSink implements AlertSink {
  readonly name = 'discord';
  private readonly webhookUrl: string;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private readonly httpFetch: typeof fetch;

  constructor(opts: DiscordWebhookSinkOpts = {}) {
    this.webhookUrl = opts.webhookUrl ?? '';
    this.httpFetch = opts.httpFetch ?? fetch;
  }

  isActive(): boolean {
    return this.webhookUrl.length > 0;
  }

  async emit(_event: AlertEvent): Promise<void> {
    if (!this.isActive()) return;
    // TODO(addendum 90ee3c2 lifted): POST to this.webhookUrl with payload:
    //   { content: `[${severityLabel(event.severity)}] ${event.kind} — ${event.message}` }
    // Discord rate-limit: 30 requests / 60 s per webhook — implement
    // token-bucket throttling before flipping the switch.
  }
}

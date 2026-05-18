/**
 * REPLAY PAYLOAD SANITIZER — strip non-deterministic fields (Phase 11 follow-on).
 *
 * Per CMD1.docx Phase 11 § VII "no silent replay drift" + § IV "REPORT FIRST,
 * NO silent redesign" — additive helper that wraps any payload `Record<string, unknown>`
 * and removes fields known to be non-deterministic (wall-clock timestamps,
 * absolute file paths, process pid, hostname).
 *
 * Caller pattern (live runtime → replay storage):
 *   ```
 *   const safe = sanitizeForReplay(payload);
 *   appendEvent(stream, turn, kind, safe);
 *   ```
 *
 * STRICT additive — existing callers continue with raw payload; this is opt-in.
 * The frame checksum (`replay_frame.ts`) already excludes timestamps so
 * combat-replay determinism is not affected. This helper is for downstream
 * consumers (UI / replay viewer / external pipeline) that compare event payloads.
 */

// Fields known to vary across replay runs.
const NON_DETERMINISTIC_FIELDS: readonly string[] = [
  'timestamp',
  'wall_time',
  'process_pid',
  'hostname',
  'realtime_ms',
  'absolute_path',
  'instance_uuid',
];

export interface SanitizeReport {
  removed: readonly string[];
  fieldsBefore: number;
  fieldsAfter: number;
}

/**
 * Return a new payload object with non-deterministic fields stripped.
 * Original object is NOT mutated.
 */
export function sanitizeForReplay<T extends Readonly<Record<string, unknown>>>(
  payload: T,
): { sanitized: Record<string, unknown>; report: SanitizeReport } {
  const sanitized: Record<string, unknown> = {};
  const removed: string[] = [];
  for (const key of Object.keys(payload)) {
    if (NON_DETERMINISTIC_FIELDS.includes(key)) {
      removed.push(key);
      continue;
    }
    sanitized[key] = payload[key];
  }
  return {
    sanitized,
    report: {
      removed,
      fieldsBefore: Object.keys(payload).length,
      fieldsAfter: Object.keys(sanitized).length,
    },
  };
}

/**
 * Same as sanitizeForReplay but with custom strip-list (additive — caller may
 * extend the default).
 */
export function sanitizeForReplayWith<T extends Readonly<Record<string, unknown>>>(
  payload: T,
  extraStripFields: readonly string[],
): { sanitized: Record<string, unknown>; report: SanitizeReport } {
  const sanitized: Record<string, unknown> = {};
  const removed: string[] = [];
  const fullList = [...NON_DETERMINISTIC_FIELDS, ...extraStripFields];
  for (const key of Object.keys(payload)) {
    if (fullList.includes(key)) {
      removed.push(key);
      continue;
    }
    sanitized[key] = payload[key];
  }
  return {
    sanitized,
    report: {
      removed,
      fieldsBefore: Object.keys(payload).length,
      fieldsAfter: Object.keys(sanitized).length,
    },
  };
}

/**
 * Detect if a payload contains any known non-deterministic field — diagnostic
 * helper for audit pass without mutation.
 */
export function detectNonDeterministicFields(
  payload: Readonly<Record<string, unknown>>,
): readonly string[] {
  return Object.keys(payload).filter((k) => NON_DETERMINISTIC_FIELDS.includes(k));
}

/**
 * Bulk verify a list of payloads — for replay stream forensic audit.
 */
export function auditPayloadsForNonDeterminism(
  payloads: readonly Readonly<Record<string, unknown>>[],
): { offendingPayloads: number; totalFieldsFound: number; topField: string | undefined } {
  let offending = 0;
  let total = 0;
  const fieldCount = new Map<string, number>();
  for (const p of payloads) {
    const found = detectNonDeterministicFields(p);
    if (found.length > 0) {
      offending += 1;
      total += found.length;
      for (const f of found) fieldCount.set(f, (fieldCount.get(f) ?? 0) + 1);
    }
  }
  let topField: string | undefined;
  let topCount = 0;
  for (const [f, c] of fieldCount) {
    if (c > topCount) { topField = f; topCount = c; }
  }
  return { offendingPayloads: offending, totalFieldsFound: total, topField };
}

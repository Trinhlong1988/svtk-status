/**
 * MODIFIER RECURSION GUARD — Implementation (CMD2.docx FIX #1, Batch 3 APPROVED).
 *
 * Pure function tracker — KHÔNG global state. Per resolveSkillCast() instance.
 *
 * @see modifier_recursion_guard.ts (contract)
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { StatModifier } from './itemization_types.js';
import type {
  ModifierRecursionGuard,
  RecursionAbortMode,
  RecursionChainEntry,
  RecursionResult,
} from './modifier_recursion_guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(__dirname, '../../../data');

const RecursionConfigSchema = z.object({
  modifier_recursion: z.object({
    max_depth: z.number().int().positive(),
    abort_mode: z.enum(['abort_silently', 'abort_with_log', 'throw_error']),
  }),
}).passthrough();

let cachedConfig: { max_depth: number; abort_mode: RecursionAbortMode } | null = null;

/** Load config from itemization_constants.json (singleton cache). */
function loadConfig(): { max_depth: number; abort_mode: RecursionAbortMode } {
  if (cachedConfig) return cachedConfig;
  const raw = JSON.parse(readFileSync(join(DATA_ROOT, 'itemization_constants.json'), 'utf8'));
  const parsed = RecursionConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`[RecursionGuard] config FAIL:\n${JSON.stringify(parsed.error.issues, null, 2)}`);
  }
  cachedConfig = {
    max_depth: parsed.data.modifier_recursion.max_depth,
    abort_mode: parsed.data.modifier_recursion.abort_mode,
  };
  return cachedConfig;
}

/** Source kind extractor — derive từ source_item_id pattern. Pure function. */
function deriveSourceKind(source_item_id: string): RecursionChainEntry['source_kind'] {
  if (source_item_id.startsWith('passive_')) return 'passive';
  if (source_item_id.startsWith('companion_')) return 'companion_aura';
  if (source_item_id.startsWith('proc_')) return 'proc';
  if (source_item_id.startsWith('set_')) return 'set_bonus';
  return 'equipment';
}

/**
 * Factory: tạo instance ModifierRecursionGuard mới.
 * Per resolveSkillCast() pass có 1 instance — KHÔNG share state.
 */
export function createRecursionGuard(
  override?: { max_depth?: number; abort_mode?: RecursionAbortMode },
): ModifierRecursionGuard {
  const cfg = loadConfig();
  const max_depth = override?.max_depth ?? cfg.max_depth;
  const abort_mode = override?.abort_mode ?? cfg.abort_mode;

  return {
    maxDepth: max_depth,
    abortMode: abort_mode,

    hasCycle(source_id, chain) {
      for (let i = 0; i < chain.length; i++) {
        if (chain[i]!.source_id === source_id) return true;
      }
      return false;
    },

    tryApply(modifier: StatModifier, current_chain: readonly RecursionChainEntry[]): RecursionResult {
      const next_depth = current_chain.length;
      const source_id = modifier.source_item_id;

      // Cycle check FIRST (before depth) — cycle is hard fail regardless of depth
      if (this.hasCycle(source_id, current_chain)) {
        const result: RecursionResult = {
          status: 'aborted_cycle',
          final_depth: next_depth,
          chain_path: [...current_chain],
          dropped_modifier: source_id,
        };
        if (abort_mode === 'throw_error') {
          throw new Error(`[RecursionGuard] cycle detected: ${source_id} đã có trong chain depth=${next_depth}`);
        }
        if (this.onAbort) this.onAbort(result);
        return result;
      }

      // Depth check
      if (next_depth >= max_depth) {
        const result: RecursionResult = {
          status: 'aborted_max_depth',
          final_depth: next_depth,
          chain_path: [...current_chain],
          dropped_modifier: source_id,
        };
        if (abort_mode === 'throw_error') {
          throw new Error(`[RecursionGuard] max_depth ${max_depth} reached at ${source_id}`);
        }
        if (this.onAbort) this.onAbort(result);
        return result;
      }

      // OK — append entry
      const new_entry: RecursionChainEntry = {
        source_kind: deriveSourceKind(source_id),
        source_id,
        depth: next_depth,
      };
      return {
        status: 'ok',
        final_depth: next_depth + 1,
        chain_path: [...current_chain, new_entry],
      };
    },
  };
}

/** Test-only cache reset. */
export function _resetRecursionGuardCache(): void {
  cachedConfig = null;
}

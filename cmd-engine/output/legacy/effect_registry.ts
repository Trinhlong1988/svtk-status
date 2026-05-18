/**
 * EFFECT REGISTRY — plug-in pattern (Phase 2 spec).
 *
 * `EFFECT_HANDLERS[type]` Map dispatch. Anti-hardcode: thêm effect mới = add 1 handler entry,
 * KHÔNG đụng applyEffect / tickEffect / pipeline / formula.
 *
 * Spec rule:
 *   - Framework FIRST, specific effects later
 *   - Generic pipeline + category-driven + handler-driven
 *   - NO if(effect === "burn") anywhere
 */
import type { EffectType } from './types.js';
import type { EffectHandler } from './status_types.js';

class EffectRegistry {
  private handlers = new Map<EffectType, EffectHandler>();

  /** Register a handler. Throws on duplicate. */
  register(handler: EffectHandler): void {
    if (this.handlers.has(handler.type)) {
      throw new Error(`[EffectRegistry] duplicate handler for type '${handler.type}'`);
    }
    this.handlers.set(handler.type, handler);
  }

  /** Bulk register. */
  registerAll(handlers: readonly EffectHandler[]): void {
    for (const h of handlers) this.register(h);
  }

  /** Get handler. Returns undefined if not registered. */
  get(type: EffectType): EffectHandler | undefined {
    return this.handlers.get(type);
  }

  /** Get or throw — caller wants guaranteed handler. */
  getOrThrow(type: EffectType): EffectHandler {
    const h = this.handlers.get(type);
    if (!h) throw new Error(`[EffectRegistry] no handler registered for type '${type}'`);
    return h;
  }

  has(type: EffectType): boolean {
    return this.handlers.has(type);
  }

  /** All registered types (for diagnostics / coverage report). */
  allTypes(): readonly EffectType[] {
    return [...this.handlers.keys()];
  }

  /** Test-only — clear all handlers. */
  _reset(): void {
    this.handlers.clear();
  }

  /** Count registered handlers. */
  size(): number {
    return this.handlers.size;
  }
}

/**
 * Singleton — encounter loop + tests share registry. Module 2 register handlers
 * at boot time (`registerStandardHandlers()` called once).
 */
export const effectRegistry = new EffectRegistry();

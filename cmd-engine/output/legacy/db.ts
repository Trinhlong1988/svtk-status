/**
 * DATA-DRIVEN FRAMEWORK (R3 + R16 + Single Source of Truth).
 *
 * Mọi entity (skill/NPC/item/boss/quest) load từ JSON qua DB registry.
 * Zod validate khi load — sai schema = crash sớm, không silent bug.
 *
 * Usage:
 *   const skill = SkillDB.get('skill_kim_cuong_tram');
 *   if (!skill) throw new Error('Skill not found');
 *
 * KHÔNG hardcode if (skillId === '...') — lint rule cấm.
 */
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(__dirname, '../../data');

/**
 * Generic DataDB — singleton registry per entity type.
 *
 * Load JSON file → Zod validate → Map<id, entity>.
 */
export class DataDB<T extends { id: string }> {
  private entities = new Map<string, T>();
  private loaded = false;

  constructor(
    private readonly name: string,
    private readonly fileName: string,
    private readonly schema: z.ZodType<T>,
  ) {}

  /** Load + validate JSON file. Crash sớm nếu sai schema. */
  load(): void {
    if (this.loaded) return;
    const filePath = join(DATA_ROOT, this.fileName);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (err) {
      throw new Error(`[${this.name}DB] Failed to read ${filePath}: ${(err as Error).message}`);
    }

    const ArraySchema = z.array(this.schema);
    const parsed = ArraySchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `[${this.name}DB] Schema validation FAILED for ${filePath}:\n${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }

    for (const entity of parsed.data) {
      if (this.entities.has(entity.id)) {
        throw new Error(`[${this.name}DB] Duplicate id: ${entity.id}`);
      }
      this.entities.set(entity.id, entity);
    }
    this.loaded = true;
  }

  /** Get entity by ID. Returns undefined nếu không có (caller phải check). */
  get(id: string): T | undefined {
    if (!this.loaded) this.load();
    return this.entities.get(id);
  }

  /** Get entity hoặc throw. Dùng khi caller tin entity phải tồn tại. */
  getOrThrow(id: string): T {
    const e = this.get(id);
    if (!e) throw new Error(`[${this.name}DB] Entity not found: ${id}`);
    return e;
  }

  /** All entities — dùng cho simulator / migration / test. */
  all(): T[] {
    if (!this.loaded) this.load();
    return Array.from(this.entities.values());
  }

  /** Filter by predicate. */
  filter(pred: (e: T) => boolean): T[] {
    return this.all().filter(pred);
  }

  /** Count loaded entities. */
  count(): number {
    if (!this.loaded) this.load();
    return this.entities.size;
  }

  /** Reload (test only — không dùng production). */
  reload(): void {
    this.entities.clear();
    this.loaded = false;
    this.load();
  }
}

// ───────── Constants loader (40 CONST từ constants.json) ─────────
export class ConstantsLoader {
  private cached: Record<string, number> | null = null;

  load<T extends Record<string, z.ZodType>>(schema: z.ZodObject<T>): z.infer<typeof schema> {
    if (this.cached === null) {
      const filePath = join(DATA_ROOT, 'constants.json');
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, number>;
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`[Constants] Schema FAILED:\n${JSON.stringify(parsed.error.issues, null, 2)}`);
      }
      this.cached = parsed.data as Record<string, number>;
    }
    return this.cached as z.infer<typeof schema>;
  }
}

export const Constants = new ConstantsLoader();

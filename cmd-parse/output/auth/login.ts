/**
 * LOGIN — email + password → JWT access + refresh.
 *
 * Phase 13 Tuần 1 (CMD4). Wires:
 *   - `password_hash.verifyPassword` (argon2id)
 *   - `session.issueAccessToken` + `issueRefreshToken` (HS256)
 *   - `PlayerRepo` (interface — pg adapter ships in Tuần 2 with CMD2)
 *
 * Pure async function — HTTP layer in `boot.ts` parses body, calls `login()`,
 * maps the discriminated result to a status code.
 *
 * Layer 3 server infrastructure. Time fields integer seconds. No combat math.
 *
 * Rate limiting + captcha gating are CMD2 anti-bot scope (Tuần 2). This
 * module exposes `hook.beforeVerify` so CMD2 can plug an IP gate without
 * touching login.ts internals.
 */
import { z } from 'zod';
import { verifyPassword } from './password_hash.js';
import {
  issueAccessToken,
  issueRefreshToken,
  type IssuedToken,
} from './session.js';

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

/** Player row shape consumed by login. Subset of CMD2 migration `players`. */
export interface PlayerRow {
  readonly id: string | number;
  readonly email: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly zaloId?: string | null;
}

export interface PlayerRepo {
  findByEmail(email: string): Promise<PlayerRow | null>;
  updateLastLogin(playerId: PlayerRow['id'], nowIso: string): Promise<void>;
}

export type LoginRejectReason =
  | 'invalid_request'
  | 'unknown_user'
  | 'bad_password'
  | 'rate_limited'
  | 'captcha_required';

export type LoginResult =
  | {
      readonly success: true;
      readonly playerId: string;
      readonly access: IssuedToken;
      readonly refresh: IssuedToken;
    }
  | { readonly success: false; readonly reason: LoginRejectReason };

export interface LoginConfig {
  readonly jwtSecret: string;
  readonly accessTtlSec: number;
  readonly refreshTtlSec: number;
}

export interface LoginHook {
  /**
   * Called BEFORE the password verify. Return `{ allow: false, reason }` to
   * short-circuit (rate limit / captcha gate / shadow ban). CMD2 wires the
   * concrete implementations here in Tuần 2.
   */
  beforeVerify?(req: LoginRequest, player: PlayerRow | null): Promise<HookDecision>;
}

export type HookDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: LoginRejectReason };

export interface LoginDeps {
  readonly playerRepo: PlayerRepo;
  readonly config: LoginConfig;
  readonly hook?: LoginHook;
  /** Override clock for tests — integer Unix seconds. */
  readonly nowSec?: number;
  /** Override ISO clock for `updateLastLogin` — defaults to new Date().toISOString(). */
  readonly nowIso?: string;
  /** Override jti for deterministic tests. */
  readonly accessJti?: string;
  readonly refreshJti?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Request schema (Zod)
// ═══════════════════════════════════════════════════════════════════════════

export const LoginRequestSchema = z.object({
  email: z.string().email().min(3).max(254),
  password: z.string().min(1).max(1024),
});

export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export function parseLoginRequest(
  body: unknown,
): { readonly ok: true; readonly req: LoginRequest } | { readonly ok: false } {
  const parsed = LoginRequestSchema.safeParse(body);
  if (!parsed.success) return { ok: false };
  return { ok: true, req: parsed.data };
}

// ═══════════════════════════════════════════════════════════════════════════
// login()
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Verify credentials and issue tokens.
 *
 * Failure modes return discriminated `{ success: false, reason }` — caller
 * maps to HTTP status (400 invalid_request / 401 bad_password+unknown_user /
 * 429 rate_limited / 403 captcha_required).
 *
 * Timing note: this implementation returns `unknown_user` without performing
 * a dummy hash compare. CMD2 anti-bot rate-limit at IP layer is the primary
 * defense against enumeration. A constant-time dummy verify can be added in
 * Tuần 2 if Mr.Long deems enumeration timing leakage in-scope.
 */
export async function login(req: LoginRequest, deps: LoginDeps): Promise<LoginResult> {
  const player = await deps.playerRepo.findByEmail(req.email.toLowerCase());

  if (deps.hook?.beforeVerify) {
    const decision = await deps.hook.beforeVerify(req, player);
    if (!decision.allow) {
      return { success: false, reason: decision.reason };
    }
  }

  if (!player) {
    return { success: false, reason: 'unknown_user' };
  }

  const passOk = await verifyPassword(player.passwordHash, req.password);
  if (!passOk) {
    return { success: false, reason: 'bad_password' };
  }

  const playerIdStr = String(player.id);
  const baseIssue = {
    secret: deps.config.jwtSecret,
    userId: playerIdStr,
    ...(deps.nowSec !== undefined ? { nowSec: deps.nowSec } : {}),
  };

  const access = issueAccessToken({
    ...baseIssue,
    ttlSec: deps.config.accessTtlSec,
    ...(deps.accessJti !== undefined ? { jti: deps.accessJti } : {}),
  });
  const refresh = issueRefreshToken({
    ...baseIssue,
    ttlSec: deps.config.refreshTtlSec,
    ...(deps.refreshJti !== undefined ? { jti: deps.refreshJti } : {}),
  });

  // eslint-disable-next-line no-restricted-syntax
  const nowIso = deps.nowIso ?? new Date().toISOString();
  await deps.playerRepo.updateLastLogin(player.id, nowIso);

  return { success: true, playerId: playerIdStr, access, refresh };
}

// ═══════════════════════════════════════════════════════════════════════════
// In-memory PlayerRepo (test + dev default)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * In-memory implementation — Tuần 1 default. CMD2 ships pg-backed adapter in
 * Tuần 1 (parallel) that satisfies the same interface.
 */
export class InMemoryPlayerRepo implements PlayerRepo {
  private readonly byEmail = new Map<string, PlayerRow & { lastLoginIso?: string }>();

  constructor(seed: readonly PlayerRow[] = []) {
    for (const p of seed) this.byEmail.set(p.email.toLowerCase(), { ...p });
  }

  async findByEmail(email: string): Promise<PlayerRow | null> {
    const row = this.byEmail.get(email.toLowerCase());
    return row ?? null;
  }

  async updateLastLogin(playerId: PlayerRow['id'], nowIso: string): Promise<void> {
    for (const row of this.byEmail.values()) {
      if (row.id === playerId) {
        row.lastLoginIso = nowIso;
        return;
      }
    }
  }

  /** Test helper — direct read of last-login marker. */
  lastLoginOf(playerId: PlayerRow['id']): string | undefined {
    for (const row of this.byEmail.values()) {
      if (row.id === playerId) return row.lastLoginIso;
    }
    return undefined;
  }

  /** Test helper — insert/overwrite a row. */
  upsert(row: PlayerRow): void {
    this.byEmail.set(row.email.toLowerCase(), { ...row });
  }
}

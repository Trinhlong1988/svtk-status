/**
 * JWT SESSION — issue, verify, refresh-rotate, revoke.
 *
 * Phase 13 Tuần 1 (CMD4). Replaces the boot-stub that previously accepted
 * `dev:<userId>` literals only. Real HS256 JWT now drives both:
 *   1. WebSocket handshake gate at `src/server/boot.ts` (calls `verifyToken`)
 *   2. HTTP auth endpoints (login + Zalo OAuth callback issue tokens here)
 *
 * Layer 3 server infrastructure. NOT combat hot-path. Float math allowed but
 * the int-convention scanner still requires integer numeric literals; all
 * time fields below are integer Unix seconds.
 *
 * Contract preserved (CMD1 import):
 *   - `JwtSession`, `SessionRejectReason`, `SessionVerifyResult`, `verifyToken`
 *   - Synchronous return — handshake gate cannot await
 *
 * Dev fallback (NON-production only):
 *   - `dev:<userId>` literal still accepted when NODE_ENV !== 'production'
 *     so existing CMD1 integration tests do not break before they migrate to
 *     real JWT. Production env (loadConfig refinement) rejects the placeholder
 *     secret anyway, so this fallback cannot reach prod.
 *
 * Revocation store:
 *   - In-memory `Set<jti>` default (process-local, lost on restart).
 *   - `RevokeStore` interface accepts an async adapter — Redis adapter
 *     plug-in deferred to Tuần 2 (CMD4 cloud deploy ships Redis).
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require_ = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const jwt = require_('jsonwebtoken') as typeof import('jsonwebtoken');

// ═══════════════════════════════════════════════════════════════════════════
// Public types (CMD1 contract — DO NOT break)
// ═══════════════════════════════════════════════════════════════════════════

/** Verified session payload from a valid JWT bearer token. */
export interface JwtSession {
  readonly userId: string;
  readonly characterId?: string;
  /** Token issued at (Unix epoch seconds, integer). */
  readonly iatSec: number;
  /** Token expires at (Unix epoch seconds, integer). */
  readonly expSec: number;
  /** JWT id — opaque, unique per issued token. Used for revocation. */
  readonly jti?: string;
  /** Token type — `access` for handshake, `refresh` for `/api/auth/refresh`. */
  readonly typ?: TokenType;
}

/** Reject reasons — fed to anti-cheat telemetry on handshake reject. */
export type SessionRejectReason =
  | 'token_missing'
  | 'token_malformed'
  | 'token_expired'
  | 'signature_invalid'
  | 'unknown_user'
  | 'token_revoked'
  | 'wrong_token_type';

export interface SessionVerifyResult {
  readonly valid: boolean;
  readonly session?: JwtSession;
  readonly reason?: SessionRejectReason;
}

// ═══════════════════════════════════════════════════════════════════════════
// JWT issue / verify / rotate / revoke
// ═══════════════════════════════════════════════════════════════════════════

export type TokenType = 'access' | 'refresh';

export interface IssueTokenOptions {
  readonly secret: string;
  readonly ttlSec: number;
  readonly userId: string;
  readonly characterId?: string;
  /** Override clock for deterministic tests. Defaults to current Unix seconds. */
  readonly nowSec?: number;
  /** Override jti for deterministic tests. Defaults to `randomUUID()`. */
  readonly jti?: string;
}

export interface IssuedToken {
  readonly token: string;
  readonly jti: string;
  readonly iatSec: number;
  readonly expSec: number;
}

/**
 * RawClaims is the on-wire JWT payload shape. Field `tt` is the SVTK
 * token-type discriminator (`access` | `refresh`). We avoid the literal name
 * `typ` because that string is a JOSE-reserved header parameter and some
 * jsonwebtoken codepaths treat header-vs-payload `typ` ambiguously.
 */
interface RawClaims {
  sub: string;
  jti: string;
  iat: number;
  exp: number;
  tt: TokenType;
  cid?: string;
}

/** Returns current Unix epoch seconds (integer). Boot path, NOT gameplay loop. */
function nowSec(): number {
  // eslint-disable-next-line no-restricted-syntax
  return Math.floor(Date.now() / 1000);
}

function signToken(typ: TokenType, opts: IssueTokenOptions): IssuedToken {
  const iat = opts.nowSec ?? nowSec();
  const exp = iat + opts.ttlSec;
  const jti = opts.jti ?? randomUUID();
  const claims: RawClaims = {
    sub: opts.userId,
    jti,
    iat,
    exp,
    tt: typ,
  };
  if (opts.characterId !== undefined) claims.cid = opts.characterId;
  // Do NOT pass `noTimestamp: true` — that option deletes our explicit iat
  // BEFORE signing, even when we set iat ourselves.
  const token = jwt.sign(claims, opts.secret, { algorithm: 'HS256' });
  return { token, jti, iatSec: iat, expSec: exp };
}

/** Issue an access JWT — short-lived (brief: 15 min). */
export function issueAccessToken(opts: IssueTokenOptions): IssuedToken {
  return signToken('access', opts);
}

/** Issue a refresh JWT — long-lived (brief: 7 day). Separate `typ` claim. */
export function issueRefreshToken(opts: IssueTokenOptions): IssuedToken {
  return signToken('refresh', opts);
}

export interface VerifyOptions {
  readonly secret: string;
  /** Required token type — verify rejects if claim `typ` mismatches. */
  readonly expectedType?: TokenType;
  /** Revoke store consulted synchronously via cache snapshot. */
  readonly revokeStore?: RevokeStoreSnapshot;
  /** Override clock for deterministic tests. */
  readonly nowSec?: number;
  /** Allow dev fallback `dev:<userId>` literals. Default: NODE_ENV !== 'production'. */
  readonly allowDevStub?: boolean;
}

/**
 * Verify a JWT bearer token. Synchronous — handshake gate cannot await.
 *
 * @param token  — raw `Bearer <jwt>` header value OR plain JWT string.
 * @param opts   — secret, expected typ, optional revoke snapshot for jti gate.
 */
export function verifyToken(
  token: string | undefined,
  opts?: VerifyOptions,
): SessionVerifyResult {
  if (!token || token.trim().length === 0) {
    return { valid: false, reason: 'token_missing' };
  }
  const raw = token.startsWith('Bearer ') ? token.slice(7) : token;

  // Dev stub fallback — non-production only.
  const devStubAllowed =
    opts?.allowDevStub ?? process.env['NODE_ENV'] !== 'production';
  if (devStubAllowed && raw.startsWith('dev:')) {
    const userId = raw.slice(4);
    if (userId.trim().length === 0) {
      return { valid: false, reason: 'token_malformed' };
    }
    return {
      valid: true,
      session: {
        userId,
        iatSec: 0,
        expSec: 2000000000,
        typ: 'access',
      },
    };
  }

  if (!opts?.secret) {
    return { valid: false, reason: 'signature_invalid' };
  }

  let decoded: unknown;
  try {
    decoded = jwt.verify(raw, opts.secret, {
      algorithms: ['HS256'],
      clockTimestamp: opts.nowSec,
    });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name ?? '';
    if (name === 'TokenExpiredError') return { valid: false, reason: 'token_expired' };
    if (name === 'JsonWebTokenError') return { valid: false, reason: 'signature_invalid' };
    return { valid: false, reason: 'token_malformed' };
  }

  if (typeof decoded !== 'object' || decoded === null) {
    return { valid: false, reason: 'token_malformed' };
  }
  const claims = decoded as Partial<RawClaims>;
  if (
    typeof claims.sub !== 'string' ||
    typeof claims.jti !== 'string' ||
    typeof claims.iat !== 'number' ||
    typeof claims.exp !== 'number' ||
    (claims.tt !== 'access' && claims.tt !== 'refresh')
  ) {
    return { valid: false, reason: 'token_malformed' };
  }
  if (opts.expectedType && claims.tt !== opts.expectedType) {
    return { valid: false, reason: 'wrong_token_type' };
  }
  if (opts.revokeStore?.has(claims.jti)) {
    return { valid: false, reason: 'token_revoked' };
  }

  const session: JwtSession = {
    userId: claims.sub,
    iatSec: claims.iat,
    expSec: claims.exp,
    jti: claims.jti,
    typ: claims.tt,
    ...(typeof claims.cid === 'string' ? { characterId: claims.cid } : {}),
  };
  return { valid: true, session };
}

/** Alias exported per Phase 13 brief — `verifyJwt` requested as wire name. */
export { verifyToken as verifyJwt };

// ═══════════════════════════════════════════════════════════════════════════
// Revocation store
// ═══════════════════════════════════════════════════════════════════════════

/** Snapshot reader — sync `.has()` for boot.ts handshake gate. */
export interface RevokeStoreSnapshot {
  has(jti: string): boolean;
}

/**
 * Revocation store interface. Async write so a Redis adapter can replace the
 * in-memory default in Tuần 2 without changing call sites.
 *
 * `snapshot()` returns a sync `.has()` reader — caller MUST refresh it before
 * each verify pass to avoid stale revocation reads.
 */
export interface RevokeStore extends RevokeStoreSnapshot {
  revoke(jti: string, expSec: number): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
  snapshot(): RevokeStoreSnapshot;
  /** Drop revoked entries past their natural TTL — caller invokes periodically. */
  prune(nowSec?: number): void;
  size(): number;
}

/** In-memory revocation store. Process-local. Lost on restart — acceptable
 *  until Tuần 2 wires Redis.
 *
 *  Note: `has()` does NOT auto-purge expired entries. That keeps the snapshot
 *  contract pure (sync read, no side effects, no implicit wall-clock
 *  dependency). Callers schedule `prune()` to reclaim memory. The verify
 *  pipeline still rejects expired tokens via the standalone exp check, so a
 *  stale revoke entry cannot resurrect an expired token. */
export function createInMemoryRevokeStore(): RevokeStore {
  const entries = new Map<string, number>(); // jti → expSec
  const store: RevokeStore = {
    has(jti: string): boolean {
      return entries.has(jti);
    },
    async revoke(jti: string, expSec: number): Promise<void> {
      entries.set(jti, expSec);
    },
    async isRevoked(jti: string): Promise<boolean> {
      return store.has(jti);
    },
    snapshot(): RevokeStoreSnapshot {
      return { has: (j) => store.has(j) };
    },
    prune(at?: number): void {
      const cutoff = at ?? nowSec();
      for (const [jti, exp] of entries) {
        if (exp < cutoff) entries.delete(jti);
      }
    },
    size(): number {
      return entries.size;
    },
  };
  return store;
}

// ═══════════════════════════════════════════════════════════════════════════
// Refresh rotation
// ═══════════════════════════════════════════════════════════════════════════

export interface RotateRefreshOptions {
  readonly secret: string;
  readonly refreshToken: string;
  readonly accessTtlSec: number;
  readonly refreshTtlSec: number;
  readonly revokeStore: RevokeStore;
  readonly nowSec?: number;
  readonly accessJti?: string;
  readonly refreshJti?: string;
}

export type RotateRefreshResult =
  | { readonly success: true; readonly access: IssuedToken; readonly refresh: IssuedToken }
  | { readonly success: false; readonly reason: SessionRejectReason };

/**
 * Verify a refresh token, revoke its jti, and issue a fresh access + refresh
 * pair. Caller (HTTP `/api/auth/refresh` handler) returns both new tokens.
 */
export async function rotateRefreshToken(
  opts: RotateRefreshOptions,
): Promise<RotateRefreshResult> {
  const verify = verifyToken(opts.refreshToken, {
    secret: opts.secret,
    expectedType: 'refresh',
    revokeStore: opts.revokeStore.snapshot(),
    nowSec: opts.nowSec,
    allowDevStub: false,
  });
  if (!verify.valid || !verify.session?.jti) {
    return { success: false, reason: verify.reason ?? 'token_malformed' };
  }
  await opts.revokeStore.revoke(verify.session.jti, verify.session.expSec);

  const baseIssue = {
    secret: opts.secret,
    userId: verify.session.userId,
    ...(verify.session.characterId !== undefined
      ? { characterId: verify.session.characterId }
      : {}),
    ...(opts.nowSec !== undefined ? { nowSec: opts.nowSec } : {}),
  };
  const access = issueAccessToken({
    ...baseIssue,
    ttlSec: opts.accessTtlSec,
    ...(opts.accessJti !== undefined ? { jti: opts.accessJti } : {}),
  });
  const refresh = issueRefreshToken({
    ...baseIssue,
    ttlSec: opts.refreshTtlSec,
    ...(opts.refreshJti !== undefined ? { jti: opts.refreshJti } : {}),
  });
  return { success: true, access, refresh };
}

/**
 * Logout — revoke the supplied access OR refresh jti immediately. Token may
 * still verify by signature, but `revokeStore.has(jti)` returns true so
 * `verifyToken` rejects with `token_revoked`.
 */
export async function revokeToken(
  rawToken: string,
  opts: { readonly secret: string; readonly revokeStore: RevokeStore; readonly nowSec?: number },
): Promise<SessionVerifyResult> {
  const verify = verifyToken(rawToken, {
    secret: opts.secret,
    nowSec: opts.nowSec,
    allowDevStub: false,
  });
  if (!verify.valid || !verify.session?.jti) return verify;
  await opts.revokeStore.revoke(verify.session.jti, verify.session.expSec);
  return verify;
}

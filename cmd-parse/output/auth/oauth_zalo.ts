/**
 * ZALO OAUTH v4 — authorize URL + callback exchange + JWT issue.
 *
 * Phase 13 Tuần 1 (CMD4). Implements the public Zalo OAuth v4 flow:
 *
 *   1. GET  /api/auth/zalo/authorize    → builds redirect URL to
 *      https://oauth.zaloapp.com/v4/permission with PKCE S256 challenge.
 *
 *   2. GET  /api/auth/zalo/callback     → exchanges `code` for Zalo
 *      access token (POST /v4/access_token), fetches user info
 *      (GET graph.zalo.me/v2.0/me), upserts the player row keyed on
 *      `zalo_id`, and issues an SVTK access + refresh JWT pair.
 *
 * Layer 3 server infrastructure. HTTP client is injected so tests do NOT
 * hit the live oauth.zaloapp.com endpoints. Default = global `fetch`.
 *
 * State + PKCE: caller stores `{ state, codeVerifier }` from `buildAuthorizeUrl`
 * in a short-lived store (cookie / Redis) and re-supplies them to
 * `handleZaloCallback`. Mismatch → reject with `state_mismatch`.
 *
 * Player upsert: when no `players` row exists for `zalo_id`, the repo creates
 * one with synthetic email `zalo:<zaloId>@svtk.local`, username `zalo_<zaloId>`,
 * and an OAuth-only password sentinel (`verifyPassword` always returns false
 * for it — Zalo users CANNOT log in via /api/auth/login until they set an
 * email + password).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  issueAccessToken,
  issueRefreshToken,
  type IssuedToken,
} from './session.js';
import type { PlayerRow } from './login.js';

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export const ZALO_AUTHORIZE_URL = 'https://oauth.zaloapp.com/v4/permission';
export const ZALO_TOKEN_URL = 'https://oauth.zaloapp.com/v4/access_token';
export const ZALO_GRAPH_ME_URL = 'https://graph.zalo.me/v2.0/me';

/** Sentinel password_hash for OAuth-only accounts — argon2.verify rejects. */
export const OAUTH_ONLY_PASSWORD_SENTINEL = '!disabled-oauth-only';

export interface ZaloPlayerRepo {
  findByZaloId(zaloId: string): Promise<PlayerRow | null>;
  /**
   * Insert (if missing) or fetch (if present) a player row keyed on `zaloId`.
   * MUST be idempotent for the same `zaloId`.
   */
  upsertZaloPlayer(zaloId: string, displayName: string): Promise<PlayerRow>;
  updateLastLogin(playerId: PlayerRow['id'], nowIso: string): Promise<void>;
}

export interface ZaloOauthConfig {
  readonly appId: string;
  readonly appSecret: string;
  readonly redirectUri: string;
  readonly jwtSecret: string;
  readonly accessTtlSec: number;
  readonly refreshTtlSec: number;
}

/** Subset of `fetch` we depend on — enables a deterministic mock in tests. */
export type HttpFetch = (
  url: string,
  init: { readonly method: string; readonly headers: Record<string, string>; readonly body?: string },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface ZaloOauthDeps {
  readonly playerRepo: ZaloPlayerRepo;
  readonly config: ZaloOauthConfig;
  /** HTTP client. Defaults to global `fetch`. */
  readonly httpFetch?: HttpFetch;
  /** Override clock for deterministic tests — integer Unix seconds. */
  readonly nowSec?: number;
  /** Override ISO clock for `updateLastLogin`. */
  readonly nowIso?: string;
  /** Override jti for deterministic tests. */
  readonly accessJti?: string;
  readonly refreshJti?: string;
  /** Override state + codeVerifier generators for deterministic tests. */
  readonly stateGenerator?: () => string;
  readonly codeVerifierGenerator?: () => string;
}

// ═══════════════════════════════════════════════════════════════════════════
// PKCE + state generators
// ═══════════════════════════════════════════════════════════════════════════

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 96-byte random → base64url ≈ 128 chars. Within PKCE 43-128 range. */
export function generateCodeVerifier(): string {
  return base64Url(randomBytes(96));
}

/** S256 challenge derivation per RFC 7636. */
export function deriveCodeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

export function generateState(): string {
  return randomUUID();
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Build authorize URL
// ═══════════════════════════════════════════════════════════════════════════

export interface AuthorizeBundle {
  readonly url: string;
  readonly state: string;
  readonly codeVerifier: string;
}

export function buildAuthorizeUrl(deps: Pick<ZaloOauthDeps, 'config' | 'stateGenerator' | 'codeVerifierGenerator'>): AuthorizeBundle {
  const state = (deps.stateGenerator ?? generateState)();
  const codeVerifier = (deps.codeVerifierGenerator ?? generateCodeVerifier)();
  const codeChallenge = deriveCodeChallenge(codeVerifier);
  const params = new URLSearchParams({
    app_id: deps.config.appId,
    redirect_uri: deps.config.redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return {
    url: `${ZALO_AUTHORIZE_URL}?${params.toString()}`,
    state,
    codeVerifier,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Callback handler
// ═══════════════════════════════════════════════════════════════════════════

export interface ZaloCallbackInput {
  /** Authorization code returned by Zalo on redirect. */
  readonly code: string;
  /** State Zalo echoed back — caller compares with stored state. */
  readonly state: string;
  /** Expected state (from cookie / session store). */
  readonly expectedState: string;
  /** Code verifier paired with the code_challenge used in /authorize. */
  readonly codeVerifier: string;
}

export type ZaloCallbackRejectReason =
  | 'state_mismatch'
  | 'token_exchange_failed'
  | 'user_info_failed'
  | 'invalid_user_info'
  | 'upsert_failed';

export type ZaloCallbackResult =
  | {
      readonly success: true;
      readonly player: PlayerRow;
      readonly access: IssuedToken;
      readonly refresh: IssuedToken;
    }
  | { readonly success: false; readonly reason: ZaloCallbackRejectReason };

interface ZaloTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

interface ZaloUserInfo {
  id?: string;
  name?: string;
}

export async function handleZaloCallback(
  input: ZaloCallbackInput,
  deps: ZaloOauthDeps,
): Promise<ZaloCallbackResult> {
  if (input.state !== input.expectedState) {
    return { success: false, reason: 'state_mismatch' };
  }
  const fetcher = deps.httpFetch ?? defaultFetch;

  // 2a. Exchange code → zalo access token.
  let tokenResp: ZaloTokenResponse;
  try {
    const body = new URLSearchParams({
      app_id: deps.config.appId,
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
    }).toString();
    const res = await fetcher(ZALO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        secret_key: deps.config.appSecret,
      },
      body,
    });
    if (!res.ok) return { success: false, reason: 'token_exchange_failed' };
    tokenResp = (await res.json()) as ZaloTokenResponse;
  } catch {
    return { success: false, reason: 'token_exchange_failed' };
  }
  if (typeof tokenResp.access_token !== 'string' || tokenResp.access_token.length === 0) {
    return { success: false, reason: 'token_exchange_failed' };
  }

  // 2b. Fetch user info.
  let userInfo: ZaloUserInfo;
  try {
    const res = await fetcher(`${ZALO_GRAPH_ME_URL}?fields=id,name`, {
      method: 'GET',
      headers: {
        access_token: tokenResp.access_token,
      },
    });
    if (!res.ok) return { success: false, reason: 'user_info_failed' };
    userInfo = (await res.json()) as ZaloUserInfo;
  } catch {
    return { success: false, reason: 'user_info_failed' };
  }
  if (typeof userInfo.id !== 'string' || userInfo.id.length === 0) {
    return { success: false, reason: 'invalid_user_info' };
  }
  const zaloId = userInfo.id;
  const displayName = typeof userInfo.name === 'string' && userInfo.name.length > 0
    ? userInfo.name
    : `zalo_${zaloId}`;

  // 2c. Upsert player.
  let player: PlayerRow;
  try {
    player = await deps.playerRepo.upsertZaloPlayer(zaloId, displayName);
  } catch {
    return { success: false, reason: 'upsert_failed' };
  }

  // 2d. Issue SVTK JWT pair.
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

  return { success: true, player, access, refresh };
}

// ═══════════════════════════════════════════════════════════════════════════
// Default fetch adapter
// ═══════════════════════════════════════════════════════════════════════════

const defaultFetch: HttpFetch = async (url, init) => {
  // Node 20+ ships global fetch. Wrap to our minimal shape.
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json(),
    text: () => res.text(),
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// In-memory ZaloPlayerRepo (test + dev default)
// ═══════════════════════════════════════════════════════════════════════════

export class InMemoryZaloPlayerRepo implements ZaloPlayerRepo {
  private readonly byZaloId = new Map<string, PlayerRow & { lastLoginIso?: string }>();
  private nextId = 1;

  constructor(seed: readonly PlayerRow[] = []) {
    for (const p of seed) {
      if (p.zaloId) this.byZaloId.set(p.zaloId, { ...p });
      const numericId =
        typeof p.id === 'number'
          ? p.id
          : Number.parseInt(String(p.id), 10);
      if (Number.isFinite(numericId) && numericId >= this.nextId) this.nextId = numericId + 1;
    }
  }

  async findByZaloId(zaloId: string): Promise<PlayerRow | null> {
    const row = this.byZaloId.get(zaloId);
    return row ?? null;
  }

  async upsertZaloPlayer(zaloId: string, displayName: string): Promise<PlayerRow> {
    const existing = this.byZaloId.get(zaloId);
    if (existing) return existing;
    const id = this.nextId;
    this.nextId += 1;
    const row: PlayerRow & { lastLoginIso?: string } = {
      id,
      email: `zalo:${zaloId}@svtk.local`,
      username: displayName,
      passwordHash: OAUTH_ONLY_PASSWORD_SENTINEL,
      zaloId,
    };
    this.byZaloId.set(zaloId, row);
    return row;
  }

  async updateLastLogin(playerId: PlayerRow['id'], nowIso: string): Promise<void> {
    for (const row of this.byZaloId.values()) {
      if (row.id === playerId) {
        row.lastLoginIso = nowIso;
        return;
      }
    }
  }

  lastLoginOf(playerId: PlayerRow['id']): string | undefined {
    for (const row of this.byZaloId.values()) {
      if (row.id === playerId) return row.lastLoginIso;
    }
    return undefined;
  }

  size(): number {
    return this.byZaloId.size;
  }
}

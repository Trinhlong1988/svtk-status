/**
 * AUTH HTTP ROUTER — Phase 13 Tuần 1 (CMD4).
 *
 * Routes plugged into `boot.ts` createHttpServer handler:
 *
 *   POST  /api/auth/login              email + password → access + refresh
 *   POST  /api/auth/refresh            refresh → rotate (revoke old, issue new pair)
 *   POST  /api/auth/logout             revoke supplied access or refresh jti
 *   GET   /api/auth/zalo/authorize     302 to oauth.zaloapp.com with PKCE
 *   GET   /api/auth/zalo/callback      exchange code → SVTK JWT pair
 *
 * Returns a `(req, res) => Promise<boolean>` — boolean=true if route was
 * handled (caller short-circuits), false if path did not match.
 *
 * Layer 3 server infrastructure. Body parse uses utf-8 + 64KB cap to avoid
 * runaway POST size. Cookie store for OAuth state is intentionally minimal —
 * production Redis-backed store ships in Tuần 2.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  login,
  parseLoginRequest,
  type LoginConfig,
  type LoginDeps,
  type LoginHook,
  type PlayerRepo,
} from './login.js';
import {
  buildAuthorizeUrl,
  handleZaloCallback,
  type ZaloOauthConfig,
  type ZaloOauthDeps,
  type ZaloPlayerRepo,
  type HttpFetch,
} from './oauth_zalo.js';
import {
  rotateRefreshToken,
  revokeToken,
  type RevokeStore,
} from './session.js';

// ═══════════════════════════════════════════════════════════════════════════
// OAuth state store (PKCE state + code_verifier between authorize and callback)
// ═══════════════════════════════════════════════════════════════════════════

export interface OauthStateRecord {
  readonly state: string;
  readonly codeVerifier: string;
  readonly issuedAtSec: number;
  readonly expSec: number;
}

export interface OauthStateStore {
  put(record: OauthStateRecord): Promise<void>;
  consume(state: string): Promise<OauthStateRecord | null>;
  /**
   * Evict every record whose `expSec` is strictly less than `nowSec`. Caller
   * (boot.ts) schedules this on a fixed interval so abandoned OAuth flows
   * do not accumulate indefinitely.
   */
  prune(nowSec?: number): void;
  size(): number;
}

export function createInMemoryOauthStateStore(): OauthStateStore {
  const byState = new Map<string, OauthStateRecord>();
  // eslint-disable-next-line no-restricted-syntax
  const wallNowSec = (): number => Math.floor(Date.now() / 1000);
  return {
    async put(record: OauthStateRecord): Promise<void> {
      byState.set(record.state, record);
    },
    async consume(state: string): Promise<OauthStateRecord | null> {
      const rec = byState.get(state);
      if (!rec) return null;
      byState.delete(state);
      if (rec.expSec < wallNowSec()) return null;
      return rec;
    },
    prune(nowSec?: number): void {
      const cutoff = nowSec ?? wallNowSec();
      for (const [state, rec] of byState) {
        if (rec.expSec < cutoff) byState.delete(state);
      }
    },
    size(): number {
      return byState.size;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Router config
// ═══════════════════════════════════════════════════════════════════════════

export interface AuthRouterDeps {
  readonly playerRepo: PlayerRepo;
  readonly zaloRepo: ZaloPlayerRepo;
  readonly revokeStore: RevokeStore;
  readonly oauthStateStore: OauthStateStore;
  readonly loginConfig: LoginConfig;
  readonly zaloConfig: ZaloOauthConfig;
  readonly loginHook?: LoginHook;
  readonly httpFetch?: HttpFetch;
  /** State + codeVerifier TTL — default 10 min. */
  readonly oauthStateTtlSec?: number;
  /** Override clock for tests — integer Unix seconds. */
  readonly nowSec?: () => number;
}

export type AuthRouterHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

// ═══════════════════════════════════════════════════════════════════════════
// Body parser + response helpers
// ═══════════════════════════════════════════════════════════════════════════

const MAX_BODY_BYTES = 64 * 1024; // 64 KB

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new BodyMalformed();
  }
}

class BodyTooLarge extends Error {}
class BodyMalformed extends Error {}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendError(res: ServerResponse, status: number, reason: string): void {
  sendJson(res, status, { error: reason });
}

// ═══════════════════════════════════════════════════════════════════════════
// Route dispatch
// ═══════════════════════════════════════════════════════════════════════════

const PATH_LOGIN = '/api/auth/login';
const PATH_REFRESH = '/api/auth/refresh';
const PATH_LOGOUT = '/api/auth/logout';
const PATH_ZALO_AUTHORIZE = '/api/auth/zalo/authorize';
const PATH_ZALO_CALLBACK = '/api/auth/zalo/callback';

export function createAuthRouter(deps: AuthRouterDeps): AuthRouterHandler {
  const nowSecFn = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const stateTtl = deps.oauthStateTtlSec ?? 600;

  return async (req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';
    const pathname = url.split('?')[0] ?? '';

    // ─── POST /api/auth/login ─────────────────────────────────────────────
    if (pathname === PATH_LOGIN) {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed');
        return true;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        if (err instanceof BodyTooLarge) sendError(res, 413, 'body_too_large');
        else sendError(res, 400, 'invalid_request');
        return true;
      }
      const parsed = parseLoginRequest(body);
      if (!parsed.ok) {
        sendError(res, 400, 'invalid_request');
        return true;
      }
      const loginDeps: LoginDeps = {
        playerRepo: deps.playerRepo,
        config: deps.loginConfig,
        ...(deps.loginHook !== undefined ? { hook: deps.loginHook } : {}),
        nowSec: nowSecFn(),
      };
      const result = await login(parsed.req, loginDeps);
      if (!result.success) {
        const status = result.reason === 'rate_limited' ? 429
          : result.reason === 'captcha_required' ? 403
          : result.reason === 'invalid_request' ? 400
          : 401;
        sendError(res, status, result.reason);
        return true;
      }
      sendJson(res, 200, {
        player_id: result.playerId,
        access_token: result.access.token,
        access_exp: result.access.expSec,
        refresh_token: result.refresh.token,
        refresh_exp: result.refresh.expSec,
      });
      return true;
    }

    // ─── POST /api/auth/refresh ───────────────────────────────────────────
    if (pathname === PATH_REFRESH) {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed');
        return true;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        if (err instanceof BodyTooLarge) sendError(res, 413, 'body_too_large');
        else sendError(res, 400, 'invalid_request');
        return true;
      }
      const refreshToken = (body as { refresh_token?: unknown } | null)?.refresh_token;
      if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
        sendError(res, 400, 'invalid_request');
        return true;
      }
      const result = await rotateRefreshToken({
        secret: deps.loginConfig.jwtSecret,
        refreshToken,
        accessTtlSec: deps.loginConfig.accessTtlSec,
        refreshTtlSec: deps.loginConfig.refreshTtlSec,
        revokeStore: deps.revokeStore,
        nowSec: nowSecFn(),
      });
      if (!result.success) {
        sendError(res, 401, result.reason);
        return true;
      }
      sendJson(res, 200, {
        access_token: result.access.token,
        access_exp: result.access.expSec,
        refresh_token: result.refresh.token,
        refresh_exp: result.refresh.expSec,
      });
      return true;
    }

    // ─── POST /api/auth/logout ────────────────────────────────────────────
    if (pathname === PATH_LOGOUT) {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed');
        return true;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendError(res, 400, 'invalid_request');
        return true;
      }
      const token = (body as { token?: unknown } | null)?.token;
      if (typeof token !== 'string' || token.length === 0) {
        sendError(res, 400, 'invalid_request');
        return true;
      }
      await revokeToken(token, {
        secret: deps.loginConfig.jwtSecret,
        revokeStore: deps.revokeStore,
        nowSec: nowSecFn(),
      });
      sendJson(res, 200, { revoked: true });
      return true;
    }

    // ─── GET /api/auth/zalo/authorize ─────────────────────────────────────
    if (pathname === PATH_ZALO_AUTHORIZE) {
      if (method !== 'GET') {
        sendError(res, 405, 'method_not_allowed');
        return true;
      }
      const bundle = buildAuthorizeUrl({ config: deps.zaloConfig });
      const issuedAtSec = nowSecFn();
      await deps.oauthStateStore.put({
        state: bundle.state,
        codeVerifier: bundle.codeVerifier,
        issuedAtSec,
        expSec: issuedAtSec + stateTtl,
      });
      // Caller may follow redirect; we send 302 + JSON body so server-side
      // tests can still assert the URL without consuming Location header.
      res.writeHead(302, {
        location: bundle.url,
        'content-type': 'application/json; charset=utf-8',
      });
      res.end(JSON.stringify({ authorize_url: bundle.url, state: bundle.state }));
      return true;
    }

    // ─── GET /api/auth/zalo/callback ──────────────────────────────────────
    if (pathname === PATH_ZALO_CALLBACK) {
      if (method !== 'GET') {
        sendError(res, 405, 'method_not_allowed');
        return true;
      }
      const search = new URLSearchParams(url.split('?')[1] ?? '');
      const code = search.get('code');
      const state = search.get('state');
      if (!code || !state) {
        sendError(res, 400, 'invalid_request');
        return true;
      }
      const stateRec = await deps.oauthStateStore.consume(state);
      if (!stateRec) {
        sendError(res, 400, 'state_mismatch');
        return true;
      }
      const zaloDeps: ZaloOauthDeps = {
        playerRepo: deps.zaloRepo,
        config: deps.zaloConfig,
        ...(deps.httpFetch !== undefined ? { httpFetch: deps.httpFetch } : {}),
        nowSec: nowSecFn(),
      };
      const result = await handleZaloCallback(
        {
          code,
          state,
          expectedState: stateRec.state,
          codeVerifier: stateRec.codeVerifier,
        },
        zaloDeps,
      );
      if (!result.success) {
        const status = result.reason === 'state_mismatch' ? 400 : 502;
        sendError(res, status, result.reason);
        return true;
      }
      sendJson(res, 200, {
        player_id: String(result.player.id),
        access_token: result.access.token,
        access_exp: result.access.expSec,
        refresh_token: result.refresh.token,
        refresh_exp: result.refresh.expSec,
      });
      return true;
    }

    return false;
  };
}

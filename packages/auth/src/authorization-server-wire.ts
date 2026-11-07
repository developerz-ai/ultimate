// Single responsibility: the HTTP edge of the authorization server — the structural route shape
// (`@ultimat3/http` is tier 2 like this package, so its `Route` is matched by structure, never
// imported), reading a form body, reading client credentials, and answering RFC 6749 JSON.
// `no-store` on every answer: a token response cached anywhere is a token handed to a stranger.

import { isUltimateError } from '@ultimat3/core';
import type { ClientCredentials } from './authorization-server-clients';
import type { TokenOutcome } from './authorization-server-tokens';

/** The part of http's `UltimateRequest` these routes read: the request, and its capped body. */
export interface AuthServerHttpRequest {
  readonly raw: Request;
  bodyBytes(): Promise<Uint8Array>;
}

/** The part of http's `RequestContext` they read: the pipeline-resolved caller address. */
export interface AuthServerHttpContext {
  readonly ip: string | null;
}

/**
 * Assignable to `@ultimat3/http`'s `Route` — the shape `runtime.routes` takes — by structure.
 * Public by definition: they are how a client without a token gets one. No cookie authenticates
 * here; a client authenticates in the body or the `Authorization: Basic` header.
 */
export interface AuthServerRoute {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly handler: (
    request: AuthServerHttpRequest,
    ctx: AuthServerHttpContext,
  ) => Promise<Response>;
  readonly meta: {
    readonly name: string;
    readonly auth: 'public';
    /**
     * On every POST: http's `csrf` stage passes a cross-origin client here (the endpoint's whole
     * purpose), and `authenticate` answering `null` keeps the session cookie from deciding anything.
     */
    readonly csrf?: 'cookieless';
    readonly authenticate?: () => null;
  };
}

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' } as const;

export const jsonAnswer = (
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response =>
  Response.json(body, {
    status,
    headers: { ...NO_STORE, ...headers },
  });

/** RFC 6749 §5.2's body. A 401 names the scheme the client should retry with (§5.2). */
export function outcomeAnswer(outcome: TokenOutcome, success = 200): Response {
  if (outcome.ok) return jsonAnswer(success, outcome.body);
  const { status } = outcome;
  return jsonAnswer(
    status,
    { error: outcome.error, error_description: outcome.description },
    status === 401 ? { 'www-authenticate': 'Basic realm="oauth"' } : {},
  );
}

/** The limiter's `X_ACCOUNT_LOCKED` as RFC 6749 `429 temporarily_unavailable`; `null` otherwise. */
export function throttledAnswer(error: unknown, description: string): Response | null {
  if (!isUltimateError(error) || error.code !== 'X_ACCOUNT_LOCKED') return null;
  const after = error.meta?.['retryAfterSeconds'];
  return jsonAnswer(
    429,
    { error: 'temporarily_unavailable', error_description: description },
    typeof after === 'number' ? { 'retry-after': String(after) } : {},
  );
}

/** A form body, one value per name, or the name that repeats / `null` when it is not a form. */
export async function readForm(
  request: AuthServerHttpRequest,
): Promise<Map<string, string> | { readonly refused: string }> {
  const type = (request.raw.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') {
    return { refused: 'the body must be application/x-www-form-urlencoded' };
  }
  const params = new URLSearchParams(new TextDecoder().decode(await request.bodyBytes()));
  const form = new Map<string, string>();
  for (const [key, value] of params) {
    if (form.has(key)) return { refused: `the ${key} parameter is repeated` };
    form.set(key, value);
  }
  return form;
}

/**
 * RFC 6749 §2.3.1: `Basic` (each half form-urlencoded first) or `client_id`/`client_secret` in
 * the body — one method per request. `null` with a reason when the request is malformed.
 */
export function readClientCredentials(
  request: AuthServerHttpRequest,
  form: ReadonlyMap<string, string>,
): ClientCredentials | { readonly refused: string } {
  const header = request.raw.headers.get('authorization');
  if (header !== null && /^basic /i.test(header)) {
    if (form.has('client_secret')) return { refused: 'use one client authentication method' };
    let decoded: string;
    try {
      decoded = atob(header.slice(6).trim());
    } catch {
      return { refused: 'the Basic credentials are not base64' };
    }
    const colon = decoded.indexOf(':');
    if (colon < 1) return { refused: 'the Basic credentials carry no client id' };
    const decode = (part: string): string | null => {
      try {
        return decodeURIComponent(part.replaceAll('+', ' '));
      } catch {
        return null;
      }
    };
    const clientId = decode(decoded.slice(0, colon));
    const secret = decode(decoded.slice(colon + 1));
    if (clientId === null || secret === null)
      return { refused: 'the Basic credentials are malformed' };
    const named = form.get('client_id');
    if (named !== undefined && named !== clientId)
      return { refused: 'client_id disagrees with Basic' };
    return { clientId, secret: secret === '' ? null : secret };
  }
  const clientId = form.get('client_id');
  if (clientId === undefined || clientId === '') return { refused: 'client_id is required' };
  const secret = form.get('client_secret');
  return { clientId, secret: secret === undefined || secret === '' ? null : secret };
}

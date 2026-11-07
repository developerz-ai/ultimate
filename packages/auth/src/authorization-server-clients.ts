// Single responsibility: who a `client_id` is — a registered client from the store, or an https
// URL whose metadata document (MCP 2025-11-25) is fetched via `outbound({ dial: 'public' })`,
// size-capped, metered per caller, cached oldest-first — and proving a confidential one's secret.
// The secret is hashed at rest and compared hash to hash in constant time, never with `===`.

import { logger, stringField, timingSafeEqual } from '@ultimat3/core';
import { outbound } from '@ultimat3/core/outbound';
import type { ResolvedAuthServerConfig } from './authorization-server-config';
import type {
  AuthServerClient,
  AuthServerGrant,
  ClientAuthMethod,
} from './authorization-server-types';
import { isRecord } from './json';
import { randomToken, sha256Hex } from './tokens';

/** A metadata document is a few hundred bytes; 5 KiB is RFC 7591 metadata with room to spare. */
export const CLIENT_METADATA_MAX_BYTES = 5 * 1024;
const CLIENT_METADATA_TTL_MS = 5 * 60 * 1000;
const CLIENT_METADATA_CACHE_MAX = 1_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https anywhere, http only on loopback (RFC 8252 §7.3), never a fragment (RFC 6749 §3.1.2). */
export function isRedirectUri(value: string): boolean {
  const url = URL.parse(value);
  if (url === null || url.hash !== '' || value.includes('#')) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
}

const isMetadataClientId = (clientId: string): boolean => {
  const url = URL.parse(clientId);
  return url !== null && url.protocol === 'https:' && url.pathname !== '/' && url.hash === '';
};

const strings = (value: unknown): readonly string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;

/** The document, read as a public client or not at all. A secret in it would be published. */
function clientFromDocument(clientId: string, body: unknown, at: Date): AuthServerClient | null {
  if (!isRecord(body) || body['client_id'] !== clientId) return null;
  const redirects = strings(body['redirect_uris']);
  if (redirects === null || redirects.length === 0 || !redirects.every(isRedirectUri)) return null;
  const method = body['token_endpoint_auth_method'];
  if (method !== undefined && method !== 'none') return null;
  const name = body['client_name'];
  return {
    clientId,
    name: typeof name === 'string' && name !== '' ? name : new URL(clientId).host,
    secretHash: null,
    authMethod: 'none',
    redirectUris: redirects,
    grantTypes: ['authorization_code', 'refresh_token'],
    scopes: [],
    resources: [],
    createdAt: at,
  };
}

export interface ClientDirectory {
  /**
   * `callerKey` (the caller's address) meters metadata fetches through `config.limiter`: an
   * unauthenticated POST naming `https://<anyone>/<path>` would otherwise be one outbound GET per
   * path. Rejects with `X_ACCOUNT_LOCKED` once the caller is over the limit.
   */
  find(clientId: string, callerKey?: string): Promise<AuthServerClient | null>;
}

export function clientDirectory(config: ResolvedAuthServerConfig): ClientDirectory {
  const cache = new Map<string, { client: AuthServerClient | null; untilMs: number }>();
  async function fetchDocument(
    clientId: string,
    callerKey: string | undefined,
  ): Promise<AuthServerClient | null> {
    const nowMs = config.clock.now().getTime();
    const hit = cache.get(clientId);
    if (hit !== undefined && hit.untilMs > nowMs) return hit.client;
    if (callerKey !== undefined) await config.limiter.reserve(`oauth-client-metadata:${callerKey}`);
    let client: AuthServerClient | null = null;
    try {
      const answer = await outbound(
        {
          url: clientId,
          vendor: 'oauth-client-metadata',
          dial: 'public',
          deadlineMs: 5_000,
          maxBytes: CLIENT_METADATA_MAX_BYTES,
          redirect: 'error',
          headers: { accept: 'application/json' },
        },
        { fetch: config.fetch, resolve: config.resolveHost },
      );
      client =
        answer.status === 200
          ? clientFromDocument(clientId, JSON.parse(answer.text()), config.clock.now())
          : null;
    } catch (error) {
      // An unreachable, oversized or private-address document is an unknown client: the consent
      // page shows the refusal and nothing redirects. The code, never the message — it names a host.
      const code = stringField(error, 'code');
      logger.warn('auth.server.client_metadata_unreadable', code === undefined ? {} : { code });
    }
    // Oldest first: a Map iterates in insertion order, so re-inserting keeps the order honest.
    cache.delete(clientId);
    const oldest = cache.keys().next();
    if (cache.size >= CLIENT_METADATA_CACHE_MAX && oldest.done !== true) cache.delete(oldest.value);
    cache.set(clientId, { client, untilMs: nowMs + CLIENT_METADATA_TTL_MS });
    return client;
  }
  return {
    find: (clientId, callerKey) =>
      isMetadataClientId(clientId)
        ? fetchDocument(clientId, callerKey)
        : config.store.getClient(clientId),
  };
}

export interface RegisterClientInput {
  readonly name: string;
  /** `'none'` (default) is public: PKCE only. A secret method is a confidential client. */
  readonly authMethod?: ClientAuthMethod | undefined;
  readonly redirectUris?: readonly string[] | undefined;
  readonly grantTypes?: readonly AuthServerGrant[] | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly resources?: readonly string[] | undefined;
}

export interface RegisteredClient {
  readonly client: AuthServerClient;
  /** Shown ONCE, to whoever registered. Only its hash is stored. `null` for a public client. */
  readonly clientSecret: string | null;
}

/** Screening is the caller's: the route answers RFC 7591 errors, the app's task trusts itself. */
export async function storeClient(
  config: ResolvedAuthServerConfig,
  input: RegisterClientInput,
): Promise<RegisteredClient> {
  const method = input.authMethod ?? 'none';
  const clientSecret = method === 'none' ? null : randomToken(32);
  const client: AuthServerClient = {
    clientId: `c_${randomToken(16)}`,
    name: input.name,
    secretHash: clientSecret === null ? null : sha256Hex(clientSecret),
    authMethod: method,
    redirectUris: [...(input.redirectUris ?? [])],
    grantTypes: [...(input.grantTypes ?? ['authorization_code', 'refresh_token'])],
    scopes: [...(input.scopes ?? [])],
    resources: [...(input.resources ?? [])],
    createdAt: config.clock.now(),
  };
  await config.store.putClient(client);
  return { client, clientSecret };
}

/** What a token request presented about the client. */
export interface ClientCredentials {
  readonly clientId: string;
  readonly secret: string | null;
}

/** A public client presents no secret; a confidential one must, and it must match. */
export function clientAuthenticates(
  client: AuthServerClient,
  presented: ClientCredentials,
): boolean {
  if (client.secretHash === null) return presented.secret === null;
  if (presented.secret === null) return false;
  return timingSafeEqual(sha256Hex(presented.secret), client.secretHash);
}

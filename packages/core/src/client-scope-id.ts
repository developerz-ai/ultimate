/**
 * The opaque id of the principal a page acts for: keyed SHA-256 over who is acting, never the id,
 * because the HTML carrying it is readable by every script on the page. Here, below both, so the
 * document's writer (`@ultimat3/auth`) and a replay's judge (`@ultimat3/action`) derive one value
 * under one key: the per-process fallback key is module state, and two copies would disagree.
 */

import type { Actor } from './actor';
import { hmac } from './hmac';
import { logger } from './logger';

/** 128 bits: a scope only has to differ between principals, never to authenticate anyone. */
const SCOPE_HEX_CHARS = 32;

/** `wiki/Configuration.md`'s floor for `SESSION_SECRET`. */
const MIN_SECRET_LENGTH = 32;

export interface ClientScopeIdOptions {
  /** Defaults to `SESSION_SECRET`. */
  readonly secret?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/** Minted on first need when no `SESSION_SECRET` exists: stable per process, never per request. */
let processKey: string | undefined;

/**
 * `''` for the anonymous actor; otherwise the principal, who is really acting, and the tenant. One
 * person in two orgs is two scopes: a page, a store or a queued write rendered under one org must
 * never be reused under the other. No org leaves the material, and so the id, as it always was.
 */
export function clientScopeId(actor: Actor, options: ClientScopeIdOptions = {}): string {
  if (actor.kind === 'anonymous') return '';
  const principal = [
    actor.kind,
    actor.id,
    actor.onBehalfOf?.actorKind ?? null,
    actor.onBehalfOf?.actorId ?? null,
  ];
  const material = JSON.stringify(
    actor.orgId === undefined ? principal : [...principal, actor.orgId],
  );
  return hmac('sha256', scopeKey(options), material, 'hex').slice(0, SCOPE_HEX_CHARS);
}

function scopeKey(options: ClientScopeIdOptions): string {
  if (options.secret !== undefined) return options.secret;
  const configured = (options.env ?? Bun.env)['SESSION_SECRET']?.trim() ?? '';
  if (configured.length >= MIN_SECRET_LENGTH) return configured;
  if (processKey === undefined) {
    // `SESSION_SECRET` is optional in the env schema, so its absence cannot refuse a render. A
    // random per-process key keeps the id opaque; what it costs is stability across replicas and
    // restarts — a principal's page then rescopes, which clears its store, never leaks it, and a
    // replay rendered by another process is refused and stays queued.
    processKey = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    logger.warn('auth.client_scope.process_key', {
      reason: 'SESSION_SECRET unset or shorter than 32 chars',
      fix: 'export SESSION_SECRET="$(openssl rand -hex 32)"',
    });
  }
  return processKey;
}

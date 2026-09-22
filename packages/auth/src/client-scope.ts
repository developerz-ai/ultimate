// The browser page's client scope id: an OPAQUE name for the principal a per-request document was
// rendered for, carried in `<meta name="ultimate-scope">` so the page's one client store fences
// itself per principal (plan 101, decision 8). Keyed SHA-256 over the principal, never the id:
// the HTML is cacheable by a browser and readable by every script on the page.

import type { Actor } from '@ultimat3/core';
import { logger } from '@ultimat3/core';

/** 128 bits: a scope only has to differ between principals, never to authenticate anyone. */
const SCOPE_HEX_CHARS = 32;

/** `wiki/Configuration.md`'s floor for `SESSION_SECRET`, the same one the oauth handshake reads. */
const MIN_SECRET_LENGTH = 32;

export interface ClientScopeOptions {
  /** Defaults to `SESSION_SECRET`. */
  readonly secret?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/** Minted on first need when no `SESSION_SECRET` exists: stable per process, never per request. */
let processKey: string | undefined;

/**
 * `''` for the anonymous page — the empty scope core reads as "nobody". Otherwise the principal
 * AND who is really acting, so an admin impersonating a user is not the user's own scope: their
 * stores must never share records, on the page or on disk.
 */
export function clientScopeOf(actor: Actor, options: ClientScopeOptions = {}): string {
  if (actor.kind === 'anonymous') return '';
  const material = JSON.stringify([
    actor.kind,
    actor.id,
    actor.onBehalfOf?.actorKind ?? null,
    actor.onBehalfOf?.actorId ?? null,
  ]);
  return new Bun.CryptoHasher('sha256', scopeKey(options))
    .update(material)
    .digest('hex')
    .slice(0, SCOPE_HEX_CHARS);
}

function scopeKey(options: ClientScopeOptions): string {
  if (options.secret !== undefined) return options.secret;
  const configured = (options.env ?? Bun.env)['SESSION_SECRET']?.trim() ?? '';
  if (configured.length >= MIN_SECRET_LENGTH) return configured;
  if (processKey === undefined) {
    // `SESSION_SECRET` is optional in the env schema, so its absence cannot refuse a render. A
    // random per-process key keeps the id opaque; what it costs is stability across replicas and
    // restarts — a principal's page then rescopes, which clears its store, never leaks it.
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

// The browser page's client scope id: an OPAQUE name for the principal a per-request document was
// rendered for, carried in `<meta name="ultimate-scope">` so the page's one client store fences
// itself per principal (plan 101, decision 8). Keyed SHA-256 over the principal, never the id:
// the HTML is cacheable by a browser and readable by every script on the page.

import type { Actor } from '@ultimat3/core';
import { clientScopeId } from '@ultimat3/core';
import { AuthError } from './errors';

/** `wiki/Configuration.md`'s floor for `SESSION_SECRET`, the same one the oauth handshake reads. */
const MIN_SECRET_LENGTH = 32;

export interface ClientScopeOptions {
  /** Defaults to `SESSION_SECRET`. */
  readonly secret?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/**
 * `''` for the anonymous page — the empty scope core reads as "nobody". Otherwise the principal
 * AND who is really acting, so an admin impersonating a user is not the user's own scope: their
 * stores must never share records, on the page or on disk. The derivation is core's, because
 * `@ultimat3/action` compares against it and may not reach this tier's sibling for one function.
 */
export function clientScopeOf(actor: Actor, options: ClientScopeOptions = {}): string {
  if (actor.kind === 'anonymous') return '';
  // The same floor as `SESSION_SECRET`: an explicit key is a caller's value, so a short one is
  // refused rather than silently swapped for the process key.
  if (options.secret !== undefined && options.secret.length < MIN_SECRET_LENGTH) {
    // Never its length: how long the key handed over is narrows a guess at it.
    throw new AuthError({
      code: 'X_CONFIG_INVALID',
      cause: `clientScopeOf({ secret }) was passed a key shorter than the ${String(MIN_SECRET_LENGTH)} characters required, so the scope id would be keyed by a guessable secret`,
      fix: 'openssl rand -hex 32   # pass the output as clientScopeOf({ secret }), or omit secret to read SESSION_SECRET',
      meta: { option: 'secret', minLength: MIN_SECRET_LENGTH },
    });
  }
  return clientScopeId(actor, options);
}

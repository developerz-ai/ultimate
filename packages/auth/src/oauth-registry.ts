// Single responsibility: which OAuth providers this process knows about. A closed union of three
// consumer IdPs made an enterprise OP — Okta, Entra, Ping, an in-house OP — *unrepresentable*: the
// constraint was a type, so there was no runtime escape and the only ways out were forking the
// package or bypassing the whole subsystem, losing PKCE, the sealed handshake, issuer pinning and
// account linking with it. The three built-ins register through the same call an app uses, so the
// opening does not create a second path.

import type { OAuthProvider } from './oauth';
import { BUILTIN_OAUTH_PROVIDERS } from './oauth-builtins';
import { oauthProviderDuplicate, oauthProviderUnknown } from './oauth-errors';

const registry = new Map<string, OAuthProvider>();

/**
 * Frozen on the way in, arrays included: a registered provider is read on every login of its
 * kind, and a caller that kept a reference to the object it passed could otherwise repoint
 * `tokenUrl` or widen `issuers` after boot.
 */
const seal = (provider: OAuthProvider): OAuthProvider =>
  Object.freeze({
    ...provider,
    issuers: Object.freeze([...provider.issuers]),
    scopes: Object.freeze([...provider.scopes]),
  });

/**
 * Add an IdP. The one extension point, and the same one `oauth-builtins.ts` goes through.
 *
 * `usesPkce` stays the literal `true` on `OAuthProvider`, so this opening cannot be used to
 * register a PKCE-less provider: the mechanism the package exists to own survives the widening.
 *
 * A duplicate id is `X_OAUTH_PROVIDER_DUPLICATE` rather than a silent replacement — two modules
 * each registering `'okta'` is one of them quietly deciding where every okta login goes.
 */
export function registerOAuthProvider(provider: OAuthProvider): OAuthProvider {
  if (registry.has(provider.id)) throw oauthProviderDuplicate(provider.id);
  const sealed = seal(provider);
  registry.set(sealed.id, sealed);
  return sealed;
}

for (const provider of BUILTIN_OAUTH_PROVIDERS) registerOAuthProvider(provider);

export function hasOAuthProvider(id: string): boolean {
  return registry.has(id);
}

/**
 * The one lookup. Throws rather than answering `undefined`, because every caller in this package
 * would otherwise have to decide what an unknown provider means — and one of them would decide
 * wrong. `X_OAUTH_PROVIDER_UNKNOWN` already existed for exactly this.
 */
export function providerFor(id: string): OAuthProvider {
  const provider = registry.get(id);
  if (provider === undefined) throw oauthProviderUnknown(id, oauthProviderIds());
  return provider;
}

/**
 * Live, never a snapshot taken at import: `defineAuth({ providers })` defaults to this, and a
 * frozen copy would leave an IdP registered after this module loaded enabled nowhere.
 */
export function oauthProviderIds(): readonly string[] {
  return [...registry.keys()];
}

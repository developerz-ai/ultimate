// Single responsibility: `identityProviderRoutes(auth, { providers })` — the sign-in routes over a
// fixed list of `IdentityProvider`s (SAML, OIDC, an app's own). The legs themselves are
// `identity-provider-route-core.ts`, shared with `oauthLogin`; this file is the list, its one 404,
// and the grant seam over a `VerifiedIdentity`.

import {
  ConfigInvalidError,
  logger,
  renderCauseValue,
  renderThrowable,
  type UltimateError,
} from '@ultimat3/core';
import type { Auth } from './auth';
import { AuthError } from './errors';
import type { IdentityProvider, ResolveIdentityGrants } from './identity-provider';
import {
  type SignInRouteDescriptor,
  type SignInRouteOptions,
  type SignInRoutes,
  signInRoutes,
} from './identity-provider-route-core';

export type IdentityRouteDescriptor = SignInRouteDescriptor;
export type IdentityProviderRoutes = SignInRoutes;

export interface IdentityProviderRoutesOptions extends SignInRouteOptions {
  readonly providers: readonly IdentityProvider[];
  /** What a verified identity is entitled to — business convention, never shipped (axiom 8). */
  readonly resolveGrants?: ResolveIdentityGrants | undefined;
}

export const identityProviderUnknown = (segment: string): AuthError =>
  new AuthError({
    code: 'X_IDENTITY_PROVIDER_UNKNOWN',
    cause: `no identity provider ${renderCauseValue(segment)} is served by these routes`,
    fix: 'identityProviderRoutes(auth, { providers: [samlIdentityProvider({ id, … })] })  // and add the id to defineAuth({ providers }), or correct the id in the link',
  });

/** An uncoded throw's text goes to the log only — never into a public body. */
function uncoded(error: unknown): UltimateError {
  logger.error('auth.sso.uncoded_failure', { detail: renderThrowable(error) });
  return new ConfigInvalidError({
    cause:
      'a provider, adapter or fetch this package does not own threw a value with no error code',
    fix: 'new AuthError({ code, cause, fix })  // throw it from the provider or adapter that threw; its value is logged as auth.sso.uncoded_failure',
  });
}

export function identityProviderRoutes(
  auth: Auth,
  options: IdentityProviderRoutesOptions,
): IdentityProviderRoutes {
  const byId = new Map<string, IdentityProvider>();
  for (const provider of options.providers) {
    if (byId.has(provider.id)) {
      throw new ConfigInvalidError({
        cause: `two identity providers claim the id ${renderCauseValue(provider.id)}`,
        fix: 'identityProviderRoutes(auth, { providers: [first, second] })  // each with its own id',
      });
    }
    byId.set(provider.id, provider);
  }
  return signInRoutes(auth, options, {
    // Unknown and not-enabled are one 404, so the routes describe no configuration.
    resolve(segment) {
      const provider = byId.get(segment);
      if (provider === undefined || !auth.providers.includes(segment)) {
        throw identityProviderUnknown(segment);
      }
      return provider;
    },
    unknown: identityProviderUnknown,
    event: 'auth.sso',
    names: { start: 'auth.sso.start', callback: 'auth.sso.callback', acs: 'auth.sso.acs' },
    uncoded,
    grants: (identity) => options.resolveGrants?.(identity),
  });
}

/**
 * What `apps/web/runtime.ts` mounts for SSO: the start leg and the SAML ACS, or nothing when the
 * deploy configured no IdP. Built on the FIRST REQUEST, never at import: Postly's `auth`
 * (`./login.ts`) is a `defineAuth()` call, and run at import it would capture the defaults before
 * the boot installs the shared rate limiter and replay guard. And a bad IdP config (metadata that
 * does not parse, a domain that is not one) then fails these two legs alone, with a logged code —
 * never the import of `runtime.ts`, which every role loads, `migrate` included.
 */

import type { IdentityProviderRoutes } from '@ultimat3/auth';
import { isUltimateError, logger, renderThrowable } from '@ultimat3/core';
import type { Route } from '@ultimat3/http';
import { type PostlySsoConfig, postlySso, ssoConfigFrom } from './sso';

type Leg = IdentityProviderRoutes['start'];

/**
 * Each leg's `meta`, which a router reads when it mounts — before the first request, so before the
 * leg exists. `@ultimat3/auth`'s own, by value; `sso-routes.test.ts` holds both against the built
 * legs, so a framework change to either is a red test and never a silent 403 on the ACS.
 */
export const START_META = { name: 'auth.sso.start', auth: 'public' } as const;
export const ACS_META = {
  name: 'auth.sso.acs',
  auth: 'public',
  // The IdP answers with a cross-site form POST: no CSRF token, no session to authenticate.
  csrf: 'cookieless',
  authenticate: () => null,
} as const;

/** The legs, built once on first use from Postly's one `auth`. A failed build is kept, not retried. */
const lazyLegs = (config: PostlySsoConfig): (() => Promise<IdentityProviderRoutes>) => {
  let built: Promise<IdentityProviderRoutes> | undefined;
  return () => {
    built ??= import('./login').then(({ auth }) => postlySso(auth, config));
    return built;
  };
};

/** The refusal a misconfigured IdP answers: its code to the caller, cause and fix to the log. */
function unavailable(error: unknown): Response {
  const code = isUltimateError(error) ? error.code : 'X_CONFIG_INVALID';
  logger.error('postly.sso.unavailable', {
    code,
    detail: renderThrowable(error),
    fix: 'x secrets set POSTLY_SSO_IDP_METADATA "<the IdP metadata XML>"   # and POSTLY_SSO_EMAIL_DOMAINS',
  });
  return Response.json({ code, title: 'single sign-on is not available' }, { status: 503 });
}

export function ssoRoutes(env: Readonly<Record<string, string | undefined>>): readonly Route[] {
  const config = ssoConfigFrom(env);
  if (config === null) return [];
  const legs = lazyLegs(config);
  const mounted = (
    method: Leg['method'],
    path: string,
    pick: (built: IdentityProviderRoutes) => Leg,
    meta: Route['meta'],
  ): Route => ({
    method,
    path,
    handler: async (request) => {
      let leg: Leg;
      try {
        leg = pick(await legs());
      } catch (error) {
        return unavailable(error);
      }
      // A descriptor takes a bare `Request`; the pipeline's carries it as `raw`.
      return leg.handle(request.raw);
    },
    meta,
  });
  return [
    mounted('GET', '/auth/sso/:provider', (built) => built.start, START_META),
    mounted('POST', '/auth/sso/:provider/callback', (built) => built.acs, ACS_META),
  ];
}

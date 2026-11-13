/**
 * Every sign-in leg `apps/web/runtime.ts` mounts: "log in with GitHub" (`./login.ts`'s `start` and
 * `callback`) always, and the SAML directory (`./sso-routes.ts`) when the deploy configured one.
 * Both front doors share `/auth/sso/:provider`, so its ONE GET mount answers by segment — `corp` is
 * the SAML start, anything else the OAuth start, which 404s a provider Postly never enabled.
 */

import type { Auth } from '@ultimat3/auth';
import type { RequestContext, Route, UltimateRequest } from '@ultimat3/http';
import type { PostlyLoginOptions } from './login';
import { SSO_PROVIDER } from './sign-in-paths';
import { ssoRoutes } from './sso-routes';

type Env = Readonly<Record<string, string | undefined>>;

/** The mount patterns — `oauthLogin`'s own defaults, which `sign-in-routes.test.ts` holds. */
export const SIGN_IN_START_PATH = '/auth/sso/:provider';
export const SIGN_IN_CALLBACK_PATH = '/auth/sso/:provider/callback';

/** Each GET leg's `meta`, read when the router mounts — before the legs are built. */
export const SIGN_IN_START_META = { name: 'auth.sign-in.start', auth: 'public' } as const;
export const OAUTH_CALLBACK_META = { name: 'auth.oauth.callback', auth: 'public' } as const;

/** What a test drives instead of Postly's own `auth` and the provider's real token endpoint. */
export interface SignInSeams {
  readonly auth?: () => Promise<Auth>;
  readonly login?: PostlyLoginOptions;
}

/**
 * The OAuth legs, built on the FIRST request and never at import: `runtime.ts` is loaded by every
 * role, `migrate` included, and `./login.ts`'s `auth` is a `defineAuth()` call. Credentials are
 * read per request from `env` — no `GITHUB_CLIENT_ID` is the same 404 an unknown provider gets.
 */
function lazyLogin(env: Env, seams: SignInSeams) {
  let built: ReturnType<typeof build> | undefined;
  const build = async () => {
    const { auth, postlyLogin } = await import('./login');
    const resolved = seams.auth === undefined ? auth : await seams.auth();
    return postlyLogin(resolved, { env, ...seams.login });
  };
  return () => {
    built ??= build();
    return built;
  };
}

export function signInRoutes(env: Env, seams: SignInSeams = {}): readonly Route[] {
  const login = lazyLogin(env, seams);
  const sso = ssoRoutes(env);
  const samlStart = sso.find((route) => route.method === 'GET');
  const start = async (request: UltimateRequest, ctx: RequestContext): Promise<Response> =>
    samlStart !== undefined && request.param('provider') === SSO_PROVIDER
      ? await samlStart.handler(request, ctx)
      : await (await login()).start.handle(request.raw);
  return [
    { method: 'GET', path: SIGN_IN_START_PATH, handler: start, meta: SIGN_IN_START_META },
    {
      method: 'GET',
      path: SIGN_IN_CALLBACK_PATH,
      handler: async (request) => await (await login()).callback.handle(request.raw),
      meta: OAUTH_CALLBACK_META,
    },
    // SAML answers with a cross-site POST to the same callback path: its own method, its own meta.
    ...sso.filter((route) => route.method !== 'GET'),
  ];
}

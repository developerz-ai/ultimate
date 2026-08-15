// Single responsibility: the one declaration of where the OAuth login routes live. It imports
// nothing so that `errors.ts` and `oauth-route.ts` can both read it without a cycle — which is
// the point: three shipped `fix:` lines told the caller to restart at `GET /auth/oauth/<provider>`
// while no route was mounted anywhere. Deriving both the mount and the fix from here makes a fix
// line that names a route nothing serves impossible rather than merely discouraged.

/** Not configurable, on purpose: a movable base path is a `fix:` line that can go stale again. */
export const OAUTH_BASE_PATH = '/auth/oauth';

/** The pattern a router mounts. `:provider` is the segment `oauthStartPath` fills in. */
export const OAUTH_START_ROUTE_PATH = `${OAUTH_BASE_PATH}/:provider` as const;

export const OAUTH_CALLBACK_ROUTE_PATH = `${OAUTH_BASE_PATH}/:provider/callback` as const;

/** Where a browser starts a login. This exact string is what the `fix:` lines quote. */
export const oauthStartPath = (provider: string): string => `${OAUTH_BASE_PATH}/${provider}`;

/** Where the provider sends it back. Registered with the provider as the `redirect_uri`. */
export const oauthCallbackPath = (provider: string): string =>
  `${OAUTH_BASE_PATH}/${provider}/callback`;

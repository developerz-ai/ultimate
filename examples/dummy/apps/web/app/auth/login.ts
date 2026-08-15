/**
 * "Log in with GitHub", as Postly declares it: one `defineAuth` and one `oauthLogin`, and that is
 * the whole of it. PKCE, the sealed handshake, the state check, the account link and the session
 * cookie are the framework's — this file holds only the three decisions an app owns: which
 * providers, when two identities are one person, and where a signed-in member lands.
 */

import type { Auth, AuthAdapter, OAuthLoginOptions, OAuthLoginRoutes } from '@ultimat3/auth';
import { BuiltinAdapter, defineAuth, oauthLogin } from '@ultimat3/auth';
import type { Clock } from '@ultimat3/core';

/**
 * Where a signed-in member lands. A fixed path and never a `?next=` off the callback: the one
 * endpoint whose job is to hand out a session is the classic open redirect.
 */
export const AFTER_SIGN_IN = '/feed';

export interface PostlyAuthSeams {
  /**
   * Defaults to Postgres, the shape `BuiltinAdapter(client = db())` already uses. Only a test
   * passes anything else, so the production wiring is what the declaration says rather than
   * something assembled a second time somewhere a test never reaches.
   */
  readonly adapter?: AuthAdapter | undefined;
  readonly clock?: Clock | undefined;
}

export function postlyAuth(seams: PostlyAuthSeams = {}): Auth {
  return defineAuth({
    adapter: seams.adapter ?? new BuiltinAdapter(),
    // GitHub alone. Every provider listed here is a button someone has to keep working, and a
    // provider missing from this list is a 404 rather than a half-configured redirect.
    providers: ['github'],
    // The default, spelled out because it is Postly's to keep: a provider identity joins an
    // existing member only when the provider AND that member both proved the address.
    link: 'verified-email',
    ...(seams.clock === undefined ? {} : { clock: seams.clock }),
  });
}

/**
 * The two legs of the login as route descriptors — `start.path` is `/auth/oauth/:provider` and
 * `callback.path` is `/auth/oauth/:provider/callback`, the one declaration every `X_OAUTH_*` fix
 * line quotes. `options` carries the seams the framework already injects (credentials, the token
 * endpoint's `fetch`, the handshake secret), so a test drives THIS login and not a copy of it.
 */
export const postlyLogin = (auth: Auth, options: OAuthLoginOptions = {}): OAuthLoginRoutes =>
  oauthLogin(auth, { successPath: AFTER_SIGN_IN, ...options });

/** Postly's own, built once: the app has one boot and therefore one identity resolver. */
export const auth = postlyAuth();

export const { start, callback } = postlyLogin(auth);

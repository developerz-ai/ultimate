/**
 * The sign-in facts that are Postly's, in a module that builds nothing: `runtime.ts` reaches them
 * through `./sso.ts` and must never load `./login.ts`, whose `auth` is a `defineAuth()` call — at
 * import, before the boot installs the shared rate limiter and replay guard it would capture.
 */

/**
 * Where a signed-in member lands. A fixed path and never a `?next=` off the callback: the one
 * endpoint whose job is to hand out a session is the classic open redirect.
 */
export const AFTER_SIGN_IN = '/feed';

/** The SAML directory's URL segment (`./sso.ts`): `/auth/sso/corp`, its ACS the POSTed callback. */
export const SSO_PROVIDER = 'corp';

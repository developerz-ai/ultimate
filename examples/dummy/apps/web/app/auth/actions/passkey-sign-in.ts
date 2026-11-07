// `passkeySignIn` — the second leg: the browser's `getPasskey` answer in, a session cookie out.
// Every check (signature, origin, rp id, user verification, the counter) is the framework's; a
// refusal is `X_PASSKEY_INVALID` or `X_PASSKEY_CHALLENGE_EXPIRED`, never which check failed.

import { action, t } from '@ultimat3/action';
import { setCookie, useRequestHeader } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { auth } from '../login';
import { passkeys } from '../passkeys';

/**
 * The session cookie, through http's one writer: the same name, value and `Max-Age` as the
 * `cookie` line `login()` answers (`sessionCookie`), so no attribute is spelled here.
 */
const setSessionCookie = (token: string): void => {
  const { policy } = auth.sessions;
  setCookie(policy.cookieName, token, { maxAge: Math.floor(policy.absoluteTtlMs / 1000) });
};

/** The response headers the pipeline publishes, read structurally: a job or a test has none. */
const carriesHeaders = (ctx: unknown): ctx is { readonly headers: Headers } =>
  typeof ctx === 'object' && ctx !== null && 'headers' in ctx && ctx.headers instanceof Headers;

export const passkeySignIn = action({
  input: t.object({ response: t.json() }),
  output: t.object({ userId: t.uuid }),
  policy: allow('passkey-sign-in'),
  errors: ['X_PASSKEY_INVALID', 'X_PASSKEY_CHALLENGE_EXPIRED'],
  async handle({ input, ctx }) {
    // Outside a request (a test, `x exercise`) there are no headers to read or to write.
    const http = carriesHeaders(ctx);
    const signedIn = await passkeys.login.login({
      response: input.response,
      userAgent: http ? useRequestHeader('user-agent') : null,
    });
    if (http) setSessionCookie(signedIn.token);
    return { userId: signedIn.actor.id };
  },
});

/**
 * Ending the demo session. "Sign out" is a SESSION write — a cookie and a full navigation — so the
 * action sets the demo cookie to `DEMO_SIGNED_OUT` on the response the pipeline is assembling (its
 * last stage copies `ctx.headers` onto whatever the handler returned) and, for a browser's native
 * form post, redirects to the public home. The navigation is load-bearing: the next document names
 * no principal, and the page's realtime rescopes on it — the previous member's records leave the
 * store and the disk (plan 101, slice 03).
 *
 * `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.
 */

import { action, t } from '@ultimat3/action';
import { signOutHeaders } from '@ultimat3/auth';
import { setRedirect, useRequestHeader } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { DEMO_MEMBER_COOKIE, DEMO_SIGNED_OUT } from './demo-actor';

/** Where a signed-out reader lands: the public site, which asks nothing of a session. */
export const AFTER_SIGN_OUT = '/';

/** The response headers the pipeline publishes, read structurally: a job or a test has none. */
const carriesHeaders = (ctx: unknown): ctx is { readonly headers: Headers } =>
  typeof ctx === 'object' && ctx !== null && 'headers' in ctx && ctx.headers instanceof Headers;

export const endSession = action({
  input: t.object({}),
  output: t.object({ ok: t.boolean, next: t.string }),
  // Anyone may end their own session, signed in or not — ending none is a no-op, never a refusal.
  policy: allow('end-session'),
  handle({ ctx }) {
    const landed = carriesHeaders(ctx);
    if (landed) {
      ctx.headers.append(
        'set-cookie',
        `${DEMO_MEMBER_COOKIE}=${DEMO_SIGNED_OUT}; Path=/; SameSite=Lax; HttpOnly`,
      );
      // The browser drops the previous member's IndexedDB, storage and cached pages — `/` is a
      // static page with no scope tag, so nothing on it would wipe them (the boot wipe is the
      // second line, for a sign-out with no navigation).
      for (const [name, value] of signOutHeaders()) ctx.headers.append(name, value);
    }
    // A browser's form post gets the navigation; an agent calling the action gets the JSON.
    if ((useRequestHeader('accept') ?? '').includes('text/html')) setRedirect(AFTER_SIGN_OUT);
    return { ok: landed, next: AFTER_SIGN_OUT };
  },
});

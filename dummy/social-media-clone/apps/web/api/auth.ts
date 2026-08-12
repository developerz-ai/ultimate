// The three auth actions, and the only place a session cookie is written. Declared as actions
// because that is what they are — server-authoritative operations with an input schema, an output
// schema and a policy — so they get HTTP, OpenAPI, a typed client and an MCP name from one
// declaration. Sign-in is NOT a ninth primitive.
//
// The forms on `site/signin` and `site/signup` post straight at the routes derived from these
// names: `POST /api/sessions/create`, `/api/accounts/create`, `/api/sessions/destroy`.

import { MAX_HANDLE } from '@social-media-clone/domain';
import { action, t } from '@ultimat3/action';
import { NEXT_PARAM, nextAfterSignIn, setRedirect, useRequestHeader } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import type { IssuedSession } from '../app/auth/service';
import { signIn, signOut, signUp } from '../app/auth/service';
import { CAPTCHA_FIELD } from '../shared/auth-policy';
import {
  clearedSessionCookie,
  isSecureRequest,
  readSessionToken,
  sessionCookie,
  setResponseCookie,
} from '../shared/session';

/** The handle rule, enforced here as well as by the `users` CHECK — one predicate, two places. */
const handleInput = t.string
  .min(1)
  .max(MAX_HANDLE)
  .pattern(/^[A-Za-z0-9_]+$/)
  .describe('lowercase letters, digits and underscores');

const sessionOutput = t.object({
  ok: t.boolean,
  /** Where a browser should go next. A form POST cannot be answered with a 303 — see README note. */
  next: t.string,
  handle: t.string,
});

/**
 * Write the cookie onto the response the pipeline is assembling. `secure` comes from the request's
 * own scheme, so one deployment cannot end up with a `__Host-` name and no TLS behind it.
 */
const attach = (ctx: unknown, issued: IssuedSession, now: Date): void => {
  const secure = isSecureRequest(ctx);
  setResponseCookie(
    ctx,
    sessionCookie({
      token: issued.token,
      secure,
      maxAgeSeconds: Math.floor((issued.expiresAt.getTime() - now.getTime()) / 1000),
    }),
  );
};

/**
 * The form field the sign-in page carries, and the only reason these two actions differ from
 * every other one. `nextAfterSignIn` refuses anything that is not a same-origin path.
 */
const nextInput = t.optional(t.string.max(2048));

/**
 * A browser that posted the native form gets a 303 to where it was going; an agent that posted
 * JSON gets the output schema, unchanged. Same operation, two audiences — `setRedirect` is the
 * seam that exists for exactly this, so the action does not grow a second protocol.
 */
const landAfter = (raw: string | undefined, fallback: string): string => {
  const next = nextAfterSignIn(raw, fallback);
  if ((useRequestHeader('accept') ?? '').includes('text/html')) setRedirect(next);
  return next;
};

export const createSession = action({
  input: t.object({
    handle: handleInput,
    password: t.string.min(1),
    [NEXT_PARAM]: nextInput,
    [CAPTCHA_FIELD]: t.optional(t.string),
  }),
  output: sessionOutput,
  // Public by declaration, not by omission: signing in is the one operation nobody can hold a
  // permission for yet. Every refusal below is a domain error, never an authz decision.
  policy: allow('public'),
  mcp: { expose: false },
  async handle({ input, ctx }) {
    const now = new Date();
    const issued = await signIn(
      {
        handle: input.handle,
        password: input.password,
        captchaToken: input[CAPTCHA_FIELD] ?? null,
      },
      now,
    );
    attach(ctx, issued, now);
    return { ok: true, next: landAfter(input[NEXT_PARAM], '/feed'), handle: input.handle };
  },
});

export const createAccount = action({
  input: t.object({
    handle: handleInput,
    displayName: t.string.min(1).max(80),
    email: t.email,
    password: t.string.min(1),
    [NEXT_PARAM]: nextInput,
    [CAPTCHA_FIELD]: t.optional(t.string),
  }),
  output: sessionOutput,
  policy: allow('public'),
  mcp: { expose: false },
  async handle({ input, ctx }) {
    const now = new Date();
    const issued = await signUp(
      {
        handle: input.handle,
        displayName: input.displayName,
        email: input.email,
        password: input.password,
        captchaToken: input[CAPTCHA_FIELD] ?? null,
      },
      now,
    );
    attach(ctx, issued, now);
    return { ok: true, next: landAfter(input[NEXT_PARAM], '/feed'), handle: input.handle };
  },
});

export const destroySession = action({
  /**
   * `confirm` exists because an action's input is an object and the pipeline's `body` stage
   * rejects an ABSENT body against one — `expected an object, received undefined`
   * (`packages/http/src/pipeline.ts:255`). A `<form method="post">` with no fields sends
   * `content-length: 0`, which `UltimateRequest.#read` reads as no body at all
   * (`packages/http/src/request.ts:142`). So the form declares one field rather than depending on
   * a browser quirk, and a literal says what it is for.
   */
  input: t.object({ confirm: t.literal('sign-out') }),
  output: t.object({
    ok: t.boolean,
    next: t.string,
    /**
     * Whether the `sessions` row was actually deleted, and not decoration: reporting a revocation
     * that did not happen would be the one lie an operator must never be told about a sign-out.
     */
    revoked: t.boolean,
  }),
  policy: allow('public'),
  mcp: { expose: false },
  async handle({ ctx }) {
    // The inbound headers the pipeline put on the context, through the framework's own reader —
    // the same cookie `hooks.authenticate` read one stage earlier, never a second parse of a
    // request object the context does not carry.
    const revoked = await signOut(readSessionToken(useRequestHeader('cookie')));
    // Cleared regardless. The browser forgetting the token is the half this process controls, and
    // the row expires on its own clock — `sessions.expiresAt` is absolute for exactly this reason.
    setResponseCookie(ctx, clearedSessionCookie(isSecureRequest(ctx)));
    return { ok: true, next: '/', revoked };
  },
});

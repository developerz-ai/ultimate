// The three auth actions, and the only place a session cookie is written. Declared as actions
// because that is what they are — server-authoritative operations with an input schema, an output
// schema and a policy — so they get HTTP, OpenAPI, a typed client and an MCP name from one
// declaration. Sign-in is NOT a ninth primitive.
//
// The forms on `site/signin` and `site/signup` post straight at the routes derived from these
// names: `POST /api/sessions/create`, `/api/accounts/create`, `/api/sessions/destroy`.

import { MAX_HANDLE } from '@social-media-clone/domain';
import { action, t } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';
import type { IssuedSession } from '../app/auth/service';
import { signIn, signOut, signUp } from '../app/auth/service';
import { CAPTCHA_FIELD } from '../shared/auth-policy';
import {
  clearedSessionCookie,
  isSecureRequest,
  requestSessionToken,
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

export const createSession = action({
  input: t.object({
    handle: handleInput,
    password: t.string.min(1),
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
    return { ok: true, next: '/feed', handle: input.handle };
  },
});

export const createAccount = action({
  input: t.object({
    handle: handleInput,
    displayName: t.string.min(1).max(80),
    email: t.email,
    password: t.string.min(1),
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
    return { ok: true, next: '/feed', handle: input.handle };
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
     * Whether the `sessions` row was actually deleted, and not decoration: it is `false` on every
     * call today, because `requestSessionToken` cannot see the cookie. Reporting a revocation that
     * did not happen would be the one lie an operator must never be told about a sign-out.
     */
    revoked: t.boolean,
  }),
  policy: allow('public'),
  mcp: { expose: false },
  async handle({ ctx }) {
    const revoked = await signOut(requestSessionToken(ctx));
    // Cleared regardless. The browser forgetting the token is the half this process controls, and
    // the row expires on its own clock — `sessions.expiresAt` is absolute for exactly this reason.
    setResponseCookie(ctx, clearedSessionCookie(isSecureRequest(ctx)));
    return { ok: true, next: '/', revoked };
  },
});

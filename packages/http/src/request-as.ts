// A test-time call as an HTTP request reaches it: a fresh request, an actor seated on it, and the
// cookies and headers an exercise entry declares. Here, below action, query and testing, because
// the contract step and `x exercise` both make this call and one build of it is the only one.

import type { Actor } from '@ultimat3/core';
import {
  anonymousActor,
  renderCauseValue,
  renderFixLiteral,
  runWithContext,
  UltimateError,
  useContext,
  withChildContext,
} from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { asCtx, requestContext } from './context';

/** One exercise call's inbound request: `cookies` become its `Cookie:` header, never `headers`. */
export interface ExerciseRequest {
  readonly cookies?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
}

/** The request, or how to build it for the actor a call runs as (`null`: signed out). */
export type ExerciseRequestOption =
  | ExerciseRequest
  | ((actor: Actor | null) => ExerciseRequest | Promise<ExerciseRequest>);

/** Where these requests say they came from: no host an app serves, and never sent. */
const EXERCISE_ORIGIN = 'https://exercise.test';

/** RFC 6265 `cookie-name` is an RFC 9110 `token`: a name outside it no browser sends. */
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function refuse(name: string, why: string): never {
  throw new UltimateError({
    code: 'X_EXERCISE_REQUEST_INVALID',
    cause: `defineExercise() gives ${renderCauseValue(name)} a request ${why}`,
    fix: `defineExercise({ ${renderFixLiteral(name, '<name>')}: { request: { cookies: { <token>: '<value>' }, headers: { '<x-name>': '<value>' } } } })   # in apps/web/exercise.ts — a cookie goes in cookies, never a Cookie header`,
    meta: { name },
  });
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The declared request as inbound headers. Each cookie value is percent-encoded, which
 * `useRequestCookie` (core's `readCookie`) inverts exactly: the value declared is the value read.
 */
function inboundHeaders(name: string, declared: unknown): Headers {
  if (!isRecord(declared)) return refuse(name, 'that is not an object of cookies and headers');
  const { cookies = {}, headers = {} } = declared;
  if (!isRecord(cookies) || !isRecord(headers)) {
    return refuse(name, 'whose cookies or headers is not an object of strings');
  }
  const inbound = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'cookie') return refuse(name, 'with a Cookie header');
    if (typeof value !== 'string') return refuse(name, `whose header ${key} is not a string`);
    try {
      inbound.set(key, value);
    } catch {
      return refuse(name, `whose header ${renderCauseValue(key)} Headers refuses`);
    }
  }
  const pairs = Object.entries(cookies).map(([key, value]) => {
    if (!COOKIE_NAME.test(key)) return refuse(name, `naming cookie ${renderCauseValue(key)}`);
    if (typeof value !== 'string') return refuse(name, `whose cookie ${key} is not a string`);
    return `${key}=${encodeURIComponent(value)}`;
  });
  if (pairs.length > 0) inbound.set('cookie', pairs.join('; '));
  return inbound;
}

/**
 * `fn` inside a fresh request as `actor`: a POST to `name`, its rate limits process-scoped,
 * carrying `request` (none: no cookie, no header). A function `request` is awaited first, inside a
 * bare request as the same actor, so it can mint a session for whoever acts. The actor is ON the
 * request, so the caller passes `invoke` no `actor` — its impersonation path rebuilds a plain child
 * context and drops the request's fields. The child is derived first for the services an actor
 * binds, then the request's fields go over it, as `withAnonymousRequest` does.
 */
export async function withRequestAs<T>(
  name: string,
  actor: Actor | null,
  request: ExerciseRequestOption | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const declared: ExerciseRequest | undefined =
    typeof request === 'function'
      ? await inRequest(name, actor, new Headers(), () => Promise.resolve(request(actor)))
      : request;
  const headers = declared === undefined ? new Headers() : inboundHeaders(name, declared);
  return inRequest(name, actor, headers, fn);
}

function inRequest<T>(
  name: string,
  actor: Actor | null,
  requestHeaders: Headers,
  fn: () => Promise<T>,
): Promise<T> {
  const request = requestContext({
    url: new URL(`/${encodeURIComponent(name)}`, EXERCISE_ORIGIN),
    method: 'POST',
    role: 'web',
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    requestHeaders,
  });
  return runWithContext(asCtx(request), () =>
    withChildContext({ actor: actor ?? anonymousActor() }, () => {
      const child = useContext();
      const scope = { ...child, ...request, actor: child.actor };
      return runWithContext(asCtx(scope), fn);
    }),
  );
}

// How a handler that cannot return a `Response` still answers with one. An action's return
// value is its output schema, on every surface — HTTP, MCP, a job — so "answer 303" cannot be
// a return value without inventing a second protocol for one surface. It is recorded on the
// request context instead, and the surface that knows what a redirect means reads it back.

import type { RequestContext } from './context';
import { assertInRequest } from './context';
import type { RedirectIntent, RedirectStatus } from './response';

/**
 * Answer this request with a `Location` instead of the handler's return value.
 *
 * 303 by default because the caller is a `<form method="post">`: 303 turns the follow-up into a
 * GET, so a reload does not repost. A 302 here leaves the method up to the browser, and reposts.
 */
export const setRedirect = (location: string, status: RedirectStatus = 303): void => {
  assertInRequest('setRedirect()').redirect = { location, status };
};

/**
 * Read and clear. Clearing is the point: the slot outlives the handler that set it, and a
 * projection that only read it would redirect the *next* thing to look — an idempotent replay,
 * a second action invoked in the same request — to a location it never asked for.
 */
export const takeRedirect = (ctx: RequestContext): RedirectIntent | undefined => {
  const intent = ctx.redirect;
  ctx.redirect = undefined;
  return intent;
};

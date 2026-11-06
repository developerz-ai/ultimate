// The context an action or a query runs in during the exercise pass: an HTTP request's, built the
// way the pipeline builds one, because `surface: 'http'` is the call the pass makes. A bare `Ctx`
// has no inbound headers, so a session action's `useRequestContext()` answered X_NO_REQUEST, a 500.

import type { Actor } from '@ultimat3/core';
import { anonymousActor, runWithContext, useContext, withChildContext } from '@ultimat3/core';

/** Where the pass's requests say they came from: no host the app serves, and never sent. */
const EXERCISE_ORIGIN = 'https://exercise.test';

/**
 * `fn` inside a fresh request as `actor`: no cookie, no header, a POST to the primitive's own name,
 * nothing spending a rate bucket. The actor is ON the request, so the caller passes `invoke` no
 * `actor` — its impersonation path rebuilds a plain child context and drops the request's fields.
 * The child is derived first for the services an actor binds, then the request's fields go over
 * it, as `withAnonymousRequest` (`@ultimat3/http`) does.
 */
export async function withExerciseRequest<T>(
  name: string,
  actor: Actor | null,
  fn: () => Promise<T>,
): Promise<T> {
  const http = await import('@ultimat3/http');
  const request = http.requestContext({
    url: new URL(`/${encodeURIComponent(name)}`, EXERCISE_ORIGIN),
    method: 'POST',
    role: 'web',
    config: http.defineHttpConfig({ rateLimit: { scope: 'process' } }),
    requestHeaders: new Headers(),
  });
  return runWithContext(http.asCtx(request), () =>
    withChildContext({ actor: actor ?? anonymousActor() }, () => {
      const child = useContext();
      const scope = { ...child, ...request, actor: child.actor };
      return runWithContext(http.asCtx(scope), fn);
    }),
  );
}

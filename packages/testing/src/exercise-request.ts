// The context an action or a query runs in during the exercise pass: an HTTP request's, built the
// way the pipeline builds one, because `surface: 'http'` is the call the pass makes. A bare `Ctx`
// has no inbound headers, so a session action's `useRequestContext()` answered X_NO_REQUEST, a 500.
// The build is `@ultimat3/http`'s `withRequestAs`, the one the contract step makes too.

import type { Actor } from '@ultimat3/core';
import type { ExerciseRequestOption } from '@ultimat3/http';

/**
 * `fn` inside a fresh request as `actor`, carrying the entry's `request` (none: no cookie, no
 * header). `@ultimat3/http` is loaded on the call, so the barrel stays off it.
 */
export async function withExerciseRequest<T>(
  name: string,
  actor: Actor | null,
  fn: () => Promise<T>,
  request?: ExerciseRequestOption,
): Promise<T> {
  const { withRequestAs } = await import('@ultimat3/http');
  return withRequestAs(name, actor, request, fn);
}

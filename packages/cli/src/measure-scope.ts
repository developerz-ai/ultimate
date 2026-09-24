// The request a measurement render runs inside. `x build` renders every app/ route it cannot
// prerender only to WEIGH it, and that render reads its data the way a real one does: a `load`
// calls the app's typed client, over `APP_URL`, as the request's own member. So it needs a request
// context (`useRequestHeader('cookie')` throws X_NO_REQUEST outside one), an actor the app chose
// (`defineMeasurementActor()` in `app.config.ts`, core's `measurementActor()` otherwise), and a
// server to answer — the app's own API pipeline, dispatched IN PROCESS through core's
// `withInProcessFetch`, because no server is listening during a build (plan 101 slice 11 m).

import type { Actor, Ctx } from '@ultimat3/core';
import { measurementActor, runWithContext, withInProcessFetch } from '@ultimat3/core';
import {
  createPipeline,
  createRequestContext,
  createRouter,
  defineHttpConfig,
} from '@ultimat3/http';
import { apiRoutes } from './api-routes';

/** One build's measurement scope: its actor, and a runner that renders inside it. */
export interface MeasureScope {
  readonly actor: Actor;
  run<T>(fn: () => T): T;
}

/**
 * The scope for `origin`. The pipeline is the app's API table and nothing else: a page's data
 * comes from its actions and queries, and a route the render reaches that is not one of them
 * answers 404 — which the render reports, and the route is filed unmeasured with that reason.
 */
export async function measureScope(input: {
  readonly origin: string;
  readonly buildId: string;
}): Promise<MeasureScope> {
  const actor = await measurementActor();
  // No rate limit: every request here is this build's own render, and a limiter would need a
  // deployment scope a build does not have (`X_RATE_LIMIT_SCOPE_UNSET`).
  const config = defineHttpConfig({ buildId: input.buildId, rateLimit: { enabled: false } });
  const ctx = createRequestContext({
    url: new URL(input.origin),
    method: 'GET',
    role: 'web',
    config,
  });
  ctx.actor = actor;
  const pipeline = createPipeline({
    table: createRouter(apiRoutes()),
    config,
    hooks: { authenticate: () => actor },
  });
  const dispatch = (url: string, init: RequestInit): Promise<Response> =>
    pipeline.handle(new Request(url, init), { role: 'web' });
  const request: Ctx = ctx;
  return {
    actor,
    run: <T>(fn: () => T): T => withInProcessFetch(dispatch, () => runWithContext(request, fn)),
  };
}

/**
 * `APP_URL` for the length of `fn`, when the process has none: an app's typed client reads it to
 * name the origin it posts to, and `withInProcessFetch` answers that origin in process. A value
 * the process already carries is left alone — it is the app's.
 */
export async function withAppUrl<T>(origin: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env['APP_URL'];
  if (before !== undefined && before !== '') return fn();
  process.env['APP_URL'] = origin;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env['APP_URL'];
    else process.env['APP_URL'] = before;
  }
}

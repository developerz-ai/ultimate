// A route `load` that reads through the app's own typed client (`queries.orgPosts(…)` over
// `APP_URL`) answered IN PROCESS during `x exercise`, as the build's measurement render is
// (`measure-scope.ts`): core's `withInProcessFetch` hands each call to the app's own API pipeline,
// authenticated as the actor the load runs as — so its statements are the load's, counted and swept.

import type { Actor } from '@ultimat3/core';
import { asyncContext, isAnonymous, tryUseContext, withInProcessFetch } from '@ultimat3/core';
import { defineHttpConfig, httpPipeline, httpRouter } from '@ultimat3/http';
import type { RouteLoadSubject } from '@ultimat3/testing';
import { apiRoutes } from './api-routes';

/** The origin the typed client is told when the app's env names none: never dialled. */
export const EXERCISE_APP_URL = 'http://localhost:3000';

/** Who the in-process request authenticates as: the load's own actor, read at the call. */
const caller = asyncContext<Actor | null>('the exercise in-process caller');

/** One dispatcher over the app's API table, built on first use: the registries are full by then. */
function dispatcher(): (url: string, init: RequestInit) => Promise<Response> {
  // No rate limit: every request is the pass's own, as a build's are (`measure-scope.ts`).
  const config = defineHttpConfig({
    buildId: process.env['BUILD_ID'] ?? 'dev',
    rateLimit: { enabled: false },
  });
  const pipeline = httpPipeline({
    table: httpRouter(apiRoutes()),
    config,
    hooks: { authenticate: () => caller.get() ?? null },
  });
  return (url, init) => {
    // A `prerender()` runs in no request: nobody, as a published read is (`publicScope`).
    const actor = tryUseContext()?.actor;
    // The page's own server calling its own API: same-origin by construction, so it says so —
    // a write with neither `origin` nor `sec-fetch-site` is `X_CSRF_BLOCKED`, as it should be.
    const headers = new Headers(init.headers);
    if (!headers.has('origin')) headers.set('origin', new URL(url).origin);
    return caller.run(actor === undefined || isAnonymous(actor) ? null : actor, () =>
      pipeline.handle(new Request(url, { ...init, headers }), { role: 'web' }),
    );
  };
}

/**
 * The app's own origin — `APP_URL` as the typed client reads it, at the call: only its urls are
 * the app's to answer. Any other host is a call out, left to the pass's sealed network, which
 * refuses and records it as one (`exercise-report.ts`).
 */
const ownOrigin = (url: string): boolean => {
  const base = process.env['APP_URL'] || EXERCISE_APP_URL;
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
};

/** `routes`, each load's (and `prerender()`'s) typed-client calls answered by the app's API here. */
export function servedInProcess(routes: readonly RouteLoadSubject[]): readonly RouteLoadSubject[] {
  let dispatch: ReturnType<typeof dispatcher> | undefined;
  const served = (url: string, init: RequestInit): Promise<Response> => {
    dispatch ??= dispatcher();
    return dispatch(url, init);
  };
  return routes.map((route) => {
    const { samples } = route;
    return {
      ...route,
      load: (ctx) => withInProcessFetch(served, () => route.load(ctx), ownOrigin),
      ...(samples === undefined
        ? {}
        : { samples: () => withInProcessFetch(served, () => samples.call(route), ownOrigin) }),
    };
  });
}

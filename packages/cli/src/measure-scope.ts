// The request a measurement render runs inside. `x build` renders every app/ route it cannot
// prerender only to WEIGH it, and that render reads its data the way a real one does: a `load`
// calls the app's typed client, over `APP_URL`, as the request's own member. So it needs a request
// context (`useRequestHeader('cookie')` throws X_NO_REQUEST outside one), an actor the app chose
// (`defineMeasurementActor()` in `app.config.ts`, core's `measurementActor()` otherwise), and a
// server to answer — the app's own API pipeline, dispatched IN PROCESS through core's
// `withInProcessFetch`, because no server is listening during a build (plan 101 slice 11 m) — and
// `runtime.ts`'s ports as `offline-ports.ts` decides them, for every render the build runs.

import type { Actor, Ctx } from '@ultimat3/core';
import { actorLabel, measurementActor, runWithContext, withInProcessFetch } from '@ultimat3/core';
import { defineHttpConfig, httpPipeline, httpRouter, requestContext } from '@ultimat3/http';
import { apiRoutes } from './api-routes';
import { installOfflinePorts } from './offline-ports';

/** One build's measurement scope: its actor, a runner that renders inside it, and its release. */
export interface MeasureScope {
  readonly actor: Actor;
  run<T>(fn: () => T): T;
  /** Releases the ports `measureScope` installed. Once, when the build's renders are done. */
  close(): Promise<void>;
}

/** A scope's in-process API: the app's own table, as `actor` — or, `null`, as nobody. */
interface ScopeInput {
  readonly origin: string;
  readonly buildId: string;
}

const originOf = (url: string | undefined): string | undefined =>
  url !== undefined && URL.canParse(url) ? new URL(url).origin : undefined;

/**
 * Whether `url` is the app's own: the build's origin, or the `APP_URL` its typed client posts to
 * (read at the call — `withAppUrl` may set it after the scope is built). Any other host is a call
 * out the page makes in production too — a CMS, a vendor API — and reaches the network: answered by
 * the app's pipeline it was a 404, and the route was filed unmeasured for a fetch it never made.
 */
function ownedBy(origin: string): (url: string) => boolean {
  return (url) => {
    const target = originOf(url);
    if (target === undefined) return false;
    return target === originOf(origin) || target === originOf(process.env['APP_URL'] || undefined);
  };
}

function inProcessRunner(input: ScopeInput, actor: Actor | null): <T>(fn: () => T) => T {
  // No rate limit: every request here is this build's own render, and a limiter would need a
  // deployment scope a build does not have (`X_RATE_LIMIT_SCOPE_UNSET`).
  const config = defineHttpConfig({ buildId: input.buildId, rateLimit: { enabled: false } });
  const ctx = requestContext({
    url: new URL(input.origin),
    method: 'GET',
    role: 'web',
    config,
  });
  if (actor !== null) ctx.actor = actor;
  const pipeline = httpPipeline({
    table: httpRouter(apiRoutes()),
    config,
    hooks: { authenticate: () => actor },
  });
  const dispatch = (url: string, init: RequestInit): Promise<Response> =>
    pipeline.handle(new Request(url, init), { role: 'web' });
  const request: Ctx = ctx;
  const owns = ownedBy(input.origin);
  return <T>(fn: () => T): T =>
    withInProcessFetch(dispatch, () => runWithContext(request, fn), owns);
}

/** A measurement scope's input: the app at `root`, whose `runtime.ts` the build honours. */
interface MeasureInput extends ScopeInput {
  readonly root: string;
}

/**
 * The scope for `origin`. The pipeline is the app's API table and nothing else: a page's data
 * comes from its actions and queries, and a route on the app's origin the render reaches that is
 * not one of them answers 404 — which the render reports, and the route is filed unmeasured with
 * that reason. Another host's url is not the app's (`ownedBy`), and reaches the network.
 * For a render that is WEIGHED and discarded only: its output is never published.
 */
export async function measureScope(input: MeasureInput): Promise<MeasureScope> {
  const actor = await measurementActor();
  // Installed here rather than per render: the published (`site/`) renders read the same ports, and
  // a page whose `load` calls an `audit: true` query was unmeasured with `X_AUDIT_SINK_MISSING`
  // for an app that declared its sink in `runtime.ts`, as upgrade entry 43 says to.
  const close = await installOfflinePorts(input.root);
  return { actor, run: inProcessRunner(input, actor), close };
}

/**
 * The same in-process API, authenticating NOBODY: what a read whose answer is PUBLISHED runs in —
 * a `site/` route's `prerender()` (sitemap.xml) and an llms.txt page's `load`. Run as the
 * measurement actor, those listed rows only that actor may read (a demo owner's drafts).
 */
export function publicScope(input: ScopeInput): <T>(fn: () => T) => T {
  return inProcessRunner(input, null);
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

/**
 * The measurement actor as a refusal names it: core's `actorLabel` (kind, id, tenant) — the one
 * actor format — plus the roles, which a role-gated page asks of it and `actorLabel` omits (#675).
 * Never `facts`: this lands in a report and a gate finding.
 */
export function measurementActorLabel(actor: Actor): string {
  const roles = actor.roles.length === 0 ? 'none' : actor.roles.join(', ');
  return `${actorLabel(actor)} (roles: ${roles})`;
}

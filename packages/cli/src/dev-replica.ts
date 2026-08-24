// Read-replica routing, WIRED. `@ultimat3/db` ships both halves and a booted process reached
// neither, so the capability was shipped and unactivated — the "declared and never wired" class
// this release exists to eliminate.
//
// Two things had to be false for it to route, and both were:
//
// 1. `defaultClient()` is the one place db composes `replicatedClient(primary, replica)` from
//    `DATABASE_REPLICA_URL`, and it runs only from `baseClient()` — "the client an app installed
//    none for". Every process the framework boots installs one: `dev-queue.ts` calls
//    `setDbClient(createPgliteClient(…) | createPostgresClient({ url }))`, so `defaultClient()` was
//    unreachable from `x dev`, from `apps/web/server.ts` and from every container role.
// 2. Routing needs an OPEN scope as well as a configured replica, and nothing opened one.
//
// This file answers both from the boot, which is the only tier that may know about a request AND
// about a pool. It is deliberately NOT a change to `@ultimat3/http`'s pipeline: that would make the
// HTTP tier depend on `@ultimat3/db` — legal downward, and still a package that would then know
// what a database is.

import type { DbClient, PostgresClient } from '@ultimat3/db';
import {
  createPostgresClient,
  REPLICA_URL_ENV,
  replicatedClient,
  withReplicaReads,
} from '@ultimat3/db';
import type { Middleware } from '@ultimat3/http';
import type { ServiceBinding } from './dev-services';
import type { RuntimeOverrides } from './runtime-overrides';

export type ReplicaEnv = Readonly<Record<string, string | undefined>>;

/**
 * The replica url this boot should use, or `undefined`. Two conditions, and the second is the one
 * a homework app depends on: an EMBEDDED database is PGlite in this process, which has no standby
 * and never will, so a `DATABASE_REPLICA_URL` left over in a shell must not silently open a second
 * pool beside it.
 */
export function replicaUrlFor(binding: ServiceBinding, env: ReplicaEnv): string | undefined {
  if (binding.mode !== 'external') return undefined;
  const url = env[REPLICA_URL_ENV];
  return url === undefined || url.trim() === '' ? undefined : url;
}

/** What a boot has to hold on to: the ambient client, and the pool `stop()` must close. */
export interface ReplicaAttachment {
  /** What `setDbClient()` receives — the pair when one is configured, the primary otherwise. */
  readonly client: DbClient;
  /** The standby pool this boot opened, or nothing. `ReplicatedClient` has no `close()`. */
  readonly replica: PostgresClient | undefined;
}

/**
 * The primary as it is, or the primary with a standby behind it. Composed here rather than by
 * calling `defaultClient()`, because that function builds its own primary from `DATABASE_URL` and
 * this boot has already RESOLVED which database it is talking to (`resolveServices`) — asking the
 * environment a second question is how a process ends up with two answers to "which database is
 * this". The pieces are db's own, so the routing rule is still stated in one place.
 */
export function attachReplica(
  primary: DbClient,
  replicaUrl: string | undefined,
): ReplicaAttachment {
  if (replicaUrl === undefined) return { client: primary, replica: undefined };
  const replica = createPostgresClient({ url: replicaUrl, applicationName: 'ultimate-replica' });
  return { client: replicatedClient(primary, replica), replica };
}

/**
 * The scope, opened once per request, OUTSIDE the handler — so a write early in a request pins
 * every later read in it to the primary, which is what read-your-writes means. `compose()` wraps
 * each route handler, and every read and write a request makes happens inside one.
 *
 * EMPTY when no replica is configured, and that is the whole cost argument: a homework app
 * installs no middleware, allocates no scope object and enters no `AsyncLocalStorage` run per
 * request. With one configured, the list is a single frame.
 */
export function replicaMiddleware(binding: ServiceBinding, env: ReplicaEnv): readonly Middleware[] {
  if (replicaUrlFor(binding, env) === undefined) return [];
  return [(request, ctx, next) => withReplicaReads(() => next(request, ctx))];
}

/**
 * The boot's `RuntimeOverrides` with the scope middleware laid in FRONT of whatever a host
 * supplied — `compose([a, b])` runs `a` outermost, and the scope must open outside every read and
 * write the request makes or a write early in it cannot pin the reads after it.
 *
 * Returns the caller's own value UNCHANGED when no replica is configured, which is what keeps a
 * homework app from paying for this: no key added, no empty array, nothing for `startRoles` to
 * forward.
 */
export function replicaOverrides(
  overrides: RuntimeOverrides | undefined,
  binding: ServiceBinding,
  env: ReplicaEnv,
): RuntimeOverrides | undefined {
  const middleware = replicaMiddleware(binding, env);
  if (middleware.length === 0) return overrides;
  return { ...overrides, middleware: [...middleware, ...(overrides?.middleware ?? [])] };
}

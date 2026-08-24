// Single responsibility: the client `baseClient()` builds when an app installed none — the primary
// pool, plus a read replica when one is configured. Its own file because it is the one place the
// framework decides a process's database topology from the environment, and `client.ts` is at the
// line ceiling.

import { createPostgresClient, type DbClient, poolMaxFromEnv } from './client';
import { replicatedClient } from './replica-client';

/**
 * A read replica's connection string. Unset — which is every app that has not asked for one — and
 * this builds exactly the single-pool client it always did, statement for statement.
 *
 * It must name a READ-ONLY standby. A statement misrouted to one is refused with `25006` and
 * re-run on the primary, and that refusal is the safety net a text classifier cannot be; a URL
 * pointing at a writable node turns a misroute into a write on the wrong server, silently.
 */
export const REPLICA_URL_ENV = 'DATABASE_REPLICA_URL';

/**
 * Composed rather than folded into `createPostgresClient`, on purpose: `migrate`, `x db branch` and
 * every test build a client that must be exactly one pool, and a second pool reachable through the
 * same factory would be a second thing `reserve()`, `close()` and `ping()` each have to mean two
 * ways.
 *
 * The replica inherits the role's profile, `DATABASE_POOL_MAX` included: a fleet sized against
 * `max_connections` has two servers to size against, not one, and a replica pool that ignored the
 * operator's number would be the exhaustion `poolMaxFromEnv` exists to prevent, on the other host.
 */
export function defaultClient(): DbClient {
  const profile = poolMaxFromEnv();
  const primary = createPostgresClient({ profile });
  const replicaUrl = process.env[REPLICA_URL_ENV];
  if (replicaUrl === undefined || replicaUrl.trim() === '') return primary;
  return replicatedClient(primary, createPostgresClient({ url: replicaUrl, profile }));
}

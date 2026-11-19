// Which real services a drill runs against, read from the `TEST_*` URLs `docker/test-services.env`
// writes and from what the app declares. A service the app uses must be there for EVERY drill — the
// role would refuse to boot without it — and the faulted one must be one the app actually uses.

import { DrillServiceMissingError } from './drill-errors';
import type { DrillServiceUrls } from './drill-fleet';
import type { Drill } from './drills';
import { drillService } from './drills';
import { TEST_SERVICE_ENV } from './test-types-services';

/**
 * The variables the test services are published under (`docker/test-services.env`): the same map a
 * typed test's `{ needs }` reads, never a second copy of it.
 */
export const DRILL_SERVICE_ENV = TEST_SERVICE_ENV;

/** What the app's config says it uses, beyond the Postgres every drill needs. */
export interface DrillDeclarations {
  /** `cache.tiers` names `redis`. */
  readonly redis: boolean;
  /** `realtime.transport` is `nats`, read from the variable `realtime.urlEnv` names. */
  readonly nats: { readonly env: string } | undefined;
}

/** The `wal_level=logical` server `docker/test-services.env` publishes: the replicator's. */
const LOGICAL_POSTGRES_ENV = 'TEST_REPLICATION_URL';
/** Where the rollout order hands a bus the app itself does not declare. */
const DEFAULT_BUS_ENV = 'NATS_URL';

type Env = Readonly<Record<string, string | undefined>>;

const present = (env: Env, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
};

const read = (env: Env, name: string, drill: Drill): string => {
  const value = env[name]?.trim();
  if (value === undefined || value === '') {
    throw new DrillServiceMissingError({
      drill: drill.name,
      gap: { kind: 'unset', variable: name },
    });
  }
  return value;
};

/** The URLs `drill` runs on, or `X_DRILL_SERVICE_MISSING` naming the one gap. */
export function drillServices(
  drill: Drill,
  env: Env,
  declared: DrillDeclarations,
): DrillServiceUrls {
  const faulted = drillService(drill);
  if (faulted === 'redis' && !declared.redis) {
    throw new DrillServiceMissingError({
      drill: drill.name,
      gap: {
        kind: 'undeclared',
        declaration: "cache: { tiers: ['request-memo', 'lru', 'redis'] }",
      },
    });
  }
  if (faulted === 'nats' && declared.nats === undefined) {
    throw new DrillServiceMissingError({
      drill: drill.name,
      gap: {
        kind: 'undeclared',
        declaration: "realtime: { transport: 'nats', urlEnv: 'NATS_URL' }",
      },
    });
  }
  const redis = declared.redis ? read(env, DRILL_SERVICE_ENV.redis, drill) : undefined;
  if (drill.fault.kind === 'order') {
    // Every role that can start is played, so the bus and the logical server are taken when the
    // run has them; without them the drill still plays what Postgres alone serves, and says so.
    const logical = present(env, LOGICAL_POSTGRES_ENV);
    const bus =
      declared.nats === undefined
        ? present(env, DRILL_SERVICE_ENV.nats)
        : read(env, DRILL_SERVICE_ENV.nats, drill);
    return {
      postgres: logical ?? read(env, DRILL_SERVICE_ENV.postgres, drill),
      logicalPostgres: logical !== undefined,
      redis,
      nats:
        bus === undefined ? undefined : { url: bus, env: declared.nats?.env ?? DEFAULT_BUS_ENV },
    };
  }
  const postgres = read(env, DRILL_SERVICE_ENV.postgres, drill);
  const nats =
    declared.nats === undefined
      ? undefined
      : { url: read(env, DRILL_SERVICE_ENV.nats, drill), env: declared.nats.env };
  return { postgres, redis, nats };
}

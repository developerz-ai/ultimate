// Which real services a drill runs against, read from the `TEST_*` URLs `docker/test-services.env`
// writes and from what the app declares. A service the app uses must be there for EVERY drill — the
// role would refuse to boot without it — and the faulted one must be one the app actually uses.

import { DrillServiceMissingError } from './drill-errors';
import type { DrillServiceUrls } from './drill-fleet';
import type { Drill } from './drills';
import { drillService } from './drills';

/** The variables the test services are published under (`docker/test-services.env`). */
export const DRILL_SERVICE_ENV = {
  postgres: 'TEST_DATABASE_URL',
  redis: 'TEST_REDIS_URL',
  nats: 'TEST_NATS_URL',
} as const;

/** What the app's config says it uses, beyond the Postgres every drill needs. */
export interface DrillDeclarations {
  /** `cache.tiers` names `redis`. */
  readonly redis: boolean;
  /** `realtime.transport` is `nats`, read from the variable `realtime.urlEnv` names. */
  readonly nats: { readonly env: string } | undefined;
}

type Env = Readonly<Record<string, string | undefined>>;

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
  const postgres = read(env, DRILL_SERVICE_ENV.postgres, drill);
  const redis = declared.redis ? read(env, DRILL_SERVICE_ENV.redis, drill) : undefined;
  const nats =
    declared.nats === undefined
      ? undefined
      : { url: read(env, DRILL_SERVICE_ENV.nats, drill), env: declared.nats.env };
  return { postgres, redis, nats };
}

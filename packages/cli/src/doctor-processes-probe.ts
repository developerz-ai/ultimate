// `x doctor`'s processes fact, read: each role through the boot's own `resolveProcessCount` as a
// production container on this host would ask it (cgroup, cores, pool, shared state), the
// `tcp_migrate_req` sysctl, and the server's `max_connections`. `doctor-processes.ts` judges it.

import type { Role } from '@ultimat3/core';
import { ROLES, resolveEnvironment } from '@ultimat3/core';
import { redisUrlSource } from '@ultimat3/core/redis';
import { POOL_PROFILES, poolMaxFromEnv, postgresClient, sql } from '@ultimat3/db';
import { loadAppConfig } from './app-config-load';
import type { ProcessesFact, RoleProcesses } from './doctor-processes';
import { findingFrom } from './output';
import { cacheTiersOf } from './runtime-cache';
import type { ReadText } from './supervise-cgroup';
import { readCgroup, readText } from './supervise-cgroup';
import { resolveProcessCount } from './supervise-count';

type Env = Readonly<Record<string, string | undefined>>;

/** Every role a container runs as; `migrate` runs once and exits, so it holds nothing. */
const REPORTED: readonly Role[] = ROLES.filter((role) => role !== 'migrate');

export const MIGRATE_REQ_PATH = '/proc/sys/net/ipv4/tcp_migrate_req';

const set = (value: string | undefined): boolean => value !== undefined && value.trim() !== '';

export interface ProcessesSources {
  readonly root: string | undefined;
  readonly env: Env;
  readonly platform: string;
  readonly cores: number;
  readonly read: ReadText;
  readonly maxConnections: () => Promise<number | undefined>;
}

/**
 * Asked as `production`: the fact answers what a deployed container here would run, which `x dev`
 * (always one process) never does. Per-process stores a `runtime.ts` supplies are not loaded, and
 * the image is taken as prebuilt (the Dockerfile's `x build --target prebuilt`): the boot itself
 * clamps on both, and its line names that clamp.
 */
export async function processesFact(sources: ProcessesSources): Promise<ProcessesFact> {
  const { env } = sources;
  const config = sources.root === undefined ? undefined : await loadAppConfig(sources.root);
  const cgroup = await readCgroup(sources.read);
  const shared = {
    // The boot's own readers (`supervise-facts.ts`), so the two can never disagree.
    lruTier: cacheTiersOf(config).includes('lru'),
    crossingBus: set(env['NATS_URL']),
    redis: redisUrlSource(env) !== undefined,
    embeddedDatabase: !set(env['DATABASE_URL']),
    stores: [],
  };
  const poolOf = (role: Role): number => poolMaxFromEnv(env).max ?? POOL_PROFILES[role].max;
  const roles = await Promise.all(
    REPORTED.map(async (role): Promise<RoleProcesses> => {
      const listen = role === 'worker' ? 1 : 0;
      try {
        const resolved = await resolveProcessCount({
          env,
          role,
          platform: sources.platform,
          environment: 'production',
          cgroup: async () => cgroup,
          parallelism: () => sources.cores,
          pool: () => poolOf(role),
          shared: async () => ({ role, ...shared }),
          prebuilt: async () => true,
        });
        return { role, resolved, pool: poolOf(role), listen };
      } catch (error) {
        return {
          role,
          resolved: { refused: findingFrom(error) },
          pool: POOL_PROFILES[role].max,
          listen,
        };
      }
    }),
  );
  const requested = env['ULTIMATE_PROCESSES']?.trim() ?? '';
  return {
    environment: resolveEnvironment({ env }),
    cores: sources.cores,
    cpuBudget: cgroup.cpus,
    explicit: requested !== '' && requested !== 'auto',
    migrateReq: (await sources.read(MIGRATE_REQ_PATH))?.trim(),
    roles,
    maxConnections: await sources.maxConnections(),
  };
}

/** `max_connections` over one connection (the pool fills to max on first use); none on any failure. */
export async function maxConnectionsOf(
  url: string | undefined,
  env: Env,
): Promise<number | undefined> {
  if (url === undefined || url.trim() === '') return undefined;
  let client: ReturnType<typeof postgresClient> | undefined;
  try {
    client = postgresClient({
      url,
      role: 'web',
      env,
      applicationName: 'x-doctor',
      profile: { max: 1 },
    });
    const rows = await client.query<{ readonly setting: string }>(
      sql`select setting from pg_settings where name = 'max_connections'`,
    );
    const max = Number(rows[0]?.setting);
    return Number.isSafeInteger(max) && max > 0 ? max : undefined;
  } catch {
    // Unreachable is `database()`'s finding to make; this fact only omits the comparison.
    return undefined;
  } finally {
    await client?.close();
  }
}

/** The real sources: this host's files, cores and database. */
export const hostProcessesSources = (
  root: string | undefined,
  env: Env,
  databaseUrl: () => Promise<string | undefined>,
): ProcessesSources => ({
  root,
  env,
  platform: process.platform,
  cores: navigator.hardwareConcurrency,
  read: readText,
  maxConnections: async () => maxConnectionsOf(await databaseUrl(), env),
});

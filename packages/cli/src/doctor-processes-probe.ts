// `x doctor`'s processes fact, read: each role through the boot's own `resolveProcessCount` as a
// production container on this host would ask it (cgroup, cores, pool, shared state), the
// `tcp_migrate_req` sysctl, and the server's `max_connections`. `doctor-processes.ts` judges it.

import type { Role } from '@ultimat3/core';
import { ROLES, resolveEnvironment } from '@ultimat3/core';
import { POOL_PROFILES, poolMaxFromEnv, postgresClient, sql } from '@ultimat3/db';
import { loadAppRuntime } from './app-runtime';
import type { ProcessesFact, RoleProcesses } from './doctor-processes';
import { findingFrom } from './output';
import type { RuntimeOverrides } from './runtime-overrides';
import type { ReadText } from './supervise-cgroup';
import { readCgroup, readText } from './supervise-cgroup';
import { resolveProcessCount } from './supervise-count';
import { sharedStateFacts } from './supervise-facts';

type Env = Readonly<Record<string, string | undefined>>;

/** Every role a container runs as; `migrate` runs once and exits, so it holds nothing. */
const REPORTED: readonly Role[] = ROLES.filter((role) => role !== 'migrate');

export const MIGRATE_REQ_PATH = '/proc/sys/net/ipv4/tcp_migrate_req';

export interface ProcessesSources {
  readonly root: string;
  readonly env: Env;
  /** `apps/<app>/runtime.ts`'s overrides: its stores and transport are shared state or not. */
  readonly runtime: () => Promise<RuntimeOverrides | undefined>;
  readonly platform: string;
  readonly cores: number;
  readonly read: ReadText;
  readonly maxConnections: () => Promise<number | undefined>;
}

/**
 * Asked as `production`: the fact answers what a deployed container here would run, which `x dev`
 * (always one process) never does. The image is taken as prebuilt (the Dockerfile's `x build
 * --target prebuilt`): the boot itself clamps on that, and its line names the clamp.
 */
export async function processesFact(sources: ProcessesSources): Promise<ProcessesFact> {
  const { env } = sources;
  const runtime = await sources.runtime();
  // The boot's own reader of shared state (`supervise-facts.ts`) over the same `runtime.ts`, so
  // doctor and the boot cannot name different clamps.
  const options = { root: sources.root, env, ...(runtime === undefined ? {} : { runtime }) };
  const cgroup = await readCgroup(sources.read);
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
          shared: () => sharedStateFacts(options, role),
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

/** The real sources: this host's files, cores, app and database. */
export const hostProcessesSources = (
  root: string,
  env: Env,
  databaseUrl: () => Promise<string | undefined>,
): ProcessesSources => ({
  root,
  env,
  runtime: () => loadAppRuntime(root),
  platform: process.platform,
  cores: navigator.hardwareConcurrency,
  read: readText,
  maxConnections: async () => maxConnectionsOf(await databaseUrl(), env),
});

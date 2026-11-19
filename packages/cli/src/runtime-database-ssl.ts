// `app.config.ts`'s `database.ssl`, obeyed wherever this package opens a Postgres connection:
// `true` requires TLS on a connection string that states no mode of its own. What the operator
// wrote always wins.

import { loadAppConfig } from './app-config-load';
import type { DevServices, Env } from './runtime-bindings';

/** libpq's parameter, which `Bun.SQL` reads off the URL (measured on bun 1.4: `require` refuses a
 * server with no TLS, `ERR_POSTGRES_TLS_NOT_AVAILABLE`). */
const SSL_MODE = 'sslmode';

/**
 * `url` with `sslmode=require`, unless a mode is already stated — in the URL (`sslmode`, or the
 * `ssl` spelling some dashboards hand out) or by `PGSSLMODE` in the boot's env. Never an override:
 * replacing `verify-full` with `require` would drop certificate verification, and replacing
 * `disable` would break the sidecar or loopback hop it was written for. `require` and not
 * `verify-full` because a managed Postgres seldom ships its CA into the image; an operator who
 * has one says so in the URL. A value no URL parser reads is handed on as it is: `postgresClient`
 * refuses it by name (`X_DB_UNAVAILABLE`).
 */
export function withRequiredTls(url: string, env: Env): string {
  if ((env['PGSSLMODE'] ?? '').trim() !== '') return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.searchParams.has(SSL_MODE) || parsed.searchParams.has('ssl')) return url;
  parsed.searchParams.set(SSL_MODE, 'require');
  return parsed.toString();
}

/**
 * Whether this boot's pool must be TLS: `database.ssl` of the app at `services.root`. `false` for
 * the embedded database (PGlite is in this process: there is no wire) without reading the config,
 * and for a root with no `app.config.ts`.
 */
export async function databaseSslOf(services: DevServices): Promise<boolean> {
  if (services.db.mode !== 'external') return false;
  return (await loadAppConfig(services.root))?.database.ssl === true;
}

/** The connection strings a role reads off its env rather than through `startDb`. */
const URL_KEYS = ['DATABASE_URL', 'REPLICATION_URL'] as const;

/**
 * `withRequiredTls` for a pool that never calls `startDb` — `x doctor`'s probes, `x db branch`,
 * `x deploy verify`'s queue read — when the app at `root` declares `database.ssl`. Only a Postgres
 * URL is touched: the embedded database's is a directory, and has no wire to encrypt.
 */
export async function withAppTls<U extends string | undefined>(
  root: string | undefined,
  url: U,
  env: Env,
): Promise<U | string> {
  if (root === undefined || url === undefined || !/^postgres(?:ql)?:\/\//i.test(url.trim())) {
    return url;
  }
  if ((await loadAppConfig(root))?.database.ssl !== true) return url;
  return withRequiredTls(url, env);
}

/**
 * `env` as a role that dials from it must read it (the replicator's `REPLICATION_URL` session and
 * its advisory lock): each connection string under the same rule. Untouched without the switch.
 */
export async function envWithAppTls(root: string, env: Env): Promise<Env> {
  const next: Record<string, string | undefined> = { ...env };
  for (const key of URL_KEYS) {
    const url = env[key];
    if (url !== undefined && url.trim() !== '') next[key] = await withAppTls(root, url, env);
  }
  return next;
}

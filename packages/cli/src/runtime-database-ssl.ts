// `app.config.ts`'s `database.ssl`, obeyed where the boot opens its pool: `true` requires TLS on a
// connection string that states no mode of its own. What the operator wrote always wins.

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

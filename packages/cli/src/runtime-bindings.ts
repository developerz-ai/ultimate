// Service resolution for `x dev`. No Docker, no env scavenger hunt: an unset variable means the
// embedded default, and the resolved set is printed at boot so there is never a question about
// which database a running process is talking to.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderThrowable } from '@ultimat3/core';
import { StorageUnwritableError } from './errors';
import { safeUrlLabel } from './safe-url-label';

export type ServiceMode = 'embedded' | 'external';

export interface ServiceBinding {
  readonly name: 'db' | 'events' | 'storage';
  readonly mode: ServiceMode;
  readonly url: string;
  /** What the embedded default is, so `x doctor` can explain the difference. */
  readonly detail: string;
}

export interface DevServices {
  readonly db: ServiceBinding;
  readonly events: ServiceBinding;
  readonly storage: ServiceBinding;
  readonly stateDir: string;
  /**
   * The app directory itself, carried rather than re-derived from `stateDir`. A boot that needs
   * to read the app's own `app.config.ts` — `startServices`' `loadAppConfig` does — otherwise has
   * to undo the `join(root, '.x')` above, and a `dirname` that silently disagrees with this
   * file's join is a path bug nothing would catch.
   */
  readonly root: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * An embedded binding's `url`: `<scheme>://` and then the HOST path, verbatim — a scheme-tagged
 * path, NOT a URL. `pglite://D:\\app\\.x\\pgdata` is what Windows gets, and no URL parser reads it
 * back (a `\\` is not a separator to one, a space would need encoding). Nothing parses it: db's
 * `pgliteDataDir` and `startStorage` strip the prefix, and the report goes through `safeUrlLabel`,
 * which answers the binding's name for anything that is not a URL. `Bun.pathToFileURL` was the
 * other option, and would have made both readers decode as well as strip.
 */
export const embeddedLocation = (scheme: 'pglite' | 'file', path: string): string =>
  `${scheme}://${path}`;

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim().length === 0 ? undefined : value;

const s3EndpointOf = (env: Env): string | undefined => nonEmpty(env['S3_ENDPOINT']);

/**
 * THE storage choice: a non-empty `S3_ENDPOINT` is object storage, anything else the embedded disk
 * — which alone mints its own signed URLs and so needs `STORAGE_SIGNING_SECRET`. Exported so the
 * deploy contract (`framework-env.ts`) asks this function rather than restating the rule.
 */
export const storageIsExternal = (env: Env): boolean => s3EndpointOf(env) !== undefined;

/**
 * `.x/`, coded. A read-only root filesystem (the chart's `readOnlyRootFilesystem: true`) with
 * `DATABASE_URL` set and no `S3_ENDPOINT` threw a bare `EROFS`/`EACCES` here — every role,
 * `ROLE=migrate` included — before `startStorage`'s own coded refusal of the same disk could run.
 */
function makeStateDir(stateDir: string): void {
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch (cause) {
    throw new StorageUnwritableError(
      `the embedded database or storage disk needs the state directory ${stateDir} and it could not be created: ${renderThrowable(cause)}`,
      `export ULTIMATE_STATE_DIR=/tmp/ultimate-state   # any writable directory or volume; or set DATABASE_URL, S3_ENDPOINT and S3_BUCKET so nothing embedded needs ${stateDir}`,
    );
  }
}

/**
 * Embedded Postgres is PGlite on disk under `.x/`, so a restart keeps the data and a `x db reset`
 * is a directory delete rather than a container dance.
 */
export function resolveServices(root: string, env: Env): DevServices {
  // `ULTIMATE_STATE_DIR` relocates the whole of `.x/` — the embedded database, the local disk and
  // the dev lock — for one process tree. It is how an e2e run boots the app on a THROWAWAY database
  // (`e2e-app.ts`) instead of resetting the developer's own, beside a running `x dev`.
  const stateDir = nonEmpty(env['ULTIMATE_STATE_DIR']) ?? join(root, '.x');
  const databaseUrl = nonEmpty(env['DATABASE_URL']);
  const s3Endpoint = s3EndpointOf(env);
  // Created only when something will actually live in it: the embedded database and the local disk
  // do, in-process events never touch the disk. A container whose bindings are external runs
  // non-root over a read-only app directory, and a mkdir there is an EACCES at boot for a directory
  // that would have stayed empty — which an unset NATS_URL alone used to trigger.
  if (databaseUrl === undefined || s3Endpoint === undefined) makeStateDir(stateDir);
  return {
    root,
    stateDir,
    db:
      databaseUrl === undefined
        ? {
            name: 'db',
            mode: 'embedded',
            url: embeddedLocation('pglite', join(stateDir, 'pgdata')),
            detail: 'PGlite in this process — set DATABASE_URL to use a real Postgres',
          }
        : { name: 'db', mode: 'external', url: databaseUrl, detail: 'DATABASE_URL' },
    events: eventsBinding(env),
    storage:
      s3Endpoint === undefined
        ? {
            name: 'storage',
            mode: 'embedded',
            url: embeddedLocation('file', join(stateDir, 'storage')),
            detail: 'local directory — set S3_ENDPOINT to use S3',
          }
        : { name: 'storage', mode: 'external', url: s3Endpoint, detail: 'S3_ENDPOINT' },
  };
}

/**
 * The three service urls as a report may carry them, and the ONE place they become printable.
 * `x dev --json` emitted `DATABASE_URL` and `NATS_URL` verbatim — passwords included — into a
 * field that is printed to a terminal, piped into a log and scraped by a script, while the rule
 * against it was already written three lines from the emitting code and applied only to mail and
 * cdn. The bindings keep the real url because `runtime-queue.ts` has to connect with it; only this
 * projection is redacted, so a leak cannot come back as a caller forgetting to call a helper.
 */
export const reportedUrls = (services: DevServices): Record<ServiceBinding['name'], string> => ({
  db: safeUrlLabel(services.db.url, services.db.name),
  events: safeUrlLabel(services.events.url, services.events.name),
  storage: safeUrlLabel(services.storage.url, services.storage.name),
});

export const describeServices = (services: DevServices): string =>
  [services.db, services.events, services.storage]
    .map((binding) => `${binding.name}=${binding.mode}`)
    .join(' ');

/**
 * The bus the environment selects: `NATS_URL` set is NATS, unset is the in-process fanout — the
 * one rule `@ultimat3/realtime`'s `selectTransport` obeys (v31: the `realtime.transport`/`urlEnv`
 * config is gone; a bus of the app's own is `transport` in `apps/<app>/runtime.ts`).
 */
export function eventsBinding(env: Env): ServiceBinding {
  const url = nonEmpty(env['NATS_URL']);
  return url === undefined
    ? {
        name: 'events',
        mode: 'embedded',
        url: 'inproc://events',
        detail: 'in-process fanout — set NATS_URL to use NATS',
      }
    : { name: 'events', mode: 'external', url, detail: 'NATS_URL' };
}

/**
 * `services` with the events binding the booted runtime actually chose: a `runtime.ts` transport
 * is reported as the app's own, never as whatever `NATS_URL` happens to say.
 */
export const withRealtimeEvents = (
  services: DevServices,
  env: Env,
  supplied: boolean,
): DevServices => ({
  ...services,
  events: supplied
    ? {
        name: 'events',
        mode: 'external',
        url: 'runtime://transport',
        detail: 'runtime.ts transport',
      }
    : eventsBinding(env),
});

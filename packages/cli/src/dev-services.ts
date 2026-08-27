// Service resolution for `x dev`. No Docker, no env scavenger hunt: an unset variable means the
// embedded default, and the resolved set is printed at boot so there is never a question about
// which database a running process is talking to.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
   * The app directory itself, carried rather than re-derived from `stateDir`. A boot that needs to
   * read the app's own `app.config.ts` — `loadInboxRetention` does — otherwise has to undo the
   * `join(root, '.x')` above, and a `dirname` that silently disagrees with this file's join is a
   * path bug nothing would catch.
   */
  readonly root: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim().length === 0 ? undefined : value;

/**
 * Embedded Postgres is PGlite on disk under `.x/`, so a restart keeps the data and a `x db reset`
 * is a directory delete rather than a container dance.
 */
export function resolveServices(root: string, env: Env): DevServices {
  const stateDir = join(root, '.x');
  const databaseUrl = nonEmpty(env['DATABASE_URL']);
  const natsUrl = nonEmpty(env['NATS_URL']);
  const s3Endpoint = nonEmpty(env['S3_ENDPOINT']);
  // Created only when something will actually live in it. A container whose bindings are all
  // external runs non-root over a read-only app directory, and an unconditional mkdir there is an
  // EACCES at boot for a directory that would have stayed empty.
  if (databaseUrl === undefined || natsUrl === undefined || s3Endpoint === undefined) {
    mkdirSync(stateDir, { recursive: true });
  }
  return {
    root,
    stateDir,
    db:
      databaseUrl === undefined
        ? {
            name: 'db',
            mode: 'embedded',
            url: `pglite://${join(stateDir, 'pgdata')}`,
            detail: 'PGlite in this process — set DATABASE_URL to use a real Postgres',
          }
        : { name: 'db', mode: 'external', url: databaseUrl, detail: 'DATABASE_URL' },
    events:
      natsUrl === undefined
        ? {
            name: 'events',
            mode: 'embedded',
            url: 'inproc://events',
            detail: 'in-process fanout — set NATS_URL to use NATS',
          }
        : { name: 'events', mode: 'external', url: natsUrl, detail: 'NATS_URL' },
    storage:
      s3Endpoint === undefined
        ? {
            name: 'storage',
            mode: 'embedded',
            url: `file://${join(stateDir, 'storage')}`,
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
 * cdn. The bindings keep the real url because `dev-queue.ts` has to connect with it; only this
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

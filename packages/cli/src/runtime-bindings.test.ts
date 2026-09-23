// `x dev --json` is printed to a terminal, piped into a log and scraped by a script, and the three
// service bindings it reports come straight out of `DATABASE_URL`, `NATS_URL` and `S3_ENDPOINT` —
// every one of which is `scheme://user:password@host` in a real deployment. These cases are about
// the one thing that must never be in that report.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs'; // why: Bun has no mkdtemp, no recursive remove and no directory probe.
// why: `node:` by necessity: Bun has no temp-directory helper, and `resolveServices` creates `.x/`.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { eventsBinding, reportedUrls, resolveServices } from './runtime-bindings';
import { safeUrlLabel } from './safe-url-label';

const withRoot = <T>(body: (root: string) => T): T => {
  const root = mkdtempSync(join(tmpdir(), 'x-services-'));
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe('unit · dev services · what a report may carry', () => {
  test('an external binding is reported without its password', () => {
    withRoot((root) => {
      const services = resolveServices(
        root,
        {
          DATABASE_URL: 'postgres://app:hunter2@db.internal:5432/app',
          NATS_URL: 'nats://token:s3cr3t@nats.internal:4222',
          S3_ENDPOINT: 'https://AKIA:supersecret@s3.internal',
        },
        { enabled: true, transport: 'nats', urlEnv: 'NATS_URL' },
      );
      // The bindings keep the real url — `runtime-queue.ts` has to connect with it. Only the REPORT
      // is redacted, so a leak here cannot be fixed by a caller remembering to redact.
      expect(services.db.url).toContain('hunter2');

      const reported = reportedUrls(services);
      expect(reported).toEqual({
        db: 'postgres://db.internal:5432/app',
        events: 'nats://nats.internal:4222',
        storage: 'https://s3.internal/',
      });
      for (const value of Object.values(reported)) {
        expect(value).not.toContain('hunter2');
        expect(value).not.toContain('s3cr3t');
        expect(value).not.toContain('supersecret');
      }
    });
  });

  test('an embedded binding still reads as the path a developer needs', () => {
    withRoot((root) => {
      const reported = reportedUrls(resolveServices(root, {}));
      // Redaction that hid the PGlite directory would make the report useless for the case it is
      // printed in most: "which database is this process talking to?"
      expect(reported.db).toBe(`pglite://${join(root, '.x', 'pgdata')}`);
      expect(reported.events).toBe('inproc://events');
      expect(reported.storage).toBe(`file://${join(root, '.x', 'storage')}`);
    });
  });

  test('a value that is not a url is reported as the binding, never verbatim', () => {
    // A hand-written credential with no scheme is exactly the string that fails to parse, so the
    // fallback may not be an echo of it.
    expect(safeUrlLabel('app:hunter2@db.internal/app', 'db')).toBe('db');
    expect(safeUrlLabel('', 'events')).toBe('events');
  });

  test('a query string is dropped: sslmode rides beside password', () => {
    expect(safeUrlLabel('postgres://u:p@h:5432/app?password=leak&sslmode=require', 'db')).toBe(
      'postgres://h:5432/app',
    );
  });
});

// `loadInboxRetention` reads the app's own `app.config.ts`, so a boot needs the app ROOT and not
// only `.x/`. Carried rather than re-derived: a `dirname(stateDir)` that silently disagreed with
// `join(root, '.x')` above would be a path bug nothing catches.
test('the app root is carried, not left to be re-derived from stateDir', () => {
  const root = mkdtempSync(join(tmpdir(), 'x-dev-services-root-'));
  try {
    const services = resolveServices(root, {});
    expect(services.root).toBe(root);
    expect(services.stateDir).toBe(join(root, '.x'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A throwaway state directory is how an e2e run boots the app without touching the developer's
// `.x/pgdata`: the database, the disk and the dev lock all move with it.
test('ULTIMATE_STATE_DIR moves the embedded database, the disk and the lock together', () => {
  const root = mkdtempSync(join(tmpdir(), 'x-dev-services-root-'));
  const state = mkdtempSync(join(tmpdir(), 'x-dev-services-state-'));
  try {
    const services = resolveServices(root, { ULTIMATE_STATE_DIR: state });
    expect(services.stateDir).toBe(state);
    expect(services.db.url).toBe(`pglite://${join(state, 'pgdata')}`);
    expect(services.storage.url).toBe(`file://${join(state, 'storage')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

// A container with an external database and object store and no NATS runs non-root over a
// read-only app directory: in-process events keep nothing on disk, so `.x/` must not be created
// for them — the mkdir was an EACCES at boot over a directory that would have stayed empty.
test('in-process events alone create no state directory; an embedded database does', () => {
  withRoot((root) => {
    resolveServices(root, {
      DATABASE_URL: 'postgres://db:5432/app',
      S3_ENDPOINT: 'https://s3.example.test',
    });
    expect(existsSync(join(root, '.x'))).toBe(false);
    resolveServices(root, { S3_ENDPOINT: 'https://s3.example.test' });
    expect(existsSync(join(root, '.x'))).toBe(true);
  });
});

// The bus is `realtime.transport`'s and the variable is the one `realtime.urlEnv` names — the pair
// the runtime's `selectTransport` obeys. `NATS_URL` read literally reported `events=embedded` over
// an app that named its own variable and had dialled NATS.
test('the events binding reads the variable realtime.urlEnv names, only under transport nats', () => {
  const env = { BUS_URL: 'nats://bus.internal:4222', NATS_URL: 'nats://other:4222' };
  const nats = { enabled: true, transport: 'nats', urlEnv: 'BUS_URL' } as const;
  expect(eventsBinding(env, nats)).toMatchObject({
    mode: 'external',
    url: 'nats://bus.internal:4222',
  });
  expect(eventsBinding(env, { ...nats, transport: 'memory' }).mode).toBe('embedded');
});

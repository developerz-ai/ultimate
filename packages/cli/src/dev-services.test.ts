// `x dev --json` is printed to a terminal, piped into a log and scraped by a script, and the three
// service bindings it reports come straight out of `DATABASE_URL`, `NATS_URL` and `S3_ENDPOINT` —
// every one of which is `scheme://user:password@host` in a real deployment. These cases are about
// the one thing that must never be in that report.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
// `node:` by necessity: Bun has no temp-directory helper, and `resolveServices` creates `.x/`.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportedUrls, resolveServices } from './dev-services';
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
      const services = resolveServices(root, {
        DATABASE_URL: 'postgres://app:hunter2@db.internal:5432/app',
        NATS_URL: 'nats://token:s3cr3t@nats.internal:4222',
        S3_ENDPOINT: 'https://AKIA:supersecret@s3.internal',
      });
      // The bindings keep the real url — `dev-queue.ts` has to connect with it. Only the REPORT
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

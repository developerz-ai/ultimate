// Single responsibility: what `connectionUrl` puts in a refusal, and what it must never put
// there. A connection string carries `user:password@host`, so the value is the one thing this
// error may not echo — the shape of it is the diagnostic, exactly as `@ultimat3/core`'s
// `defineEnv` decided for the same variable.

import { describe, expect, test } from 'bun:test';
import { renderThrowable } from '@ultimat3/core';
import { connectionUrl } from './connection-url';
import { poolProfileFor } from './pool-profile';

const PROFILE = poolProfileFor('web');

const refusalFor = (url: string): string => {
  try {
    connectionUrl({ url }, PROFILE);
  } catch (error) {
    return renderThrowable(error);
  }
  return 'no-error-thrown';
};

describe('unit · connectionUrl', () => {
  test('a valid url keeps its host and gains the pool settings', () => {
    const built = connectionUrl({ url: 'postgres://app:pw@db.internal:5432/app' }, PROFILE);

    expect(built).toContain('db.internal');
    expect(built).toContain('application_name=ultimate');
  });

  /**
   * The leak: a mistyped port is the commonest malformed `DATABASE_URL` there is, and the whole
   * string was copied into the `cause` — which is the boot log line AND the `--json` payload,
   * where no key is left for the logger's redaction list to match on. Same finding, same
   * variable, as the one `packages/core/src/env.ts:216` already carries.
   */
  test('a malformed url is refused without its password reaching the cause', () => {
    const rendered = refusalFor('postgres://app:hunter2@db.internal:not-a-port/app');

    expect(rendered).toContain('X_DB_UNAVAILABLE');
    expect(rendered).toContain('DATABASE_URL');
    expect(rendered).not.toContain('hunter2');
    expect(rendered).not.toContain('app:');
    expect(rendered).not.toContain('db.internal');
  });

  /**
   * The shape is what is left once the value is gone, and it has to be enough to tell an empty
   * variable from a truncated one — the two typos a reader most needs told apart.
   */
  test('the refusal describes the value it rejected without printing it', () => {
    const rendered = refusalFor('postgres://app:hunter2@db.internal:not-a-port/app');

    expect(rendered).toContain('a string of 49 characters');
  });

  test('an unset url is still its own refusal, unchanged', () => {
    const rendered = refusalFor('');

    expect(rendered).toContain('X_DB_UNAVAILABLE');
    expect(rendered).toContain('DATABASE_URL is not set');
  });
});

/**
 * `new URL()` accepts a scheme-less connection string — `db.internal:5432/app` parses with
 * `db.internal:` as the SCHEME — so the value reached `Bun.SQL`, which read it as a Postgres url
 * anyway and failed at the first query with a driver error naming neither `DATABASE_URL` nor the
 * missing `postgres://`. Screening the scheme is what moves that refusal back to boot, where the
 * value is still nameable.
 */
describe('unit · connectionUrl scheme', () => {
  test('a scheme-less host:port is refused here, not by the driver at the first query', () => {
    const rendered = refusalFor('db.internal:5432/app');

    expect(rendered).toContain('X_DB_UNAVAILABLE');
    expect(rendered).toContain('DATABASE_URL');
    expect(rendered).toContain('postgres://');
  });

  /**
   * The scheme is safe to name only when the value HAS one, and this refusal exists for the value
   * that does not: `db.internal` is the host the author meant and the scheme `URL` parsed, one
   * token wearing both hats. So the received scheme is never echoed — the REQUIRED one carries the
   * whole instruction.
   */
  test('the refusal does not echo the token that parsed as the scheme', () => {
    const rendered = refusalFor('db.internal:5432/app');

    expect(rendered).not.toContain('db.internal');
    expect(rendered).toContain('a string of 20 characters');
  });

  /**
   * The same typo one dashboard field over — `user:password@host:port/db` copied whole — parses
   * with the USERNAME as its scheme (`new URL('app:hunter2@db.internal/app').protocol === 'app:'`).
   * A refusal that named the scheme would put a credential in the boot log and the `--json`
   * payload, which is the leak the comment block in `connection-url.ts` exists to prevent.
   */
  test('a scheme-less string carrying credentials leaks neither of them', () => {
    const rendered = refusalFor('app:hunter2@db.internal:5432/app');

    expect(rendered).toContain('X_DB_UNAVAILABLE');
    expect(rendered).not.toContain('hunter2');
    expect(rendered).not.toContain('app:');
  });

  /**
   * The dangerous direction is not the typo but the silent success: `Bun.SQL` opens a SQLite or a
   * MySQL connection on these, and every statement this package generates is Postgres.
   */
  test.each(['mysql://app:hunter2@db.internal:3306/app', 'sqlite://./dev.db', 'file:./dev.db'])(
    'a url naming another engine is refused: %s',
    (url) => {
      const rendered = refusalFor(url);

      expect(rendered).toContain('X_DB_UNAVAILABLE');
      expect(rendered).toContain('postgres://');
      expect(rendered).not.toContain('hunter2');
      expect(rendered).not.toContain('db.internal');
    },
  );

  test.each(['postgres://app@db.internal:5432/app', 'postgresql://app@db.internal:5432/app'])(
    'the two schemes the driver opens a Postgres connection on still pass: %s',
    (url) => {
      const built = connectionUrl({ url }, PROFILE);

      expect(built).toContain('db.internal');
      expect(built).toContain('application_name=ultimate');
    },
  );
});

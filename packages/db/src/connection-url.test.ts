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

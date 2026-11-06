// A read's own bound and the refusals of the freshness options. `timeoutMs` runs the source inside
// db's `withStatementTimeout` — proven by the statements a recording client sees around it — and a
// bound that is not a whole positive number, or either option on a download, fails where written.

import { afterEach, describe, expect, test } from 'bun:test';
import { ctxOf } from '@ultimat3/core';
import { recordingClient, setDbClient } from '@ultimat3/db';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { query } from './query';
import { assertDownloadFreshness } from './read-freshness';
import { from } from './source';

afterEach(() => setDbClient(undefined));

const bounded = (timeoutMs: number) =>
  query({
    input: t.object({}),
    policy: allow(),
    timeoutMs,
    sql: () => from<{ id: string }>('posts', [{ id: 'p1' }]),
  }).named('boundedFeed');

describe('query({ timeoutMs })', () => {
  test('the source runs inside a read-only transaction with its own statement_timeout', async () => {
    const pool = recordingClient().on(/pg_settings/, { rows: [{ ms: '10000' }] });
    setDbClient(pool);
    expect(await bounded(500)({}, { ctx: ctxOf({}) })).toEqual([{ id: 'p1' }]);
    expect(pool.texts[0]).toBe('BEGIN READ ONLY');
    expect(pool.statements.find((s) => s.text.includes('set_config'))?.values).toEqual([
      'statement_timeout',
      '500',
    ]);
    expect(pool.texts.at(-1)).toBe('COMMIT');
  });

  test('above the role bound: X_DB_STATEMENT_BOUND_INVALID, at the read', async () => {
    setDbClient(recordingClient().on(/pg_settings/, { rows: [{ ms: '1000' }] }));
    await expect(bounded(5_000)({}, { ctx: ctxOf({}) })).rejects.toMatchObject({
      code: 'X_DB_STATEMENT_BOUND_INVALID',
    });
  });

  test('not a whole positive number: X_QUERY_TIMEOUT_INVALID, at declaration', () => {
    for (const timeoutMs of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => bounded(timeoutMs)).toThrow('X_QUERY_TIMEOUT_INVALID');
    }
  });
});

describe('a download read', () => {
  test('refuses etag and timeoutMs: it has its own validators and no sql', () => {
    expect(() => assertDownloadFreshness({ etag: true })).toThrow('X_QUERY_ETAG_INVALID');
    expect(() => assertDownloadFreshness({ timeoutMs: 500 })).toThrow('X_QUERY_TIMEOUT_INVALID');
    expect(() => assertDownloadFreshness({})).not.toThrow();
  });
});

// Single responsibility: what `baseClient()` builds from the environment. The assertion that
// matters is the negative one — with no replica configured the process gets exactly the single-pool
// client it always had, because a homework app must not pay for a capacity tier it never asked for.

import { afterEach, describe, expect, test } from 'bun:test';
import { isReservable } from './client';
import { defaultClient, REPLICA_URL_ENV } from './default-client';

const original = process.env[REPLICA_URL_ENV];

afterEach(() => {
  if (original === undefined) delete process.env[REPLICA_URL_ENV];
  else process.env[REPLICA_URL_ENV] = original;
});

/** Only a replicated client keeps counters; a bare pool has none. */
const isReplicated = (client: object): boolean => 'stats' in client;

describe('defaultClient', () => {
  test('with no replica configured it is one pool, with no routing layer over it', () => {
    delete process.env[REPLICA_URL_ENV];
    const client = defaultClient();
    expect(isReplicated(client)).toBe(false);
    expect(isReservable(client)).toBe(true);
  });

  test('a blank value is not a replica — an unset variable and an empty one mean the same thing', () => {
    process.env[REPLICA_URL_ENV] = '   ';
    expect(isReplicated(defaultClient())).toBe(false);
  });

  test('a configured replica gets a routing client that can still pin the primary', () => {
    process.env[REPLICA_URL_ENV] = 'postgres://reader@replica.internal:5432/app';
    const client = defaultClient();
    expect(isReplicated(client)).toBe(true);
    // `withTransaction` reaches for `reserve()`, and a BEGIN that landed on a standby is not a
    // transaction — it is `25006` on the first write inside it.
    expect(isReservable(client)).toBe(true);
  });
});

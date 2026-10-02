// The typed read client against the route it derives, for the two values a search string cannot
// spell on its own: a `Date` and an EMPTY array. Each is something the client's types accept, so
// each has to arrive as the value the caller wrote.

import { describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import type { Actor } from '@ultimat3/policy';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { FetchLike } from './client';
import { toQueryRoute } from './http';
import type { AnyQuery } from './query';
import { query } from './query';
import { from } from './source';

interface Seen {
  readonly id: string;
  readonly since: string;
  readonly tags: readonly string[];
  readonly labels: readonly string[] | null;
  readonly kinds: readonly string[];
}

const reader: Actor = { ...userActor({ id: 'u1' }), permissions: ['feed:read'] };

const Input = t.object({
  since: t.date,
  tags: t.array(t.string),
  labels: t.array(t.string).optional(),
  kinds: t.array(t.string).default(['post']),
});

/** Answers the PARSED input back as its one row, so the test reads what the handler was handed. */
const echo = query({
  input: Input,
  policy: can('feed:read'),
  sql: ({ since, tags, labels, kinds }) =>
    from<Seen>('echo', [
      { id: 'a', since: since.toISOString(), tags, labels: labels ?? null, kinds },
    ]),
}).named('echo');

function clientFor(target: AnyQuery): FetchLike {
  const server = createServer({
    routes: [toQueryRoute(target)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => reader },
  });
  return (input, init) => server.fetch(new Request(input, init));
}

const SINCE = new Date('2026-03-04T05:06:07.089Z');

describe('the typed client and the route agree on what a value is', () => {
  test('a Date arrives as the instant the caller passed', async () => {
    const call = echo.client({ baseUrl: 'http://dev.test', fetch: clientFor(echo) });
    const [row] = await call({ since: SINCE, tags: ['x'] });
    expect(row?.since).toBe('2026-03-04T05:06:07.089Z');
  });

  test('an empty REQUIRED array arrives as an empty array', async () => {
    const call = echo.client({ baseUrl: 'http://dev.test', fetch: clientFor(echo) });
    const [row] = await call({ since: SINCE, tags: [] });
    expect(row?.tags).toEqual([]);
  });

  test('a one-item and a many-item array arrive as written', async () => {
    const call = echo.client({ baseUrl: 'http://dev.test', fetch: clientFor(echo) });
    expect((await call({ since: SINCE, tags: ['x'] }))[0]?.tags).toEqual(['x']);
    expect((await call({ since: SINCE, tags: ['x', 'y'] }))[0]?.tags).toEqual(['x', 'y']);
  });

  test('an absent OPTIONAL array stays absent, and an absent DEFAULTED one takes its default', async () => {
    // Absence already has a meaning for these two, and it is the schema's: reading `[]` here
    // would overwrite a declared default with a value nobody sent.
    const call = echo.client({ baseUrl: 'http://dev.test', fetch: clientFor(echo) });
    const [row] = await call({ since: SINCE, tags: [] });
    expect(row?.labels).toBeNull();
    expect(row?.kinds).toEqual(['post']);
  });
});

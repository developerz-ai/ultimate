// #1281's main half, for a read: `?limt=1` is still ignored and the page is the same bytes, but the
// parse now says so — a coded `log.record` warning naming `limit`, and an event on the active span.
// The route's own page controls (`_first`, `_after`) never reach the parse, so they never warn.

import { afterEach, describe, expect, test } from 'bun:test';
import type { InstrumentEventMap, ReadableSpan } from '@ultimat3/core';
import { resetInstrumentation, subscribe, userActor } from '@ultimat3/core';
import type { HttpConfig } from '@ultimat3/http';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { toQueryRoute } from './http';
import { parsedQueryInput } from './parsed-input';
import { query } from './query';
import { from } from './source';
import {
  INPUT_UNKNOWN_KEY,
  MAX_REPORTS,
  reportUnknownInputKeys,
  resetUnknownKeyReports,
} from './validate-unknown-keys';

afterEach(() => {
  resetInstrumentation();
  resetUnknownKeyReports();
});

type LogRecordEvent = InstrumentEventMap['log.record'];

const heard = (): LogRecordEvent[] => {
  const seen: LogRecordEvent[] = [];
  subscribe('log.record', ({ payload }) => {
    if (payload.message === INPUT_UNKNOWN_KEY) seen.push(payload);
  });
  return seen;
};

interface Ticket {
  readonly id: string;
  readonly rank: number;
}

const tickets: readonly Ticket[] = [
  { id: 'a', rank: 1 },
  { id: 'b', rank: 2 },
  { id: 'c', rank: 3 },
];

const ticketPage = query({
  input: t.object({ limit: t.number.optional() }),
  policy: allow(),
  sql: ({ limit }) =>
    from<Ticket>('tickets', tickets)
      .orderBy('rank')
      .limit(limit ?? 50),
}).named('ticketPage');

const oneProcess = (): HttpConfig => defineHttpConfig({ rateLimit: { scope: 'process' } });
const route = toQueryRoute(ticketPage);

const read = (search: string): Promise<Response> =>
  httpServer({
    routes: [route],
    config: oneProcess(),
    hooks: { authenticate: () => userActor({ id: 'u1' }) },
  }).fetch(new Request(`http://dev.test${route.path}${search}`));

describe('a query input carrying an undeclared key', () => {
  test('over HTTP: 200, the same bytes as without it, and one warning naming `limit`', async () => {
    const seen = heard();
    const clean = await read('?limit=1');
    expect(seen).toHaveLength(0);
    const typo = await read('?limit=1&limt=1&offset=5');

    expect(typo.status).toBe(200);
    expect(await typo.text()).toBe(await clean.text());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.level).toBe('warn');
    expect(seen[0]?.fields).toMatchObject({
      code: 'X_INPUT_UNKNOWN_KEY',
      query: 'ticketPage',
      keys: [{ path: 'limt', nearest: 'limit' }, { path: 'offset' }],
    });
    expect(String(seen[0]?.fields['fix'])).toContain('x queries show ticketPage --json');
  });

  test("the route's page controls are the route's, and never warn", async () => {
    const seen = heard();
    const paged = await read('?_first=2');
    expect(paged.status).toBe(200);
    expect(seen).toHaveLength(0);
  });

  test('the same typo is logged once per process; the span hears every call', async () => {
    const seen = heard();
    const ended: ReadableSpan[] = [];
    subscribe('span.end', ({ payload }) => {
      ended.push(payload);
    });
    await read('?limt=1');
    await read('?limt=1');
    expect(seen).toHaveLength(1);
    const events = ended.flatMap((span) =>
      span.events.filter((event) => event.name === INPUT_UNKNOWN_KEY),
    );
    expect(events).toHaveLength(2);
    expect(events[0]?.attributes).toMatchObject({ code: 'X_INPUT_UNKNOWN_KEY', keys: ['limt'] });
  });

  test('a live window keying its input says nothing: only the read itself warns', async () => {
    const seen = heard();
    expect(await parsedQueryInput(ticketPage, { limit: 1, limt: 1 })).toEqual({ limit: 1 });
    expect(seen).toHaveLength(0);
  });

  // The key is the caller's: a 1 MiB body can carry one 1M-char key, and asking for its nearest
  // declared name cost ~300 MB and most of a second of sync CPU on every request, dedupe or not.
  test('a million-character key is still reported, bounded, and costs no suggestion', () => {
    const seen = heard();
    const huge = 'l'.repeat(1_000_000);
    const started = performance.now();
    reportUnknownInputKeys(t.object({ limit: t.number }), { limit: 1, [huge]: 1 }, 'probe');
    expect(performance.now() - started).toBeLessThan(50);
    expect(seen).toHaveLength(1);
    const keys = seen[0]?.fields['keys'] as readonly { path: string; nearest?: string }[];
    expect(keys[0]?.nearest).toBeUndefined();
    expect(keys[0]?.path.length).toBeLessThanOrEqual(129);
  });

  test('past MAX_REPORTS distinct reports the oldest is forgotten, never the newest refused', () => {
    const seen = heard();
    const schema = t.object({ limit: t.number });
    for (let i = 0; i <= MAX_REPORTS; i += 1)
      reportUnknownInputKeys(schema, { [`k${i}`]: 1 }, 'probe');
    expect(seen).toHaveLength(MAX_REPORTS + 1);
    // `k0` was evicted to make room, so it is said again; `k${MAX_REPORTS}` is still remembered.
    reportUnknownInputKeys(schema, { k0: 1 }, 'probe');
    reportUnknownInputKeys(schema, { [`k${MAX_REPORTS}`]: 1 }, 'probe');
    expect(seen).toHaveLength(MAX_REPORTS + 2);
  });
});

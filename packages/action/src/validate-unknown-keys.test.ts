// #1281's main half, for an action: a key the input schema does not declare is still dropped and
// the answer is unchanged, but the parse now SAYS so — a coded `log.record` warning naming the
// nearest declared key, and an event on the active span for the dev timeline.

import { afterEach, describe, expect, test } from 'bun:test';
import type { InstrumentEventMap, ReadableSpan } from '@ultimat3/core';
import { ctxOf, resetInstrumentation, subscribe, userActor } from '@ultimat3/core';
import type { HttpConfig } from '@ultimat3/http';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { toRoute } from './http';
import { invoke } from './invoke';
import { INPUT_UNKNOWN_KEY, resetUnknownKeyReports } from './validate-unknown-keys';

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

const listTickets = action({
  input: t.object({ limit: t.number, filter: t.object({ status: t.string }).optional() }),
  output: t.object({ limit: t.number }),
  policy: allow(),
  handle: ({ input }) => ({ limit: input.limit }),
}).named('listTickets');

const oneProcess = (): HttpConfig => defineHttpConfig({ rateLimit: { scope: 'process' } });

const route = toRoute(listTickets);
const ctx = ctxOf({ actor: userActor({ id: 'u1' }) });

const post = (body: unknown): Promise<Response> =>
  httpServer({
    routes: [route],
    config: oneProcess(),
    hooks: { authenticate: () => userActor({ id: 'u1' }) },
  }).fetch(
    new Request(`http://dev.test${route.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://dev.test' },
      body: JSON.stringify(body),
    }),
  );

describe('an action input carrying an undeclared key', () => {
  test('over HTTP: 200, the same bytes as without it, and one warning naming `limit`', async () => {
    const seen = heard();
    const clean = await post({ limit: 1 });
    expect(seen).toHaveLength(0);
    const typo = await post({ limit: 1, limt: 5 });

    expect(typo.status).toBe(200);
    expect(clean.status).toBe(200);
    expect(await typo.text()).toBe(await clean.text());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.level).toBe('warn');
    expect(seen[0]?.fields).toMatchObject({
      code: 'X_INPUT_UNKNOWN_KEY',
      action: 'listTickets',
      keys: [{ path: 'limt', nearest: 'limit' }],
    });
    expect(String(seen[0]?.fields['fix'])).toContain('x actions show listTickets --json');
    expect(String(seen[0]?.fields['cause'])).toContain('"limt"');
  });

  test('a nested key is named by its path, and a key with no near name carries none', async () => {
    const seen = heard();
    await invoke(
      listTickets,
      { limit: 1, filter: { status: 'open', stauts: 'x' }, zzzzzz: 1 },
      { ctx },
    );
    expect(seen[0]?.fields['keys']).toEqual([
      { path: 'filter.stauts', nearest: 'status' },
      { path: 'zzzzzz' },
    ]);
  });

  test('the same typo on the same action is logged once per process, not once per call', async () => {
    const seen = heard();
    await invoke(listTickets, { limit: 1, limt: 5 }, { ctx });
    await invoke(listTickets, { limit: 1, limt: 5 }, { ctx });
    expect(seen).toHaveLength(1);
    await invoke(listTickets, { limit: 1, lmit: 5 }, { ctx });
    expect(seen).toHaveLength(2);
  });

  test('one call through the MCP surface warns once — the parse is the one place it is said', async () => {
    const seen = heard();
    await invoke(listTickets, { limit: 1, limt: 5 }, { ctx, surface: 'mcp' });
    expect(seen).toHaveLength(1);
  });

  test('every call puts the event on the active span, for the dev timeline', async () => {
    const ended: ReadableSpan[] = [];
    subscribe('span.end', ({ payload }) => {
      ended.push(payload);
    });
    await invoke(listTickets, { limit: 1, limt: 5 }, { ctx });
    await invoke(listTickets, { limit: 1, limt: 5 }, { ctx });
    const events = ended.flatMap((span) =>
      span.events.filter((event) => event.name === INPUT_UNKNOWN_KEY),
    );
    expect(events).toHaveLength(2);
    expect(events[0]?.attributes).toMatchObject({
      code: 'X_INPUT_UNKNOWN_KEY',
      keys: ['limt'],
    });
  });

  test('a clean input says nothing', async () => {
    const seen = heard();
    await invoke(listTickets, { limit: 1, filter: { status: 'open' } }, { ctx });
    expect(seen).toHaveLength(0);
  });
});

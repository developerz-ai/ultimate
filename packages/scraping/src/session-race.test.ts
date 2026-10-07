// Two runs on ONE session key. The store has no compare-and-set, so a burn or a refusal is a
// blind write over whatever the other run persisted since: run A restores a session, run B logs in
// and saves a fresh one, A is blocked and burns B's. Each write now first compares the record's
// `savedAt` with the one this run last saw or wrote, and stands down when another run moved it.
// And a login that succeeded is not undone by a failure to SAVE it.

import { describe, expect, test } from 'bun:test';
import { ctxOf, structuredLogger } from '@ultimat3/core';
import type { JobRunArgs, StepApi } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import type { AuthPlanInput } from './auth';
import { burnSession, ensureAuthenticated, markRefused } from './auth';
import { testScrapeClock } from './clock';
import { fakeBrowser, fakePage } from './driver-fake';
import { authFailed, blocked } from './error-throws';
import type { ScrapeDefinition } from './scrape';
import { runScrape } from './scrape-run';
import { secretBag } from './secrets';
import type { ScrapeSessionStore, SessionState } from './session-state';
import { memorySessionStore } from './session-state';

const KEY = 'org-1/bank/default';
const T0 = '2026-08-18T00:00:00.000Z';
const T1 = '2026-08-18T00:05:00.000Z';
const URL_A = 'https://shop.test/orders';

const state = (savedAt: string, over: Partial<SessionState> = {}): SessionState => ({
  key: KEY,
  savedAt,
  cookies: [],
  headers: {},
  storage: {},
  userAgent: 'agent',
  origin: 'https://bank.test',
  ...over,
});

const linesOf = () => {
  const lines: Record<string, unknown>[] = [];
  const logger = structuredLogger({
    writer: (line) => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  return { lines, logger };
};

const planOver = (
  store: ScrapeSessionStore,
  logger = linesOf().logger,
): AuthPlanInput<unknown> => ({
  scrape: 'bank',
  auth: { store, login: () => Promise.resolve() },
  key: KEY,
  clock: testScrapeClock(new Date(T1)),
  logger,
});

describe('unit · burn and refuse stand down when another run moved the record', () => {
  test('burnSession keeps a session another run saved after this one read it', async () => {
    const store = memorySessionStore({ [KEY]: state(T1) });
    const { lines, logger } = linesOf();
    await burnSession(planOver(store, logger), T0);
    expect((await store.load(KEY))?.savedAt).toBe(T1);
    expect(lines.some((line) => line['msg'] === 'scrape.session.superseded')).toBe(true);
  });

  test('burnSession burns the session this run read', async () => {
    const store = memorySessionStore({ [KEY]: state(T0) });
    await burnSession(planOver(store), T0);
    expect(await store.load(KEY)).toBeUndefined();
  });

  test('markRefused writes no tombstone over a session saved after this run read', async () => {
    const store = memorySessionStore({ [KEY]: state(T1) });
    await markRefused(planOver(store), T0);
    expect((await store.load(KEY))?.refusedAt).toBeUndefined();
  });

  test('markRefused tombstones the record this run read, and an empty key', async () => {
    const read = memorySessionStore({ [KEY]: state(T0) });
    await markRefused(planOver(read), T0);
    expect((await read.load(KEY))?.refusedAt).toBeDefined();
    const empty = memorySessionStore();
    await markRefused(planOver(empty), undefined);
    expect((await empty.load(KEY))?.refusedAt).toBeDefined();
  });

  test('an expired restore does not burn a session another run replaced it with', async () => {
    const store = memorySessionStore({ [KEY]: state(T1) });
    const page = fakePage('<p>login</p>');
    await ensureAuthenticated({
      ...planOver(store),
      auth: { store, login: () => Promise.resolve(), validate: () => Promise.resolve(false) },
      input: {},
      runId: 'run-1',
      page,
      secrets: secretBag([]),
      restored: state(T0),
      prompt: () => Promise.resolve(''),
    });
    expect((await store.load(KEY))?.savedAt).toBe(T1);
  });
});

const runArgs = (
  logger = structuredLogger({ writer: () => undefined }),
): JobRunArgs<Record<string, never>> => ({
  input: {},
  step: {
    run: <T>(_name: string, fn: () => Promise<T> | T) => Promise.resolve(fn()),
  } as unknown as StepApi,
  ctx: ctxOf({ logger }),
  attempt: 1,
  finalAttempt: false,
  progress: () => undefined,
  jobId: 'job-1',
  runId: 'run-1',
});

const define = (
  over: Partial<ScrapeDefinition<Record<string, never>, { id: string }>>,
): ScrapeDefinition<Record<string, never>, { id: string }> => ({
  name: 'orders',
  input: t.object({}),
  extract: t.object({ id: t.string }),
  idempotencyKey: () => 'orders',
  tenant: 'none',
  allowHosts: ['shop.test'],
  robots: { ignore: 'fixture host' },
  clock: testScrapeClock(new Date(T1)),
  driver: fakeBrowser([{ url: URL_A, html: '<p class="row" data-id="1">One</p>' }]),
  run: () => Promise.resolve([{ id: '1' }]),
  ...over,
});

/** The one stored record, whatever key the run computed for it. */
const onlyRecord = async (store: ScrapeSessionStore, keys: readonly string[]) =>
  keys.length === 0 ? undefined : store.load(keys[0] ?? '');

/** A memory store that writes down every key saved, so a test can read back what a run wrote. */
const keyed = () => {
  const inner = memorySessionStore();
  const keys: string[] = [];
  const store: ScrapeSessionStore = {
    load: (key) => inner.load(key),
    save: (saved) => {
      if (!keys.includes(saved.key)) keys.push(saved.key);
      return inner.save(saved);
    },
    burn: (key) => inner.burn(key),
  };
  return { store, keys };
};

describe('unit · a run burns or refuses only the session it saw', () => {
  test('a block after another run saved a newer session leaves that session in place', async () => {
    const { store, keys } = keyed();
    const code = await runScrape(
      define({
        auth: { store, login: () => Promise.resolve() },
        run: async () => {
          // The other run, finishing its own login while this body is still working.
          const key = keys[0] ?? '';
          await store.save(state('2026-08-18T00:09:00.000Z', { key }));
          throw blocked('orders', URL_A, 'captcha wall');
        },
      }),
      runArgs(),
    ).catch((thrown: unknown) => (thrown as { code?: string }).code);
    expect(code).toBe('X_SCRAPE_BLOCKED');
    expect((await onlyRecord(store, keys))?.savedAt).toBe('2026-08-18T00:09:00.000Z');
  });

  test('a block on the session this run itself saved burns it', async () => {
    const { store, keys } = keyed();
    await runScrape(
      define({
        auth: { store, login: () => Promise.resolve() },
        run: () => Promise.reject(blocked('orders', URL_A, 'captcha wall')),
      }),
      runArgs(),
    ).catch(() => undefined);
    expect(keys).toHaveLength(1);
    expect(await onlyRecord(store, keys)).toBeUndefined();
  });

  test('a refused login with nothing stored is still tombstoned', async () => {
    const { store } = keyed();
    const saved: SessionState[] = [];
    const watching: ScrapeSessionStore = {
      ...store,
      save: (record) => {
        saved.push(record);
        return store.save(record);
      },
    };
    await runScrape(
      define({
        auth: {
          store: watching,
          login: () => Promise.reject(authFailed('orders', 'the password was rejected')),
        },
      }),
      runArgs(),
    ).catch(() => undefined);
    expect(saved.map((record) => record.refusedAt !== undefined)).toEqual([true]);
  });
});

describe('unit · ownership is a unique version, and a record seen but not reused still counts', () => {
  test('a same-millisecond replacement by another run is not burned — savedAt alone cannot tell them apart', async () => {
    const { store, keys } = keyed();
    const code = await runScrape(
      define({
        auth: { store, login: () => Promise.resolve() },
        run: async () => {
          // The other run, on the SAME frozen clock: an identical savedAt, a different record.
          const key = keys[0] ?? '';
          const mine = await store.load(key);
          await store.save({ ...state(mine?.savedAt ?? T1, { key }), userAgent: 'the-other-run' });
          throw blocked('orders', URL_A, 'captcha wall');
        },
      }),
      runArgs(),
    ).catch((thrown: unknown) => (thrown as { code?: string }).code);
    expect(code).toBe('X_SCRAPE_BLOCKED');
    expect((await onlyRecord(store, keys))?.userAgent).toBe('the-other-run');
  });

  for (const [name, auth] of [
    ['reuse: false', { reuse: false }],
    ['a record past maxAge', { maxAge: 1 }],
  ] as const) {
    test(`${name}: a refused fresh login still tombstones the record the run found`, async () => {
      const inner = memorySessionStore();
      const keys: string[] = [];
      const store: ScrapeSessionStore = {
        load: async (key) => {
          if (!keys.includes(key)) keys.push(key);
          return (await inner.load(key)) ?? state(T0, { key });
        },
        save: (saved) => inner.save(saved),
        burn: (key) => inner.burn(key),
      };
      await runScrape(
        define({
          auth: {
            store,
            ...auth,
            login: () => Promise.reject(authFailed('orders', 'the password was rejected')),
          },
        }),
        runArgs(),
      ).catch(() => undefined);
      expect((await inner.load(keys[0] ?? ''))?.refusedAt).toBeDefined();
    });
  }
});

describe('unit · a login that succeeded survives a store that cannot keep it', () => {
  test('a rejected save after a login does not fail the run, and is logged', async () => {
    const { lines, logger } = linesOf();
    const store: ScrapeSessionStore = {
      load: () => Promise.resolve(undefined),
      save: () => Promise.reject(new Error('s3: 503 slow down')),
      burn: () => Promise.resolve(),
    };
    const report = await runScrape(
      define({ auth: { store, login: () => Promise.resolve() } }),
      runArgs(logger),
    );
    expect(report.rows).toEqual([{ id: '1' }]);
    const failed = lines.find((line) => line['msg'] === 'scrape.session.write_failed');
    expect(failed?.['step']).toBe('session.save');
  });
});

// `scrape()` is a JOB FACTORY. These tests assert that literally: the value it returns is a
// `JobHandle`, so it inherits `.enqueue()`, the worker's cancellation and the dead-letter path,
// and nothing here is a ninth primitive.

import { afterEach, describe, expect, test } from 'bun:test';
import { createContext, createLogger, secret } from '@ultimat3/core';
import type { JobRunArgs, StepApi } from '@ultimat3/jobs';
import { isJobHandle, resetJobs } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { testClock } from './clock';
import { fakeBrowser } from './driver-fake';
import { authFailed } from './error-throws';
import { memoryYieldHistory } from './expect';
import type { ScrapeDefinition, ScrapeReport } from './scrape';
import { scrape } from './scrape';
import { memorySessionStore } from './session-state';

afterEach(() => {
  // `job()` refuses a duplicate name, and every test here declares the same one.
  resetJobs();
});

const URL_A = 'https://shop.test/orders';
const HTML = `<html><body>
  <ul><li class="row" data-id="1">One</li><li class="row" data-id="2">Two</li></ul>
  <input id="password" type="password">
</body></html>`;
const API = 'https://shop.test/api/orders?page=2';

const row = t.object({ id: t.string });

/** A `step` that runs everything once — the worker's own is what replays; this is not under test. */
const passThroughStep = (): StepApi =>
  ({
    run: <T>(_name: string, fn: () => Promise<T> | T) => Promise.resolve(fn()),
  }) as unknown as StepApi;

const runArgs = <I>(input: I): JobRunArgs<I> => ({
  input,
  step: passThroughStep(),
  ctx: createContext({ logger: createLogger({ writer: () => undefined }) }),
  attempt: 1,
  jobId: 'job-1',
  runId: 'run-1',
});

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

const define = (
  over: Partial<ScrapeDefinition<{ page: number }, { id: string }>> = {},
): ScrapeDefinition<{ page: number }, { id: string }> => ({
  name: 'orders',
  input: t.object({ page: t.number }),
  extract: row,
  idempotencyKey: (input) => `orders:${String(input.page)}`,
  tenant: 'none',
  allowHosts: ['shop.test'],
  clock: testClock(),
  driver: fakeBrowser([{ url: URL_A, html: HTML }], {
    http: [{ url: API, method: 'GET', status: 200, body: '{"rows":[{"id":"3"}]}' }],
  }),
  async run({ page }) {
    await page.goto(URL_A);
    return (await page.values('.row')).map((element) => ({ id: element.attrs['data-id'] }));
  },
  ...over,
});

describe('unit · scrape() returns a job, not a ninth primitive', () => {
  test('the value it returns IS a JobHandle', () => {
    const handle = scrape(define());
    expect(isJobHandle(handle)).toBe(true);
    expect(handle.kind).toBe('job');
    expect(handle.name).toBe('orders');
    expect(handle.idempotencyKeyFor({ page: 2 })).toBe('orders:2');
  });

  test('an empty allowHosts is refused where it is written', () => {
    expect(() => scrape(define({ allowHosts: [] }))).toThrow(/allowHosts/);
  });

  test('a rate of zero is refused — there is no unpaced mode', () => {
    expect(() => scrape(define({ rate: 0 }))).toThrow(/rate/);
  });
});

describe('unit · one attempt, end to end, with no browser', () => {
  test('rows come back parsed by the extract schema', async () => {
    const handle = scrape(define());
    const report = (await handle.run(runArgs({ page: 1 }))) as ScrapeReport<{ id: string }>;
    expect(report.rows).toEqual([{ id: '1' }, { id: '2' }]);
  });

  test('a row the schema rejects is X_SCRAPE_OUTPUT_INVALID, never a stored partial', async () => {
    const handle = scrape(
      define({
        run: async ({ page }) => {
          await page.goto(URL_A);
          return [{ id: 12 }];
        },
      }),
    );
    expect(await codeOf(handle.run(runArgs({ page: 1 })))).toBe('X_SCRAPE_OUTPUT_INVALID');
  });

  test('a collapsed yield refuses the run — the silent-green alarm, wired', async () => {
    const handle = scrape(
      define({
        expect: { minRows: 5 },
        history: memoryYieldHistory(),
      }),
    );
    expect(await codeOf(handle.run(runArgs({ page: 1 })))).toBe('X_SCRAPE_YIELD_COLLAPSED');
  });

  test('the hybrid leg runs off the same declaration: browser walk, then the JSON endpoint', async () => {
    const handle = scrape(
      define({
        async run({ page, http }) {
          await page.goto(URL_A);
          const parsed = await (await http.request(API)).parse(t.object({ rows: t.array(row) }));
          return parsed.rows;
        },
      }),
    );
    const report = (await handle.run(runArgs({ page: 2 }))) as ScrapeReport<{ id: string }>;
    expect(report.rows).toEqual([{ id: '3' }]);
  });

  test('a host outside allowHosts is refused inside the run', async () => {
    const handle = scrape(
      define({
        run: async ({ page }) => {
          await page.goto('https://evil.test/');
          return [];
        },
      }),
    );
    expect(await codeOf(handle.run(runArgs({ page: 1 })))).toBe('X_SCRAPE_HOST_BLOCKED');
  });
});

describe('unit · the login path', () => {
  test('a run with no stored session logs in, and the session is persisted', async () => {
    const store = memorySessionStore();
    let logins = 0;
    const handle = scrape(
      define({
        secrets: ['SHOP_PASSWORD'],
        auth: {
          store,
          // A DISCRIMINATOR, not the key: the tenant and the scrape name are the framework's to
          // put in front of it (`sessionKeyFor`), so two tenants naming one account never share
          // an authenticated session.
          key: () => 'account-a',
          login: async ({ page }) => {
            logins += 1;
            await page.goto(URL_A);
            await page.type('#password', secret('hunter2', 'SHOP_PASSWORD'));
          },
        },
        run: async ({ page }) => {
          await page.goto(URL_A);
          return (await page.values('.row')).map((element) => ({ id: element.attrs['data-id'] }));
        },
      }),
    );
    process.env['SHOP_PASSWORD'] = 'hunter2';
    const report = (await handle.run(runArgs({ page: 1 }))) as ScrapeReport<{ id: string }>;
    expect(logins).toBe(1);
    expect(report.rows).toHaveLength(2);
    expect(await store.load('no-tenant/orders/account-a')).toBeDefined();
    delete process.env['SHOP_PASSWORD'];
  });

  test('a refused credential is recorded, and the next run never reaches the site', async () => {
    const store = memorySessionStore();
    let logins = 0;
    const definition = define({
      auth: {
        store,
        key: () => 'account-a',
        login: () => {
          logins += 1;
          // What a body throws when the site says "wrong password".
          throw authFailed('orders', 'the site rejected the credential');
        },
      },
    });
    expect(await codeOf(scrape(definition).run(runArgs({ page: 1 })))).toBe('X_SCRAPE_AUTH_FAILED');
    resetJobs();
    // Attempt two: refused BEFORE the browser opens, so `login` is never called a second time.
    expect(await codeOf(scrape(definition).run(runArgs({ page: 1 })))).toBe('X_SCRAPE_AUTH_FAILED');
    expect(logins).toBe(1);
  });
});

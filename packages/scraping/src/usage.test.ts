// What a run reports having USED, counted on the driver every app tests with. The first case is
// also the whole session surface in one declaration — an exit per run, one run per connection,
// a sealed stored session, a prompt answered over the event bus — run on the fixture driver.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove; the fixture driver reads a directory.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
import { ctxOf, seal, structuredLogger } from '@ultimat3/core';
import type { EventBus, JobRunArgs, StepApi } from '@ultimat3/jobs';
import { memoryEventBus, resetJobs } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { memoryStorageDriver } from '@ultimat3/storage';
import { fakeCdpLauncher } from './cdp-fake-fixture';
import type { TestScrapeClock } from './clock';
import { testScrapeClock } from './clock';
import { remoteBrowser } from './driver-cdp';
import { fakeBrowser } from './driver-fake';
import { fixtureBrowser, recordingFilename } from './driver-recorded';
import { eventPrompt, promptEventName } from './event-prompt';
import { httpOverFetch } from './http';
import { httpRecordingFilename } from './http-recorded';
import { boundedRing } from './rings';
import type { ScrapeDefinition, ScrapeReport } from './scrape';
import { scrape } from './scrape';
import { runScrape } from './scrape-run';
import { EMPTY_SESSION, storageSessionStore } from './session-state';
import { usageMeter } from './usage';

const KEYS = { env: { ULTIMATE_SECRETS_KEY: 'd4'.repeat(32) }, root: '/nonexistent-app-root' };

const LOGIN = 'https://bank.test/login';
const ACCOUNTS = 'https://bank.test/accounts';
const API = 'https://bank.test/api/accounts?page=1';
const API_BODY = '{"rows":[{"id":"acct-1"},{"id":"acct-2"}]}';

const PAGES = [
  { url: LOGIN, html: '<form><input id="user"><input id="otp"><button id="go">Go</button></form>' },
  { url: ACCOUNTS, html: '<ul><li class="row" data-id="acct-1">One</li></ul>' },
];
const HTTP = [{ url: API, method: 'GET', status: 200, body: API_BODY }];

let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(`${tmpdir()}/ultimate-scrape-usage-`);
  for (const page of PAGES) {
    await writeFile(`${dir}/${recordingFilename(page.url)}`, JSON.stringify(page));
  }
  for (const recording of HTTP) {
    await writeFile(
      `${dir}/${httpRecordingFilename(recording.method, recording.url)}`,
      JSON.stringify(recording),
    );
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  resetJobs();
});

interface Input {
  readonly connectionId: string;
  readonly exit: string;
}

const runArgs = (input: Input, lines: Record<string, unknown>[] = []): JobRunArgs<Input> => ({
  input,
  step: {
    run: <T>(_name: string, fn: () => Promise<T> | T) => Promise.resolve(fn()),
  } as unknown as StepApi,
  ctx: ctxOf({
    logger: structuredLogger({
      level: 'debug',
      writer: (line) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    }),
  }),
  attempt: 1,
  finalAttempt: false,
  progress: () => undefined,
  jobId: 'job-1',
  runId: 'run-1',
});

/** A bus on which run-1's first prompt is answered at the second look — by "another process". */
const answeringBus = async (clock: TestScrapeClock, answer: string): Promise<EventBus> => {
  const memory = memoryEventBus({ clock });
  const sealed = await seal(answer, { purpose: promptEventName('run-1', 1), ...KEYS });
  let looks = 0;
  return {
    ...memory,
    find: async (name, correlationKey, afterMs) => {
      looks += 1;
      if (looks === 2) await memory.publish(name, sealed);
      return memory.find(name, correlationKey, afterMs);
    },
  };
};

describe('unit · one declaration: exit, one run per connection, sealed session, bus prompt, usage', () => {
  test('it runs on the fixture driver and the report says what it used', async () => {
    const clock = testScrapeClock(new Date('2026-10-01T00:00:00.000Z'));
    const storage = memoryStorageDriver();
    const definition: ScrapeDefinition<Input, { id: string }> = {
      name: 'bank.accounts',
      input: t.object({ connectionId: t.string, exit: t.string }),
      extract: t.object({ id: t.string }),
      idempotencyKey: ({ connectionId }) => `accounts:${connectionId}`,
      tenant: 'none',
      allowHosts: ['bank.test'],
      robots: { ignore: 'a recorded site: there is no origin to ask' },
      clock,
      driver: fixtureBrowser(dir),
      egress: ({ exit }) => exit,
      concurrency: { key: ({ connectionId }) => connectionId, limit: 1, whenBusy: 'fail' },
      auth: {
        store: storageSessionStore(() => storage, { keySource: KEYS }),
        key: ({ connectionId }) => connectionId,
        login: async ({ page, prompt }) => {
          await page.goto(LOGIN);
          await page.fill('#user', 'ops@example.com');
          await page.fill('#otp', await prompt('sms code'));
        },
      },
      prompt: eventPrompt({
        timeout: 300_000,
        bus: await answeringBus(clock, '482913'),
        keySource: KEYS,
      }),
      async run({ page, http }) {
        await page.goto(ACCOUNTS);
        const batch = await (await http.request(API)).parse(
          t.object({ rows: t.array(t.object({ id: t.string })) }),
        );
        return batch.rows;
      },
    };
    // The declaration is a `job`: accepted by `scrape()` with the keyed cap passed through.
    const handle = scrape(definition);
    expect(handle.concurrency).toBe(1);
    expect(handle.whenBusy).toBe('fail');

    const report = (await runScrape(
      definition,
      runArgs({ connectionId: 'conn-7', exit: 'http://exit-7.test:8080' }),
    )) as ScrapeReport<{ id: string }>;

    expect(report.rows).toEqual([{ id: 'acct-1' }, { id: 'acct-2' }]);
    expect(report.usage).toEqual({
      browserMs: report.usage.browserMs,
      navigations: 2,
      httpRequests: 1,
      bytesIn: new TextEncoder().encode(API_BODY).length,
      promptsAnswered: 1,
    });
    // One poll interval of waiting for the answer is browser time, on the run's own clock.
    expect(report.usage.browserMs).toBeGreaterThanOrEqual(1_000);
    expect(Number.isInteger(report.usage.browserMs)).toBe(true);
    // The session it logged into is stored — and nothing in the bucket is readable.
    expect(storage.objects().size).toBe(1);
    const stored = [...storage.objects().values()]
      .map((bytes) => new TextDecoder().decode(bytes))
      .join('');
    expect(stored).toContain('"sealed":"x1.');
    expect(stored).not.toContain('bank.test');
  });
});

describe('unit · what each number counts', () => {
  const define = (
    over: Partial<ScrapeDefinition<Input, { id: string }>>,
  ): ScrapeDefinition<Input, { id: string }> => ({
    name: 'bank.accounts',
    input: t.object({ connectionId: t.string, exit: t.string }),
    extract: t.object({ id: t.string }),
    idempotencyKey: ({ connectionId }) => `accounts:${connectionId}`,
    tenant: 'none',
    allowHosts: ['bank.test'],
    robots: { ignore: 'a recorded site: there is no origin to ask' },
    clock: testScrapeClock(),
    driver: fakeBrowser(PAGES, { http: HTTP }),
    run: () => Promise.resolve([]),
    ...over,
  });
  const input: Input = { connectionId: 'conn-7', exit: '' };

  test('a run that did nothing reports zeros, and no browserCost key at all', async () => {
    const report = (await runScrape(define({}), runArgs(input))) as ScrapeReport<{ id: string }>;
    expect(report.usage).toEqual({
      browserMs: 0,
      navigations: 0,
      httpRequests: 0,
      bytesIn: 0,
      promptsAnswered: 0,
    });
    expect('browserCost' in report.usage).toBe(false);
  });

  test('a navigation refused before it left is not a navigation', async () => {
    const lines: Record<string, unknown>[] = [];
    await runScrape(
      define({
        run: async ({ page }) => {
          await page.goto(ACCOUNTS);
          await page.goto('https://elsewhere.test/');
          return [];
        },
      }),
      runArgs(input, lines),
    ).catch(() => undefined);
    const failed = lines.find((line) => line['msg'] === 'scrape.failed');
    // The failed run has no report, and still says what it spent — on the line it already writes.
    expect(failed?.['code']).toBe('X_SCRAPE_HOST_BLOCKED');
    expect(failed?.['navigations']).toBe(1);
    expect(failed?.['httpRequests']).toBe(0);
  });

  test('the ok line carries the same counts as the report', async () => {
    const lines: Record<string, unknown>[] = [];
    const report = (await runScrape(
      define({
        run: async ({ page, http }) => {
          await page.goto(ACCOUNTS);
          await http.request(API);
          return [];
        },
      }),
      runArgs(input, lines),
    )) as ScrapeReport<{ id: string }>;
    const ok = lines.find((line) => line['msg'] === 'scrape.ok');
    expect(ok?.['navigations']).toBe(report.usage.navigations);
    expect(ok?.['httpRequests']).toBe(1);
    expect(ok?.['bytesIn']).toBe(report.usage.bytesIn);
    expect('browserCost' in (ok ?? {})).toBe(false);
  });
});

describe('unit · the live HTTP leg counts what was on the wire', () => {
  const transport = (responses: readonly Response[], maxMeter = usageMeter(testScrapeClock())) => {
    let next = 0;
    const http = httpOverFetch({
      rules: { allowHosts: ['bank.test'] },
      clock: testScrapeClock(),
      timeoutMs: 1_000,
      network: boundedRing(10),
      session: () => Promise.resolve(EMPTY_SESSION),
      usage: maxMeter,
      fetch: () => Promise.resolve(responses[next++] ?? new Response('', { status: 500 })),
    });
    return { http, meter: maxMeter };
  };

  test('a followed redirect is two requests, and only the answer`s body is bytes read', async () => {
    const { http, meter } = transport([
      new Response('moved, with a body nobody reads', {
        status: 302,
        headers: { location: 'https://bank.test/api/v2' },
      }),
      new Response('0123456789', { status: 200 }),
    ]);
    await http.request('https://bank.test/api/v1');
    expect(meter.snapshot()).toMatchObject({ httpRequests: 2, bytesIn: 10 });
  });

  test('a body refused for its size still counts the bytes that were read before the refusal', async () => {
    const { http, meter } = transport([new Response('x'.repeat(64), { status: 200 })]);
    await http.request('https://bank.test/api/v1', { maxBytes: 16 }).catch(() => undefined);
    const used = meter.snapshot();
    expect(used.httpRequests).toBe(1);
    expect(used.bytesIn).toBeGreaterThan(16);
  });
});

describe('unit · browserCost is the resolver`s Money, never a float', () => {
  const rented = (cost: unknown) => {
    const launcher = fakeCdpLauncher({ url: 'https://bank.test/', html: '<p>hi</p>' });
    let released = 0;
    const driver = remoteBrowser({
      launcher,
      cdpUrl: () =>
        Promise.resolve({
          cdpUrl: 'wss://connect.provider.test/?token=tok_live_9f8e7d6c5b4a',
          cost: cost as { minor: number; currency: string },
          release: () => {
            released += 1;
            return Promise.resolve();
          },
        }),
    });
    return { driver, released: () => released };
  };
  const definition = (
    driver: ScrapeDefinition<Input, { id: string }>['driver'],
  ): ScrapeDefinition<Input, { id: string }> => ({
    name: 'bank.accounts',
    input: t.object({ connectionId: t.string, exit: t.string }),
    extract: t.object({ id: t.string }),
    idempotencyKey: ({ connectionId }) => `accounts:${connectionId}`,
    tenant: 'none',
    allowHosts: ['bank.test'],
    robots: { ignore: 'a fake browser: there is no origin to ask' },
    clock: testScrapeClock(),
    driver,
    run: () => Promise.resolve([]),
  });

  test('the cost the resolver stated is on the report, as it was stated', async () => {
    const { driver } = rented({ minor: 35, currency: 'USD' });
    const report = (await runScrape(
      definition(driver),
      runArgs({ connectionId: 'conn-7', exit: '' }),
    )) as ScrapeReport<{ id: string }>;
    expect(report.usage.browserCost).toEqual({ minor: 35, currency: 'USD' });
  });

  test('a sub-cent cost is a scale, not a fraction', async () => {
    const { driver } = rented({ minor: 3_500, currency: 'USD', scale: 6 });
    const report = (await runScrape(
      definition(driver),
      runArgs({ connectionId: 'conn-7', exit: '' }),
    )) as ScrapeReport<{ id: string }>;
    expect(report.usage.browserCost).toEqual({ minor: 3_500, currency: 'USD', scale: 6 });
  });

  test('a float cost is refused before the browser is attached, and the rental is handed back', async () => {
    const { driver, released } = rented({ minor: 0.35, currency: 'USD' });
    const code = await runScrape(definition(driver), runArgs({ connectionId: 'c', exit: '' })).then(
      () => 'resolved',
      (thrown: unknown) => (thrown as { code?: string }).code,
    );
    expect(code).toBe('X_VALIDATION_FAILED');
    expect(released()).toBe(1);
  });
});

// `eventPrompt()` waits for an answer published by ANOTHER process, in process, with the session
// open. Every case here runs on a test clock: the poll interval is a declared number and sleeping
// is advancing, so a five-minute wait is a few microtasks and nothing reads a wall clock.

import { describe, expect, test } from 'bun:test';
import { createContext, createLogger, seal } from '@ultimat3/core';
import type { EventBus, JobRunArgs, StepApi } from '@ultimat3/jobs';
import { memoryEventBus } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import type { PromptRequest } from './auth';
import { fakeCdpLauncher } from './cdp-fake-fixture';
import type { CdpBrowserLike } from './cdp-port';
import type { TestScrapeClock } from './clock';
import { testClock } from './clock';
import { localBrowser } from './driver-cdp';
import {
  answerPrompt,
  DEFAULT_PROMPT_ANSWER_TTL_MS,
  eventPrompt,
  promptEventName,
} from './event-prompt';
import type { ScrapeReport } from './scrape';
import { runScrape } from './scrape-run';

const KEYS = { env: { ULTIMATE_SECRETS_KEY: 'c3'.repeat(32) }, root: '/nonexistent-app-root' };

interface Harness {
  readonly clock: TestScrapeClock;
  readonly bus: EventBus;
  readonly keepAlives: () => number;
  /** A request whose `keepAlive` runs `between` on its nth call — "meanwhile, in another process". */
  request(over?: Partial<PromptRequest>, between?: (call: number) => Promise<void>): PromptRequest;
}

const harness = (): Harness => {
  const clock = testClock(new Date('2026-10-01T00:00:00.000Z'));
  const bus = memoryEventBus({ clock });
  let calls = 0;
  return {
    clock,
    bus,
    keepAlives: () => calls,
    request: (over = {}, between) => ({
      input: { connectionId: 'conn-1' },
      label: 'sms code',
      scrape: 'bank',
      url: 'https://bank.test/otp',
      runId: 'run-1',
      index: 1,
      clock,
      signal: undefined,
      keepAlive: async () => {
        calls += 1;
        await between?.(calls);
      },
      ...over,
    }),
  };
};

/** `unknown`, because a `PromptHandler` may answer a plain string as well as a promise of one. */
const failure = async (promise: unknown): Promise<Record<string, unknown>> => {
  try {
    await promise;
    return { code: 'resolved' };
  } catch (thrown) {
    return thrown as Record<string, unknown>;
  }
};

describe('unit · the event name is derived, never chosen', () => {
  test('scrape-prompt:<runId>:<n>', () => {
    expect(promptEventName('run-1', 2)).toBe('scrape-prompt:run-1:2');
  });
});

describe('unit · eventPrompt answers from the bus', () => {
  test('an answer published while it waits is returned', async () => {
    const h = harness();
    const handler = eventPrompt({ timeout: 300_000, bus: h.bus, keySource: KEYS });
    const answer = await handler(
      h.request({}, async (call) => {
        if (call === 3) {
          await answerPrompt({
            runId: 'run-1',
            index: 1,
            answer: '482913',
            bus: h.bus,
            keySource: KEYS,
          });
        }
      }),
    );
    expect(answer).toBe('482913');
    // Three looks found nothing, the fourth found it: the session was kept alive between each.
    expect(h.keepAlives()).toBe(3);
  });

  // The bus stamps an answer with ITS clock — the database's, for the stored one — and the prompt
  // used to take "asked at" from the WORKER's. Two clocks: a worker running 30 s ahead of the bus
  // read every answer as published before it was asked for, and waited out its whole timeout
  // while the human who did answer watched the run fail.
  test('"asked at" is read from the BUS: a worker clock 30 s ahead still takes the answer', async () => {
    const h = harness();
    const ahead = testClock(new Date(h.clock.now().getTime() + 30_000));
    const handler = eventPrompt({ timeout: 300_000, bus: h.bus, keySource: KEYS });
    const answer = await handler(
      h.request({ clock: ahead }, async (call) => {
        if (call === 2) {
          // Published five seconds after the ask, on the bus's own clock.
          h.clock.advance(5_000);
          await answerPrompt({
            runId: 'run-1',
            index: 1,
            answer: '482913',
            bus: h.bus,
            keySource: KEYS,
          });
        }
      }),
    );
    expect(answer).toBe('482913');
  });

  test('…and a worker clock 30 s BEHIND still refuses a code left over from before the ask', async () => {
    const h = harness();
    await answerPrompt({ runId: 'run-1', index: 1, answer: 'stale', bus: h.bus, keySource: KEYS });
    h.clock.advance(1);
    const behind = testClock(new Date(h.clock.now().getTime() - 30_000));
    const handler = eventPrompt({ timeout: 5_000, bus: h.bus, keySource: KEYS });
    const thrown = await failure(handler(h.request({ clock: behind })));
    // On the worker's clock the stale answer is "after" the ask. On the bus's it is not.
    expect(thrown['code']).toBe('X_SCRAPE_PROMPT_UNANSWERED');
  });

  test('the poll interval is the declared one — time passes by exactly that much per look', async () => {
    const h = harness();
    const startedAt = h.clock.monotonic();
    const handler = eventPrompt({ timeout: 300_000, pollMs: 2_500, bus: h.bus, keySource: KEYS });
    await handler(
      h.request({}, async (call) => {
        if (call === 4) {
          await answerPrompt({
            runId: 'run-1',
            index: 1,
            answer: 'x1',
            bus: h.bus,
            keySource: KEYS,
          });
        }
      }),
    );
    expect(h.clock.monotonic() - startedAt).toBe(4 * 2_500);
  });

  test('the answer is SEALED on the bus — the stored event never holds the code', async () => {
    const h = harness();
    const published = await answerPrompt({
      runId: 'run-1',
      index: 1,
      answer: '482913',
      bus: h.bus,
      keySource: KEYS,
    });
    expect(JSON.stringify(await h.bus.list())).not.toContain('482913');
    expect(published.name).toBe('scrape-prompt:run-1:1');
    expect(published.expiresAt - published.publishedAt).toBe(DEFAULT_PROMPT_ANSWER_TTL_MS);
  });
});

describe('unit · eventPrompt never consumes an answer that is not this prompt`s', () => {
  test('an answer published for another run id times out, unconsumed', async () => {
    const h = harness();
    const handler = eventPrompt({ timeout: 10_000, bus: h.bus, keySource: KEYS });
    const thrown = await failure(
      handler(
        h.request({}, async (call) => {
          if (call === 1) {
            await answerPrompt({
              runId: 'run-2',
              index: 1,
              answer: '482913',
              bus: h.bus,
              keySource: KEYS,
            });
          }
        }),
      ),
    );
    expect(thrown['code']).toBe('X_SCRAPE_PROMPT_UNANSWERED');
    // Still there for the run it was published to.
    expect(await h.bus.find('scrape-prompt:run-2:1', undefined, 0)).toBeDefined();
  });

  test('an answer for another prompt of the SAME run is not this one`s', async () => {
    const h = harness();
    const handler = eventPrompt({ timeout: 10_000, bus: h.bus, keySource: KEYS });
    const thrown = await failure(
      handler(
        h.request({ index: 2 }, async (call) => {
          if (call === 1) {
            await answerPrompt({
              runId: 'run-1',
              index: 1,
              answer: 'x1',
              bus: h.bus,
              keySource: KEYS,
            });
          }
        }),
      ),
    );
    expect(thrown['code']).toBe('X_SCRAPE_PROMPT_UNANSWERED');
  });

  test('an answer published BEFORE the prompt was asked is stale — a retried attempt asks again', async () => {
    const h = harness();
    await answerPrompt({ runId: 'run-1', index: 1, answer: 'stale', bus: h.bus, keySource: KEYS });
    h.clock.advance(60_000);
    const handler = eventPrompt({ timeout: 10_000, bus: h.bus, keySource: KEYS });
    expect((await failure(handler(h.request())))['code']).toBe('X_SCRAPE_PROMPT_UNANSWERED');
  });

  test('a payload answerPrompt() did not write is refused, never typed into the site', async () => {
    const h = harness();
    const handler = eventPrompt({ timeout: 10_000, bus: h.bus, keySource: KEYS });
    const thrown = await failure(
      handler(
        h.request({}, async (call) => {
          if (call === 1) await h.bus.publish('scrape-prompt:run-1:1', { answer: '482913' });
        }),
      ),
    );
    expect(thrown['code']).toBe('X_SCRAPE_PROMPT_UNANSWERED');
    expect(String(thrown['cause'])).toContain('does not carry a sealed answer');
    expect(String(thrown['fix'])).toContain('answerPrompt({ runId, index, answer })');
  });

  test('an answer sealed for another prompt and re-published under this name fails its tag', async () => {
    const h = harness();
    const other = await answerPrompt({
      runId: 'run-2',
      index: 1,
      answer: '482913',
      bus: h.bus,
      keySource: KEYS,
    });
    const handler = eventPrompt({ timeout: 10_000, bus: h.bus, keySource: KEYS });
    const thrown = await failure(
      handler(
        h.request({}, async (call) => {
          if (call === 1) await h.bus.publish('scrape-prompt:run-1:1', other.payload);
        }),
      ),
    );
    expect(thrown['code']).toBe('X_SEAL_INVALID');
  });
});

describe('unit · eventPrompt gives up on the timeout, the run signal, or a dead browser', () => {
  test('the timeout is X_SCRAPE_PROMPT_UNANSWERED, terminal, naming the event and the fix', async () => {
    const h = harness();
    const handler = eventPrompt({ timeout: 10_000, pollMs: 1_000, bus: h.bus, keySource: KEYS });
    const thrown = await failure(handler(h.request()));
    expect(thrown['code']).toBe('X_SCRAPE_PROMPT_UNANSWERED');
    expect(thrown['retry']).toBe('terminal');
    expect(String(thrown['cause'])).toContain('scrape-prompt:run-1:1 within 10000ms');
    expect(String(thrown['fix'])).toContain('answerPrompt({ runId, index, answer })');
    expect(String(thrown['fix'])).toContain('postgresEventBus');
    // Ten intervals fit the budget; the wait is bounded by the budget, not by a poll count.
    expect(h.keepAlives()).toBe(10);
  });

  test('the run signal aborts the wait with the reason it carries', async () => {
    const h = harness();
    const run = new AbortController();
    const handler = eventPrompt({ timeout: 300_000, bus: h.bus, keySource: KEYS });
    const thrown = await failure(
      handler(
        h.request({ signal: run.signal }, (call) => {
          if (call === 2) run.abort(new Error('the job was cancelled'));
          return Promise.resolve();
        }),
      ),
    );
    expect(thrown['message']).toBe('the job was cancelled');
    expect(h.keepAlives()).toBe(2);
  });

  test('a run already cancelled when the prompt is asked reads nothing and touches nothing', async () => {
    const h = harness();
    const run = new AbortController();
    run.abort(new Error('cancelled before the login asked'));
    const handler = eventPrompt({ timeout: 300_000, bus: h.bus, keySource: KEYS });
    const thrown = await failure(handler(h.request({ signal: run.signal })));
    expect(thrown['message']).toBe('cancelled before the login asked');
    expect(h.keepAlives()).toBe(0);
  });

  test('a browser that died while waiting ends the wait with ITS failure', async () => {
    const h = harness();
    const handler = eventPrompt({ timeout: 300_000, bus: h.bus, keySource: KEYS });
    const thrown = await failure(
      handler(h.request({}, () => Promise.reject(new Error('the renderer is gone')))),
    );
    expect(thrown['message']).toBe('the renderer is gone');
  });
});

describe('unit · eventPrompt screens its own numbers', () => {
  test.each([
    ['timeout', { timeout: Number.NaN }],
    ['timeout', { timeout: 0 }],
    ['pollMs', { timeout: 1_000, pollMs: 0 }],
    ['pollMs', { timeout: 1_000, pollMs: Number.POSITIVE_INFINITY }],
  ])('a non-finite or zero %s is refused where it is written', (option, options) => {
    expect(() => eventPrompt(options)).toThrow(option);
  });
});

describe('unit · the session stays open across the wait', () => {
  // The real driver's path, watchdog armed: nobody asks the browser anything while a human reads
  // a text message, and `watchdog.idleMs` of silence is what `X_SCRAPE_WEDGED` means.
  test('a wait far longer than the wedge budget is answered, with the browser never killed', async () => {
    const WEDGE_MS = 30_000;
    const clock = testClock(new Date('2026-10-01T00:00:00.000Z'));
    const memory = memoryEventBus({ clock });
    const startedAt = clock.monotonic();
    let looks = 0;
    let kills = 0;
    let whenAnswered: { closed: boolean; kills: number; waitedMs: number } | undefined;
    const fake = fakeCdpLauncher({ url: 'https://bank.test/', html: '<p>otp</p>' });
    // A browser WITH a process, so a wedge is observable: the watchdog's kill reaches it.
    const browser: CdpBrowserLike = {
      ...fake.browser,
      process: () => ({
        kill: () => {
          kills += 1;
        },
      }),
    };
    // Sealed BEFORE the run and published during it. Sealing is real asynchronous work, and under
    // a test clock the watchdog's own poll advances time for as long as anything real is pending —
    // so the state is read at the look that publishes, before the answer is opened.
    const sealed = await seal('482913', { purpose: promptEventName('run-9', 1), ...KEYS });
    const bus: EventBus = {
      ...memory,
      find: async (name, correlationKey, afterMs) => {
        looks += 1;
        if (looks === 120) {
          whenAnswered = {
            closed: fake.browser.closed,
            kills,
            waitedMs: clock.monotonic() - startedAt,
          };
          await memory.publish(name, sealed);
        }
        return memory.find(name, correlationKey, afterMs);
      },
    };
    const args: JobRunArgs<Record<string, never>> = {
      input: {},
      step: {
        run: <T>(_name: string, fn: () => Promise<T> | T) => Promise.resolve(fn()),
      } as unknown as StepApi,
      ctx: createContext({ logger: createLogger({ writer: () => undefined }) }),
      attempt: 1,
      finalAttempt: false,
      progress: () => undefined,
      jobId: 'job-9',
      runId: 'run-9',
    };
    let answer: string | undefined;
    const report = (await runScrape(
      {
        name: 'bank',
        input: t.object({}),
        extract: t.object({ code: t.string }),
        idempotencyKey: () => 'bank',
        tenant: 'none',
        allowHosts: ['bank.test'],
        robots: { ignore: 'a fake browser: there is no origin to ask' },
        clock,
        watchdog: { idleMs: WEDGE_MS },
        driver: localBrowser({ launcher: { launch: () => Promise.resolve(browser) } }),
        prompt: eventPrompt({ timeout: 3_600_000, pollMs: 1_000, bus, keySource: KEYS }),
        auth: {
          login: async ({ prompt }) => {
            answer = await prompt('sms code');
          },
        },
        run: () => Promise.resolve([{ code: 'ok' }]),
      },
      args,
    )) as ScrapeReport<{ code: string }>;
    expect(answer).toBe('482913');
    expect(whenAnswered?.closed).toBe(false);
    expect(whenAnswered?.kills).toBe(0);
    // The wait really did outlast the wedge budget, several times over — or this proves nothing.
    expect(whenAnswered?.waitedMs).toBeGreaterThan(3 * WEDGE_MS);
    expect(report.usage.promptsAnswered).toBe(1);
  });
});

describe('unit · eventPrompt needs a STORED bus outside development and test', () => {
  // The answer is published by a web process and read by a worker. An in-memory bus lives in ONE
  // of them, so in a real deployment the prompt can only ever time out — five minutes later, as
  // `X_SCRAPE_PROMPT_UNANSWERED`, which blames the human who answered.
  const asked = (env: Record<string, string>, stored: boolean) => {
    const h = harness();
    const bus: EventBus = { ...h.bus, stored };
    return failure(eventPrompt({ timeout: 1_000, bus, keySource: KEYS, env })(h.request()));
  };

  test('an in-memory bus in production is refused when the prompt is asked, naming the boot line', async () => {
    const refused = await asked({ NODE_ENV: 'production' }, false);
    expect(refused['code']).toBe('X_DRIVER_UNAVAILABLE');
    expect(String(refused['cause'])).toContain('in-memory');
    expect(String(refused['fix'])).toContain('setEventBus(postgresEventBus({ executor }))');
  });

  test('staging fails the way production fails', async () => {
    expect((await asked({ NODE_ENV: 'staging' }, false))['code']).toBe('X_DRIVER_UNAVAILABLE');
  });

  test('a stored bus is asked in production, and the in-memory one in test', async () => {
    // Both reach the WAIT, so both end as an unanswered prompt — never as a refused bus.
    expect((await asked({ NODE_ENV: 'production' }, true))['code']).toBe(
      'X_SCRAPE_PROMPT_UNANSWERED',
    );
    expect((await asked({ NODE_ENV: 'test' }, false))['code']).toBe('X_SCRAPE_PROMPT_UNANSWERED');
  });
});

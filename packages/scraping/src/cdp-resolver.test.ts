// A rented browser is acquired once per session and handed back EXACTLY once — on a run that
// worked, a run that threw, a run that was cancelled, and an `open()` that never returned a
// session at all. A missed release is a browser somebody is billing for; a second one is a
// provider API told to end a session that now belongs to another run.

import { describe, expect, test } from 'bun:test';
import { createContext, createLogger, UltimateError } from '@ultimat3/core';
import type { JobRunArgs, StepApi } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { fakeCdpLauncher } from './cdp-fake';
import type { CdpBrowserLike, CdpLauncherLike } from './cdp-port';
import type { CdpResolverRequest } from './cdp-resolver';
import { testClock } from './clock';
import type { SessionInit } from './driver';
import { remoteBrowser } from './driver-cdp';
import type { ScrapeDefinition } from './scrape';
import { runScrape } from './scrape-run';

const CDP_URL = 'wss://connect.provider.test/session/abc';

interface Rental {
  readonly requests: CdpResolverRequest[];
  readonly releases: () => number;
  readonly connected: string[];
  readonly browser: ReturnType<typeof fakeCdpLauncher>['browser'];
  readonly launcher: CdpLauncherLike;
  resolve(request: CdpResolverRequest): Promise<{
    cdpUrl: string;
    release(): Promise<void>;
  }>;
}

const rental = (
  over: {
    readonly connect?: (browser: CdpBrowserLike) => Promise<CdpBrowserLike>;
    readonly cdpUrl?: string;
    readonly release?: () => Promise<void>;
  } = {},
): Rental => {
  const fake = fakeCdpLauncher({ url: 'https://shop.test/', html: '<p class="row">hi</p>' });
  const requests: CdpResolverRequest[] = [];
  const connected: string[] = [];
  let releases = 0;
  return {
    requests,
    connected,
    releases: () => releases,
    browser: fake.browser,
    launcher: {
      connect: (options) => {
        connected.push(String(options['browserWSEndpoint']));
        return over.connect === undefined
          ? Promise.resolve(fake.browser)
          : over.connect(fake.browser);
      },
    },
    resolve: (request) => {
      requests.push(request);
      return Promise.resolve({
        cdpUrl: over.cdpUrl ?? CDP_URL,
        release: () => {
          releases += 1;
          return over.release === undefined ? Promise.resolve() : over.release();
        },
      });
    },
  };
};

const init = (over: Partial<SessionInit> = {}): SessionInit => ({
  name: 'orders',
  rules: { allowHosts: ['shop.test'] },
  clock: testClock(),
  timeoutMs: 1_000,
  logger: createLogger({ writer: () => undefined }),
  ...over,
});

const runArgs = (signal?: AbortSignal): JobRunArgs<Record<string, never>> => ({
  input: {},
  step: {
    run: <T>(_name: string, fn: () => Promise<T> | T) => Promise.resolve(fn()),
  } as unknown as StepApi,
  ctx: createContext({
    logger: createLogger({ writer: () => undefined }),
    ...(signal === undefined ? {} : { signal }),
  }),
  attempt: 1,
  finalAttempt: false,
  progress: () => undefined,
  jobId: 'job-1',
  runId: 'run-77',
});

const define = (
  held: Rental,
  run: ScrapeDefinition<Record<string, never>, { id: string }>['run'],
): ScrapeDefinition<Record<string, never>, { id: string }> => ({
  name: 'orders',
  input: t.object({}),
  extract: t.object({ id: t.string }),
  idempotencyKey: () => 'orders',
  tenant: 'none',
  allowHosts: ['shop.test'],
  robots: { ignore: 'a fake browser: there is no origin to ask' },
  clock: testClock(),
  egress: () => 'http://exit-7.test:8080',
  driver: remoteBrowser({ launcher: held.launcher, cdpUrl: held.resolve }),
  run,
});

const codeOf = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
    return 'resolved';
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

describe('unit · the resolver is asked once per session, with what it needs to rent', () => {
  test('it is told the scrape, the run, the exit and the run`s signal — and its URL is what is dialled', async () => {
    const held = rental();
    const run = new AbortController();
    await runScrape(
      define(held, () => Promise.resolve([])),
      runArgs(run.signal),
    );
    expect(held.requests).toHaveLength(1);
    expect(held.requests[0]).toEqual({
      scrape: 'orders',
      runId: 'run-77',
      egress: 'http://exit-7.test:8080',
      signal: run.signal,
    });
    expect(held.connected).toEqual([CDP_URL]);
  });

  test('with no run exit the resolver is told the driver`s own', async () => {
    const held = rental();
    const session = await remoteBrowser({
      launcher: held.launcher,
      cdpUrl: held.resolve,
      proxy: 'http://constant.test:1',
    }).open(init());
    expect(held.requests[0]?.egress).toBe('http://constant.test:1');
    expect(session.proxy).toBe('http://constant.test:1');
    await session.close();
  });

  test('a resolver takes any exit: the run`s wins and is what the session reports', async () => {
    const held = rental();
    const session = await remoteBrowser({
      launcher: held.launcher,
      cdpUrl: held.resolve,
      proxy: 'http://constant.test:1',
    }).open(init({ proxy: 'http://exit-7.test:8080' }));
    expect(held.requests[0]?.egress).toBe('http://exit-7.test:8080');
    expect(session.proxy).toBe('http://exit-7.test:8080');
    await session.close();
  });
});

describe('unit · release() runs exactly once', () => {
  test('on a run that succeeded — after the browser was closed', async () => {
    const held = rental();
    let closedAtRelease: boolean | undefined;
    const ordered = rental({
      release: () => {
        closedAtRelease = ordered.browser.closed;
        return Promise.resolve();
      },
    });
    await runScrape(
      define(held, () => Promise.resolve([{ id: 'a' }])),
      runArgs(),
    );
    await runScrape(
      define(ordered, () => Promise.resolve([{ id: 'a' }])),
      runArgs(),
    );
    expect(held.releases()).toBe(1);
    expect(held.browser.closed).toBe(true);
    // The provider is told "done" only once the socket is gone.
    expect(closedAtRelease).toBe(true);
  });

  test('on a run whose body threw', async () => {
    const held = rental();
    const code = await codeOf(() =>
      runScrape(
        define(held, () =>
          Promise.reject(
            new UltimateError({
              code: 'X_INVARIANT',
              cause: 'the body failed',
              fix: 'fix the body',
            }),
          ),
        ),
        runArgs(),
      ),
    );
    expect(code).toBe('X_INVARIANT');
    expect(held.releases()).toBe(1);
  });

  test('on a run that was cancelled mid-body', async () => {
    const held = rental();
    const run = new AbortController();
    const outcome = await runScrape(
      define(held, async ({ page, ctx }) => {
        run.abort(new Error('the job was cancelled'));
        // A wait is where a cancelled run finds out: the sleep rejects with the signal's reason.
        await page.waitFor('.never-appears', { timeout: 60_000 });
        return ctx.signal === undefined ? [] : [];
      }),
      runArgs(run.signal),
    ).then(
      () => 'resolved',
      (thrown: unknown) => (thrown as { message?: string }).message,
    );
    expect(outcome).toBe('the job was cancelled');
    expect(held.releases()).toBe(1);
  });

  test('when the attach itself is refused — runScrape`s finally never sees that session', async () => {
    const held = rental({ connect: () => Promise.reject(new Error('401 Unauthorized')) });
    const code = await codeOf(() =>
      remoteBrowser({ launcher: held.launcher, cdpUrl: held.resolve }).open(init()),
    );
    expect(code).toBe('X_SCRAPE_CDP_ATTACH_FAILED');
    expect(held.releases()).toBe(1);
  });

  test('when the page cannot be opened on the attached browser — the browser is closed AND released', async () => {
    const held = rental({
      connect: (browser) =>
        Promise.resolve({ ...browser, newPage: () => Promise.reject(new Error('tab limit')) }),
    });
    const code = await codeOf(() =>
      remoteBrowser({ launcher: held.launcher, cdpUrl: held.resolve }).open(init()),
    );
    expect(code).toBe('X_SCRAPE_BROWSER_UNREACHABLE');
    expect(held.releases()).toBe(1);
  });

  test('when the resolver hands back no URL at all', async () => {
    const empty = rental({ cdpUrl: '' });
    // `cdpUrl: ''` cannot be passed through `over` with `??`, so the resolver is written out.
    let releases = 0;
    const code = await codeOf(() =>
      remoteBrowser({
        launcher: empty.launcher,
        cdpUrl: () =>
          Promise.resolve({
            cdpUrl: '',
            release: () => {
              releases += 1;
              return Promise.resolve();
            },
          }),
      }).open(init()),
    );
    expect(code).toBe('X_SCRAPE_REMOTE_REQUIRED');
    expect(releases).toBe(1);
    expect(empty.connected).toEqual([]);
  });

  test('a release() that rejects is WARNED, once, with the code and the endpoint`s host — never its path', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', writer: (line) => lines.push(line) });
    // The provider's own failure text quotes the connect URL — which is its access token.
    const held = rental({
      release: () =>
        Promise.reject(
          new UltimateError({
            code: 'X_PROVIDER_RELEASE_FAILED',
            cause: `DELETE ${CDP_URL} answered 503`,
            fix: 'x doctor --json',
          }),
        ),
    });
    const session = await remoteBrowser({ launcher: held.launcher, cdpUrl: held.resolve }).open(
      init({ logger }),
    );
    expect(lines.filter((line) => line.includes('release_failed'))).toEqual([]);
    // Never throws: it runs in the run's `finally`.
    await session.close();
    await session.close();
    const warned = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line['msg'] === 'scrape.browser.release_failed');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({
      level: 'warn',
      code: 'X_PROVIDER_RELEASE_FAILED',
      driver: 'puppeteer',
      origin: 'wss://connect.provider.test',
    });
    expect(lines.join('\n')).not.toContain('/session/abc');
    expect(held.releases()).toBe(1);
  });

  test('an uncoded rejection still warns — with the host, and none of its message', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', writer: (line) => lines.push(line) });
    const held = rental({ release: () => Promise.reject({ message: `gone: ${CDP_URL}` }) });
    await (
      await remoteBrowser({ launcher: held.launcher, cdpUrl: held.resolve }).open(init({ logger }))
    ).close();
    const [warned] = lines.filter((line) => line.includes('scrape.browser.release_failed'));
    expect(JSON.parse(warned ?? '{}')).toMatchObject({ origin: 'wss://connect.provider.test' });
    expect(warned).not.toContain('gone');
    expect(warned).not.toContain('"code"');
  });

  test('a release() that resolves warns nothing', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', writer: (line) => lines.push(line) });
    const held = rental();
    const session = await remoteBrowser({ launcher: held.launcher, cdpUrl: held.resolve }).open(
      init({ logger }),
    );
    await session.close();
    expect(lines.filter((line) => line.includes('release_failed'))).toEqual([]);
  });

  test('a second close() releases nothing more', async () => {
    const held = rental();
    const session = await remoteBrowser({ launcher: held.launcher, cdpUrl: held.resolve }).open(
      init(),
    );
    await session.close();
    await session.close();
    expect(held.releases()).toBe(1);
  });

  test('a release that rejects never makes close() throw — it runs in a finally', async () => {
    const held = rental({ release: () => Promise.reject(new Error('provider: 503')) });
    const session = await remoteBrowser({ launcher: held.launcher, cdpUrl: held.resolve }).open(
      init(),
    );
    await session.close();
    expect(held.releases()).toBe(1);
  });

  test('a resolution with no release at all is a session like any other', async () => {
    const fake = fakeCdpLauncher({ url: 'https://shop.test/', html: '<p>hi</p>' });
    const session = await remoteBrowser({
      launcher: fake,
      cdpUrl: () => Promise.resolve({ cdpUrl: CDP_URL }),
    }).open(init());
    await session.close();
    expect(fake.browser.closed).toBe(true);
  });
});

describe('unit · a resolver that could not rent', () => {
  test('a bare throw is the retryable attach failure, naming the scrape and never a URL', async () => {
    const fake = fakeCdpLauncher({ url: 'https://shop.test/', html: '<p>hi</p>' });
    let thrown: Record<string, unknown> = {};
    try {
      await remoteBrowser({
        launcher: fake,
        cdpUrl: () => Promise.reject(new Error('provider: no capacity in eu-west')),
      }).open(init());
    } catch (caught) {
      thrown = caught as Record<string, unknown>;
    }
    expect(thrown['code']).toBe('X_SCRAPE_CDP_ATTACH_FAILED');
    expect(thrown['retry']).toBe('retryable');
    expect(String(thrown['cause'])).toContain('scrape "orders"');
    expect(String(thrown['cause'])).toContain('no capacity in eu-west');
  });

  test('the resolver`s own coded error keeps its code and its classification', async () => {
    const fake = fakeCdpLauncher({ url: 'https://shop.test/', html: '<p>hi</p>' });
    const code = await codeOf(() =>
      remoteBrowser({
        launcher: fake,
        cdpUrl: () =>
          Promise.reject(
            new UltimateError({
              code: 'X_ENV_MISSING',
              cause: 'PROVIDER_API_KEY is not set',
              fix: 'add PROVIDER_API_KEY= to .env.local',
            }),
          ),
      }).open(init()),
    );
    expect(code).toBe('X_ENV_MISSING');
  });
});

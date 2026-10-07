// The session's exit is the RUN's decision. `egress:` on the definition reaches the driver as
// `SessionInit.proxy`, the driver dials through it on both legs, and the session reports what it
// dialled so the robots read leaves through the same exit. A driver that cannot honour it refuses
// by name instead of dialling its own constant.

import { describe, expect, test } from 'bun:test';
import { ctxOf, structuredLogger } from '@ultimat3/core';
import type { JobRunArgs, StepApi } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { fakeCdpLauncher } from './cdp-fake-fixture';
import type { CdpBrowserLike, CdpLauncherLike } from './cdp-port';
import { testScrapeClock } from './clock';
import type { ScrapeDriver, SessionInit } from './driver';
import { localBrowser, remoteBrowser } from './driver-cdp';
import { fakeBrowser } from './driver-fake';
import type { ScrapeDefinition } from './scrape';
import { runScrape } from './scrape-run';

const URL_A = 'https://shop.test/orders';
const HTML = '<html><body><p class="row" data-id="1">One</p></body></html>';
const EXIT = 'http://exit-7.test:8080';
const SECRET_EXIT = 'http://session-41:hunter2hunter2@exit-7.test:8080';

interface Input {
  readonly exit?: string | undefined;
}

const runArgs = (input: Input): JobRunArgs<Input> => ({
  input,
  step: {
    run: <T>(_name: string, fn: () => Promise<T> | T) => Promise.resolve(fn()),
  } as unknown as StepApi,
  ctx: ctxOf({ logger: structuredLogger({ writer: () => undefined }) }),
  attempt: 1,
  finalAttempt: false,
  progress: () => undefined,
  jobId: 'job-1',
  runId: 'run-1',
});

const define = (over: Partial<ScrapeDefinition<Input, { id: string }>> = {}) =>
  ({
    name: 'orders',
    input: t.object({ exit: t.string.optional() }),
    extract: t.object({ id: t.string }),
    idempotencyKey: () => 'orders',
    tenant: 'none',
    allowHosts: ['shop.test'],
    clock: testScrapeClock(),
    // An offline driver has no origin to ask: under the sealed network the read is unreachable,
    // which is complete disallow. The robots tests below opt back in with `robots: 'obey'`.
    robots: { ignore: 'offline fixture, no origin to ask' },
    driver: fakeBrowser([{ url: URL_A, html: HTML }]),
    async run({ page }) {
      await page.goto(URL_A);
      return (await page.values('.row')).map((element) => ({ id: element.attrs['data-id'] }));
    },
    ...over,
  }) satisfies ScrapeDefinition<Input, { id: string }>;

/** A driver that answers offline and writes down what `open()` was handed. */
const recordingDriver = (): ScrapeDriver & { readonly seen: SessionInit[] } => {
  const inner = fakeBrowser([{ url: URL_A, html: HTML }]);
  const seen: SessionInit[] = [];
  return {
    name: inner.name,
    seen,
    open: (init) => {
      seen.push(init);
      return inner.open(init);
    },
  };
};

/** Every `fetch` made while `run` is in flight — a VALUE put back in `finally`, never a module mock. */
const fetchesDuring = async (run: () => Promise<unknown>): Promise<Record<string, unknown>[]> => {
  const seen: Record<string, unknown>[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), ...(init ?? {}) });
    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as typeof globalThis.fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
  return seen;
};

const sessionInit = (over: Partial<SessionInit> = {}): SessionInit => ({
  name: 'orders',
  logger: structuredLogger({ writer: () => undefined }),
  rules: { allowHosts: ['shop.test'] },
  clock: testScrapeClock(),
  timeoutMs: 1_000,
  ...over,
});

/** The fake CDP browser behind a launcher that writes down what `launch()`/`connect()` got. */
const recordingLauncher = (options: { readonly authenticate?: boolean } = {}) => {
  const fake = fakeCdpLauncher({ url: 'https://shop.test/', html: HTML });
  const launched: Record<string, unknown>[] = [];
  const connected: Record<string, unknown>[] = [];
  const authenticated: unknown[] = [];
  const browser: CdpBrowserLike = {
    ...fake.browser,
    newPage: async () => {
      const page = await fake.browser.newPage();
      return options.authenticate === false
        ? page
        : {
            ...page,
            authenticate: (credentials: unknown) => {
              authenticated.push(credentials);
              return Promise.resolve();
            },
          };
    },
  };
  const launcher: CdpLauncherLike = {
    launch: (given) => {
      launched.push(given ?? {});
      return Promise.resolve(browser);
    },
    connect: (given) => {
      connected.push(given ?? {});
      return Promise.resolve(browser);
    },
  };
  return { launcher, launched, connected, authenticated, fake: fake.browser };
};

const codeOf = async (run: () => Promise<unknown>): Promise<Record<string, unknown>> => {
  try {
    await run();
    return { code: 'resolved' };
  } catch (thrown) {
    return thrown as Record<string, unknown>;
  }
};

describe('unit · egress: on the definition reaches the driver as the session exit', () => {
  test('the driver is handed egress(input) as init.proxy, with the run id beside it', async () => {
    const driver = recordingDriver();
    await runScrape(define({ driver, egress: (input) => input.exit }), runArgs({ exit: EXIT }));
    expect(driver.seen[0]?.proxy).toBe(EXIT);
    expect(driver.seen[0]?.runId).toBe('run-1');
  });

  test('no egress declared hands the driver no exit — the driver keeps its own', async () => {
    const driver = recordingDriver();
    await runScrape(define({ driver }), runArgs({}));
    expect(driver.seen[0]?.proxy).toBeUndefined();
  });

  test('an egress that answers undefined or "" for this input is no exit at all', async () => {
    const driver = recordingDriver();
    await runScrape(define({ driver, egress: () => '' }), runArgs({}));
    expect(driver.seen[0]?.proxy).toBeUndefined();
  });

  /** The robots read answered by `answer`, every URL it dialled written down. */
  const robotsDuring = async (answer: (url: string) => Response, run: () => Promise<unknown>) => {
    const seen: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = ((url: string | URL | Request) => {
      seen.push(String(url));
      return Promise.resolve(answer(String(url)));
    }) as typeof globalThis.fetch;
    try {
      return { seen, outcome: await codeOf(run) };
    } finally {
      globalThis.fetch = real;
    }
  };
  const moved = (location: string): Response =>
    new Response(null, { status: 301, headers: { location } });

  test("the run's robots read follows a redirect inside allowHosts and obeys what it finds", async () => {
    const { seen, outcome } = await robotsDuring(
      (url) =>
        url === 'https://shop.test/robots.txt'
          ? moved('https://shop.test/static/robots.txt')
          : new Response('User-agent: *\nDisallow: /orders'),
      () => runScrape(define({ robots: 'obey' }), runArgs({})),
    );
    expect(seen).toEqual(['https://shop.test/robots.txt', 'https://shop.test/static/robots.txt']);
    expect(outcome['code']).toBe('X_SCRAPE_ROBOTS_DISALLOWED');
  });

  test("the run's robots read never dials a redirect off its allowHosts", async () => {
    const { seen } = await robotsDuring(
      () => moved('http://10.0.0.7/robots.txt'),
      () => runScrape(define({ robots: 'obey' }), runArgs({})),
    );
    expect(seen).toEqual(['https://shop.test/robots.txt']);
  });

  test('an offline session reports the exit, so the robots read leaves through it', async () => {
    const seen = await fetchesDuring(() =>
      runScrape(define({ robots: 'obey', egress: () => EXIT }), runArgs({ exit: EXIT })),
    );
    const robots = seen.find((entry) => String(entry['url']).endsWith('/robots.txt'));
    expect(robots?.['proxy']).toBe(EXIT);
  });
});

describe('unit · the launched browser dials the run exit, not the driver constant', () => {
  test('init.proxy wins over options.proxy in the launch args and on the session', async () => {
    const { launcher, launched } = recordingLauncher();
    const session = await localBrowser({ launcher, proxy: 'http://constant.test:1' }).open(
      sessionInit({ proxy: EXIT }),
    );
    expect(launched[0]?.['args']).toEqual([`--proxy-server=${EXIT}`]);
    expect(session.proxy).toBe(EXIT);
    await session.close();
  });

  test('the HTTP leg dials the same exit', async () => {
    const { launcher } = recordingLauncher();
    // Opened INSIDE the swap: the transport takes `fetch` when the session is built.
    const seen = await fetchesDuring(async () => {
      const session = await localBrowser({ launcher, proxy: 'http://constant.test:1' }).open(
        sessionInit({ proxy: EXIT }),
      );
      await session.http.request('https://shop.test/api/orders');
      await session.close();
    });
    expect(seen[0]?.['proxy']).toBe(EXIT);
  });

  test('with no run exit the driver constant is what both legs dial, as before', async () => {
    const { launcher, launched } = recordingLauncher();
    const session = await localBrowser({ launcher, proxy: 'http://constant.test:1' }).open(
      sessionInit(),
    );
    expect(launched[0]?.['args']).toEqual(['--proxy-server=http://constant.test:1']);
    expect(session.proxy).toBe('http://constant.test:1');
    await session.close();
  });

  test('credentials never reach the process arguments: the page authenticates instead', async () => {
    const { launcher, launched, authenticated } = recordingLauncher();
    const session = await localBrowser({ launcher }).open(sessionInit({ proxy: SECRET_EXIT }));
    expect(launched[0]?.['args']).toEqual([`--proxy-server=${EXIT}`]);
    expect(JSON.stringify(launched)).not.toContain('hunter2hunter2');
    expect(authenticated).toEqual([{ username: 'session-41', password: 'hunter2hunter2' }]);
    // The HTTP leg carries the credentials itself: `fetch`'s own `proxy` reads them off the URL.
    expect(session.proxy).toBe(SECRET_EXIT);
    await session.close();
  });

  test('a launcher with no page.authenticate() refuses a credentialed exit and closes the browser', async () => {
    const { launcher, fake } = recordingLauncher({ authenticate: false });
    const thrown = await codeOf(() =>
      localBrowser({ launcher }).open(sessionInit({ proxy: SECRET_EXIT })),
    );
    expect(thrown['code']).toBe('X_SCRAPE_EGRESS_UNSUPPORTED');
    expect(thrown['retry']).toBe('terminal');
    expect(JSON.stringify(thrown)).not.toContain('hunter2hunter2');
    expect(String(thrown['cause'])).toContain('http://exit-7.test:8080');
    expect(fake.closed).toBe(true);
  });
});

describe('unit · caller launch args never displace the exit', () => {
  const CONTAINER_ARGS = ['--no-sandbox', '--disable-dev-shm-usage'];

  test('the container flags and the proxy flag both reach the launcher, the proxy last', async () => {
    const { launcher, launched } = recordingLauncher();
    const session = await localBrowser({
      launcher,
      proxy: EXIT,
      options: { args: CONTAINER_ARGS, protocolTimeout: 5_000 },
    }).open(sessionInit());
    expect(launched[0]?.['args']).toEqual([...CONTAINER_ARGS, `--proxy-server=${EXIT}`]);
    expect(launched[0]?.['protocolTimeout']).toBe(5_000);
    expect(session.proxy).toBe(EXIT);
    await session.close();
  });

  test("the run's exit is appended after caller args too", async () => {
    const { launcher, launched } = recordingLauncher();
    const session = await localBrowser({ launcher, options: { args: CONTAINER_ARGS } }).open(
      sessionInit({ proxy: SECRET_EXIT }),
    );
    expect(launched[0]?.['args']).toEqual([...CONTAINER_ARGS, `--proxy-server=${EXIT}`]);
    await session.close();
  });

  test('with no exit at all, caller args pass through untouched', async () => {
    const { launcher, launched } = recordingLauncher();
    const session = await localBrowser({ launcher, options: { args: CONTAINER_ARGS } }).open(
      sessionInit(),
    );
    expect(launched[0]?.['args']).toEqual(CONTAINER_ARGS);
    await session.close();
  });

  test('no exit and no caller args puts no args key on the launch at all', async () => {
    const { launcher, launched } = recordingLauncher();
    const session = await localBrowser({ launcher }).open(sessionInit());
    expect(Object.hasOwn(launched[0] ?? {}, 'args')).toBe(false);
    await session.close();
  });

  // Every switch Chrome reads a proxy decision from, in both prefix spellings POSIX Chrome accepts,
  // with and without a configured exit: a caller-set exit the session never reports is the same
  // two-identities defect as a dropped one.
  const OWNED = [
    '--proxy-server=http://other.test:1',
    '-proxy-server=http://other.test:1',
    '--PROXY-SERVER=http://other.test:1',
    '--proxy-bypass-list=*',
    '--proxy-pac-url=http://pac.test/p.pac',
    '--proxy-auto-detect',
    '--no-proxy-server',
  ];
  for (const flag of OWNED) {
    for (const proxy of [EXIT, undefined]) {
      test(`${flag} in caller args is refused before launch (exit ${proxy ?? 'none'})`, async () => {
        const { launcher, launched } = recordingLauncher();
        const thrown = await codeOf(() =>
          localBrowser({ launcher, proxy, options: { args: ['--no-sandbox', flag] } }).open(
            sessionInit(),
          ),
        );
        expect(thrown['code']).toBe('X_SCRAPE_LAUNCH_ARGS_INVALID');
        expect(thrown['retry']).toBe('terminal');
        expect(thrown['fix']).toBe(
          "grep -rnE --include='*.ts' -e 'localBrowser\\(' -e '--(no-)?proxy-' .",
        );
        expect(String(thrown['cause'])).not.toContain('other.test');
        expect(launched).toEqual([]);
      });
    }
  }

  test('a flag that merely mentions a proxy in its VALUE is not refused', async () => {
    const { launcher, launched } = recordingLauncher();
    const args = ['--user-agent=proxy-server-test'];
    const session = await localBrowser({ launcher, options: { args } }).open(sessionInit());
    expect(launched[0]?.['args']).toEqual(args);
    await session.close();
  });

  for (const args of ['--no-sandbox', ['--no-sandbox', 7], { 0: '--no-sandbox' }, null]) {
    test(`args that are not a string array (${JSON.stringify(args)}) are refused`, async () => {
      const { launcher, launched } = recordingLauncher();
      const thrown = await codeOf(() =>
        localBrowser({ launcher, proxy: EXIT, options: { args } }).open(sessionInit()),
      );
      expect(thrown['code']).toBe('X_SCRAPE_LAUNCH_ARGS_INVALID');
      expect(launched).toEqual([]);
    });
  }
});

describe('unit · an attached browser already bound to an exit refuses a different one', () => {
  test('a fixed cdpUrl handed another exit is X_SCRAPE_EGRESS_UNSUPPORTED before any attach', async () => {
    const { launcher, connected } = recordingLauncher();
    const thrown = await codeOf(() =>
      remoteBrowser({ launcher, cdpUrl: 'ws://browser.test/1', proxy: 'http://bound.test:1' }).open(
        sessionInit({ proxy: SECRET_EXIT }),
      ),
    );
    expect(thrown['code']).toBe('X_SCRAPE_EGRESS_UNSUPPORTED');
    expect(connected).toEqual([]);
    expect(JSON.stringify(thrown)).not.toContain('hunter2hunter2');
  });

  test('the exit it is already bound to is accepted', async () => {
    const { launcher } = recordingLauncher();
    const session = await remoteBrowser({
      launcher,
      cdpUrl: 'ws://browser.test/1',
      proxy: EXIT,
    }).open(sessionInit({ proxy: EXIT }));
    expect(session.proxy).toBe(EXIT);
    await session.close();
  });
});

// One e2e run over doubles: the app and the browser are fakes, Bun's hooks are captured, and what
// is asserted is the run's own contract — the page it installs follows the CURRENT browser, a
// deploy or a hung browser is relaunched before the next test, and everything is released after.
import { afterEach, describe, expect, test } from 'bun:test';
import type { E2eBrowser } from './cdp-browser';
import { E2E_BROWSER_CLOSE_MS, E2E_BROWSER_OPEN_MS } from './cdp-browser';
import type { E2eApp } from './e2e-app';
import { e2eApp, e2eBaseUrl, e2eBrowser } from './e2e-browser-handle';
import type { E2eDriverOptions } from './e2e-driver';
import { startE2eRun } from './e2e-run';
import { E2E_APP_STOP_MS } from './e2e-spawn';
import { withFailureContext } from './failure-context';

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.e2e.run'));
});

/** A browser whose page records every call and answers `evaluate` with `answer`. */
function fakeBrowser(name: string, answer: () => Promise<unknown> = async () => 1) {
  const calls: string[] = [];
  let closed = 0;
  const page = {
    url: () => `${name}:url`,
    goto: async (url: string) => {
      calls.push(`goto ${url}`);
    },
    evaluate: (expression: string) => {
      calls.push(`evaluate ${expression}`);
      return answer();
    },
    click: async (selector: string) => {
      calls.push(`click ${selector}`);
    },
    offline: async (enabled: boolean) => {
      calls.push(`offline ${String(enabled)}`);
    },
  };
  const browser = {
    page,
    session: {},
    // Counted only once the reap has FINISHED: a run that starts a close and moves on leaves a
    // Chrome beside the next launch, and reads here as never closed.
    close: async () => {
      await Bun.sleep(5);
      closed += 1;
    },
  } as unknown as E2eBrowser;
  return { browser, calls, closedCount: () => closed };
}

function harness(browsers: ReturnType<typeof fakeBrowser>[]) {
  const restarts: (Readonly<Record<string, string>> | undefined)[] = [];
  let stopped = 0;
  const app: E2eApp = {
    base: 'http://localhost:4000',
    stateDir: '/tmp/state',
    log: () => 'GET /feed 500 X_LIVE_QUERY_UNKNOWN',
    stop: async () => {
      stopped += 1;
    },
    restart: async (env) => {
      restarts.push(env);
    },
  };
  const queue = [...browsers];
  let installed: E2eDriverOptions | undefined;
  let uninstalled = 0;
  const hooks: {
    before?: () => Promise<void>;
    after?: () => Promise<void>;
    beforeMs?: number | undefined;
    afterMs?: number | undefined;
  } = {};
  return {
    app,
    restarts,
    stoppedCount: () => stopped,
    installedOptions: () => installed,
    uninstalledCount: () => uninstalled,
    hooks,
    deps: {
      app,
      openBrowser: async () => {
        const next = queue.shift();
        if (next === undefined)
          expect.unreachable('the run opened more browsers than the test gave it');
        return next.browser;
      },
      install: (options: E2eDriverOptions) => {
        installed = options;
        return () => {
          uninstalled += 1;
        };
      },
      beforeEach: (hook: () => Promise<void>, timeoutMs?: number) => {
        hooks.before = hook;
        hooks.beforeMs = timeoutMs;
      },
      afterAll: (hook: () => Promise<void>, timeoutMs?: number) => {
        hooks.after = hook;
        hooks.afterMs = timeoutMs;
      },
      probeMs: 20,
    },
  };
}

describe('unit · one e2e run', () => {
  // Bun's 5 s hook default killed both mid-work: a relaunch's open in flight, later assigned over
  // the next relaunch's browser and never closed; a close cut short as the run exited — each a
  // Chrome profile left in the temp root.
  test('its hooks are given the designed length of what they do, never Bun’s 5 s default', async () => {
    const run = harness([fakeBrowser('first')]);
    await startE2eRun(run.deps);

    expect(run.hooks.beforeMs).toBeGreaterThanOrEqual(
      20 + E2E_BROWSER_CLOSE_MS + E2E_BROWSER_OPEN_MS,
    );
    expect(run.hooks.afterMs).toBeGreaterThanOrEqual(E2E_BROWSER_CLOSE_MS + E2E_APP_STOP_MS);
  });

  test('publishes the app and the browser, and installs a page over the app’s origin', async () => {
    const first = fakeBrowser('first');
    const run = harness([first]);
    await startE2eRun(run.deps);
    expect(e2eBaseUrl()).toBe('http://localhost:4000');
    expect(e2eApp()).toBe(run.app);
    expect(e2eBrowser()).toBe(first.browser);
    expect(run.installedOptions()?.baseUrl).toBe('http://localhost:4000');
  });

  test('the installed page drives whichever browser is current, all five members', async () => {
    const first = fakeBrowser('first');
    const run = harness([first]);
    await startE2eRun(run.deps);
    const page = run.installedOptions()?.page;
    if (page === undefined) expect.unreachable('nothing was installed');
    await page.goto('/a');
    await page.evaluate('2');
    await page.click('#b');
    await page.offline?.(true);
    expect(page.url()).toBe('first:url');
    expect(first.calls).toEqual(['goto /a', 'evaluate 2', 'click #b', 'offline true']);
  });

  test('a deploy restarts the app with a new build id, and the next test gets a new browser', async () => {
    const first = fakeBrowser('first');
    const second = fakeBrowser('second');
    const run = harness([first, second]);
    await startE2eRun(run.deps);
    await run.installedOptions()?.newBuild?.();
    expect(run.restarts[0]?.['BUILD_ID']).toStartWith('e2e-build-1-');
    await run.hooks.before?.();
    expect(first.closedCount()).toBe(1);
    expect(e2eBrowser()).toBe(second.browser);
    expect(run.installedOptions()?.page.url()).toBe('second:url');
  });

  test('a browser that answers keeps its place; one that hangs is relaunched', async () => {
    const alive = fakeBrowser('alive');
    const run = harness([alive]);
    await startE2eRun(run.deps);
    await run.hooks.before?.();
    expect(alive.closedCount()).toBe(0);

    const hung = fakeBrowser('hung', () => new Promise(() => undefined));
    const fresh = fakeBrowser('fresh');
    const second = harness([hung, fresh]);
    await startE2eRun(second.deps);
    await second.hooks.before?.();
    expect(hung.closedCount()).toBe(1);
    expect(e2eBrowser()).toBe(fresh.browser);
  });

  test('while the run lasts, a failing test carries the app’s log tail; after it, none', async () => {
    const run = harness([fakeBrowser('only')]);
    await startE2eRun(run.deps);
    const during = withFailureContext(new TypeError('the row never arrived')) as Error;
    expect(during.message).toContain('GET /feed 500 X_LIVE_QUERY_UNKNOWN');
    await run.hooks.after?.();
    const after = withFailureContext(new TypeError('later')) as Error;
    expect(after.message).toBe('later');
  });

  test('after the last test it uninstalls, closes the browser and stops the app', async () => {
    const only = fakeBrowser('only');
    const run = harness([only]);
    await startE2eRun(run.deps);
    await run.hooks.after?.();
    expect([run.uninstalledCount(), only.closedCount(), run.stoppedCount()]).toEqual([1, 1, 1]);
  });

  test('a browser that will not open stops the app it was opened for', async () => {
    const run = harness([]);
    const error = await startE2eRun({
      ...run.deps,
      openBrowser: () => Promise.reject(new TypeError('no chrome')),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(run.stoppedCount()).toBe(1);
  });
});

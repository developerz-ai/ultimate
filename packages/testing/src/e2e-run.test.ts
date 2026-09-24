// One e2e run over doubles: the app and the browser are fakes, Bun's hooks are captured, and what
// is asserted is the run's own contract — the page it installs follows the CURRENT browser, a
// deploy or a hung browser is relaunched before the next test, and everything is released after.
import { afterEach, describe, expect, test } from 'bun:test';
import type { E2eBrowser } from './cdp-browser';
import type { E2eApp } from './e2e-app';
import { e2eApp, e2eBaseUrl, e2eBrowser } from './e2e-browser-handle';
import type { E2eDriverOptions } from './e2e-driver';
import { startE2eRun } from './e2e-run';

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
    close: () => {
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
  const hooks: { before?: () => Promise<void>; after?: () => Promise<void> } = {};
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
      beforeEach: (hook: () => Promise<void>) => {
        hooks.before = hook;
      },
      afterAll: (hook: () => Promise<void>) => {
        hooks.after = hook;
      },
      probeMs: 20,
    },
  };
}

describe('unit · one e2e run', () => {
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

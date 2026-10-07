// The service-worker handover, against a recorder for the adapter's half and a fake `navigator`
// for the in-page half. The case this file exists for (#678): the FIRST page of a run is already
// committed when its worker installs, so `clients.claim()` can miss it — `ready` resolves, no
// `controllerchange` ever fires, and the whole budget went to waiting for nothing.

import { describe, expect, test } from 'bun:test';
import { runInFakePage } from './e2e-dom-fixture';
import type { E2eBrowserPage } from './e2e-page';
import { e2ePage } from './e2e-page';
import { CLAIM_GRACE_MS, serviceWorkerExpression } from './e2e-service-worker';

const BASE = 'http://127.0.0.1:3000';

interface Recorder extends E2eBrowserPage {
  readonly visited: string[];
  readonly evaluated: string[];
}

const recorder = (states: readonly string[], at = 'https://app.test/banks'): Recorder => {
  const visited: string[] = [];
  const evaluated: string[] = [];
  let turn = 0;
  return {
    visited,
    evaluated,
    url: () => at,
    goto: (url: string) => {
      visited.push(url);
      return Promise.resolve(undefined);
    },
    evaluate: (expression: string) => {
      evaluated.push(expression);
      const state = states[Math.min(turn, states.length - 1)];
      turn += 1;
      return Promise.resolve(JSON.stringify({ state }));
    },
    click: () => Promise.resolve(),
  };
};

describe('unit · waitForServiceWorker hands the first page over', () => {
  test('an unclaimed page is reloaded once, and the reload is what the worker answers', async () => {
    const browser = recorder(['unclaimed', 'controlled']);
    await e2ePage({ page: browser, baseUrl: BASE }).waitForServiceWorker();
    expect(browser.visited).toEqual(['https://app.test/banks']);
    expect(browser.evaluated).toHaveLength(2);
  });

  // A navigation to the same URL with a `#fragment` is a SAME-DOCUMENT navigation: the uncontrolled
  // document is never replaced, so the handover would reload nothing. The fragment is dropped.
  test('the reload drops a fragment, so it is a real navigation and not a scroll', async () => {
    const browser = recorder(['unclaimed', 'controlled'], 'https://app.test/banks?tab=2#row-7');
    await e2ePage({ page: browser, baseUrl: BASE }).waitForServiceWorker();
    expect(browser.visited).toEqual(['https://app.test/banks?tab=2']);
  });

  test('a page already controlled is not reloaded', async () => {
    const browser = recorder(['controlled']);
    await e2ePage({ page: browser, baseUrl: BASE }).waitForServiceWorker();
    expect(browser.visited).toEqual([]);
  });

  test('a page still uncontrolled after the reload is refused, saying it was reloaded', async () => {
    const browser = recorder(['unclaimed', 'unclaimed']);
    const error = await e2ePage({ page: browser, baseUrl: BASE })
      .waitForServiceWorker()
      .catch((e: unknown) => e);
    expect(error).toBeUltimateError('X_E2E_SERVICE_WORKER_ABSENT');
    expect((error as { cause: string }).cause).toContain('reloaded once');
    expect(browser.visited).toHaveLength(1);
  });

  // No registration at all is not a handover problem: a reload would answer the same, and the
  // fix is the build — so nothing is navigated and the refusal says where the worker comes from.
  test('no worker at all is refused without a reload', async () => {
    const browser = recorder(['absent']);
    const error = await e2ePage({ page: browser, baseUrl: BASE })
      .waitForServiceWorker()
      .catch((e: unknown) => e);
    expect(error).toBeUltimateError('X_E2E_SERVICE_WORKER_ABSENT');
    expect(browser.visited).toEqual([]);
  });

  test('a test raises the budget for the one call that needs it', async () => {
    const browser = recorder(['absent']);
    const error = await e2ePage({ page: browser, baseUrl: BASE })
      .waitForServiceWorker({ timeoutMs: 45_000 })
      .catch((e: unknown) => e);
    expect(browser.evaluated[0]).toContain('45000');
    expect((error as { cause: string }).cause).toContain('45000ms');
  });

  test('a per-call budget that is not a number is refused before the page sees it', async () => {
    const browser = recorder(['controlled']);
    await expect(
      e2ePage({ page: browser, baseUrl: BASE }).waitForServiceWorker({ timeoutMs: Number.NaN }),
    ).rejects.toThrow(/timeoutMs/);
    expect(browser.evaluated).toEqual([]);
  });
});

/** A `navigator.serviceWorker` whose worker is active and which may or may not claim the page. */
const container = (input: { controller: boolean; claimAfterMs?: number }) => {
  const listeners: (() => void)[] = [];
  const sw = {
    controller: input.controller ? {} : null,
    ready: Promise.resolve({}),
    addEventListener: (_type: string, fn: () => void) => listeners.push(fn),
  };
  if (input.claimAfterMs !== undefined) {
    setTimeout(() => {
      sw.controller = {};
      for (const fn of listeners) fn();
    }, input.claimAfterMs);
  }
  return { serviceWorker: sw };
};

describe('unit · the in-page half', () => {
  const run = async (navigator: unknown, timeoutMs = 2_000): Promise<unknown> =>
    JSON.parse(String(await runInFakePage(serviceWorkerExpression(timeoutMs), { navigator })));

  test('a controlled page answers controlled', async () => {
    expect(await run(container({ controller: true }))).toEqual({ state: 'controlled' });
  });

  test('a claim inside the grace answers controlled', async () => {
    expect(await run(container({ controller: false, claimAfterMs: 10 }))).toEqual({
      state: 'controlled',
    });
  });

  test('an active worker that never claims the page answers unclaimed, after the grace', async () => {
    const began = performance.now();
    expect(await run(container({ controller: false }))).toEqual({ state: 'unclaimed' });
    expect(performance.now() - began).toBeGreaterThanOrEqual(CLAIM_GRACE_MS - 50);
  });

  test('no registration ever ready answers absent at the deadline', async () => {
    const navigator = {
      serviceWorker: { controller: null, ready: new Promise(() => {}), addEventListener() {} },
    };
    expect(await run(navigator, 50)).toEqual({ state: 'absent' });
  });

  test('a browser with no serviceWorker answers absent rather than throwing', async () => {
    expect(await run({})).toEqual({ state: 'absent' });
  });
});

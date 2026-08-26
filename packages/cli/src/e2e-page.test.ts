// `PageLike` over a browser page: what each member ASKS the browser, and which ones refuse. The
// page is a recorder rather than a DOM — the question here is the call, not the document.

import { describe, expect, test } from 'bun:test';
import { fakeE2eDocument, runInFakePage } from './e2e-dom-fixture';
import type { E2eBrowserPage } from './e2e-page';
import { DEFAULT_SERVICE_WORKER_TIMEOUT_MS, e2ePage } from './e2e-page';

interface Recorder extends E2eBrowserPage {
  readonly visited: readonly string[];
  readonly evaluated: readonly string[];
}

const recorder = (answers: readonly unknown[] = [], at = 'https://app.test/feed'): Recorder => {
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
      const answer = answers[Math.min(turn, answers.length - 1)];
      turn += 1;
      return Promise.resolve(answer);
    },
    click: () => Promise.resolve(),
  };
};

const BASE = 'http://127.0.0.1:3000';

describe('e2e page — refusals', () => {
  test('waitForServiceWorker refuses when nothing took control', async () => {
    const page = e2ePage({
      page: recorder([JSON.stringify({ controlled: false })]),
      baseUrl: BASE,
    });
    await expect(page.waitForServiceWorker()).rejects.toThrow(/X_E2E_SERVICE_WORKER_ABSENT/);
  });

  test('the refusal names the budget it spent, so a reader knows it was bounded', async () => {
    const page = e2ePage({
      page: recorder([JSON.stringify({ controlled: false })]),
      baseUrl: BASE,
    });
    let message = '';
    try {
      await page.waitForServiceWorker();
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain(String(DEFAULT_SERVICE_WORKER_TIMEOUT_MS));
  });

  test('the wait is bounded IN THE PAGE, never by a loop here', async () => {
    const browser = recorder([JSON.stringify({ controlled: true })]);
    await e2ePage({ page: browser, baseUrl: BASE }).waitForServiceWorker();
    expect(browser.evaluated[0]).toContain('setTimeout');
    expect(browser.evaluated).toHaveLength(1);
  });

  test('a browser with no serviceWorker answers false rather than throwing in the page', async () => {
    const browser = recorder([JSON.stringify({ controlled: true })]);
    await e2ePage({ page: browser, baseUrl: BASE }).waitForServiceWorker();
    // The expression the driver built, run against a `navigator` that has no `serviceWorker` —
    // a browser with the feature disabled, which must refuse rather than raise `undefined is not
    // an object` and arrive labelled a dead socket.
    const raw = await runInFakePage(browser.evaluated[0] ?? '', { navigator: {} });
    expect(JSON.parse(String(raw))).toEqual({ controlled: false });
  });
});

describe('e2e page — navigation', () => {
  test('a relative path is resolved against the app base url', async () => {
    const browser = recorder();
    await e2ePage({ page: browser, baseUrl: BASE }).goto('/feed');
    expect(browser.visited).toEqual([`${BASE}/feed`]);
  });

  test('an absolute url is left alone', async () => {
    const browser = recorder();
    await e2ePage({ page: browser, baseUrl: BASE }).goto('https://elsewhere.test/x');
    expect(browser.visited).toEqual(['https://elsewhere.test/x']);
  });

  test('reload re-reads the page’s OWN url rather than the one it was built with', async () => {
    const browser = recorder([], 'http://127.0.0.1:3000/posts/new');
    await e2ePage({ page: browser, baseUrl: BASE }).reload();
    expect(browser.visited).toEqual(['http://127.0.0.1:3000/posts/new']);
  });

  test('url() is the browser’s, asked every time', () => {
    const browser = recorder([], 'http://127.0.0.1:3000/feed');
    expect(e2ePage({ page: browser, baseUrl: BASE }).url()).toBe('http://127.0.0.1:3000/feed');
  });
});

describe('e2e page — the streamed shell', () => {
  test('navigates first, then reads a first chunk from inside the page', async () => {
    const browser = recorder([JSON.stringify({ html: '<h1>Acme Editorial</h1>' })]);
    const flush = await e2ePage({ page: browser, baseUrl: BASE }).gotoStreamed('/feed');
    expect(browser.visited).toEqual([`${BASE}/feed`]);
    expect(flush.html).toBe('<h1>Acme Editorial</h1>');
  });

  test('it reads ONE chunk — a whole-body read would never be a first flush', async () => {
    const browser = recorder([JSON.stringify({ html: '' })]);
    await e2ePage({ page: browser, baseUrl: BASE }).gotoStreamed('/feed');
    expect(browser.evaluated[0]).toContain('getReader().read()');
    expect(browser.evaluated[0]).not.toContain('.text()');
  });

  test('the fetch carries the page’s own credentials', async () => {
    const browser = recorder([JSON.stringify({ html: '' })]);
    await e2ePage({ page: browser, baseUrl: BASE }).gotoStreamed('/feed');
    expect(browser.evaluated[0]).toContain("credentials: 'same-origin'");
  });
});

describe('e2e page — title and locators', () => {
  test('title reads document.title', async () => {
    const browser = recorder([JSON.stringify({ title: 'Feed · Postly' })]);
    expect(await e2ePage({ page: browser, baseUrl: BASE }).title()).toBe('Feed · Postly');
  });

  test('a page that answered no title reads as empty, never as undefined', async () => {
    const browser = recorder([JSON.stringify({})]);
    expect(await e2ePage({ page: browser, baseUrl: BASE }).title()).toBe('');
  });

  test('getByRole passes its options through to the selection', async () => {
    const browser = recorder([JSON.stringify({ count: 1, visible: true, marked: false })]);
    const page = e2ePage({ page: browser, baseUrl: BASE });
    await page.getByRole('heading', { level: 1 }).count();
    expect(browser.evaluated[0]).toContain('level(el) === 1');
  });

  test('getByRole with a name resolves it against a real document', async () => {
    const browser = recorder([JSON.stringify({ count: 0, visible: false, marked: false })]);
    const page = e2ePage({ page: browser, baseUrl: BASE });
    await page.getByRole('button', { name: 'Like' }).count();
    const answer = await runInFakePage(
      browser.evaluated[0] ?? '',
      fakeE2eDocument({
        tag: 'html',
        attrs: {},
        children: [
          { tag: 'button', attrs: {}, text: 'Like' },
          { tag: 'button', attrs: {}, text: 'Share' },
        ],
      }),
    );
    expect(JSON.parse(String(answer))).toMatchObject({ count: 1, visible: true });
  });

  test('evaluate goes through the closure crossing, so a capture is refused here too', async () => {
    const wanted = { rows: 3 };
    const browser: E2eBrowserPage = {
      url: () => 'https://app.test/feed',
      goto: () => Promise.resolve(undefined),
      evaluate: (expression) => runInFakePage(expression, {}),
      click: () => Promise.resolve(),
    };
    const page = e2ePage({ page: browser, baseUrl: BASE });
    await expect(page.evaluate(() => wanted.rows === 3)).rejects.toThrow(/X_E2E_EVALUATE_CAPTURED/);
  });
});

/**
 * Both deadlines, when they are not numbers. An app's test preload is what calls
 * `installE2eDriver({ page, baseUrl, timeoutMs })`, so `Number(process.env.E2E_TIMEOUT_MS)` on an
 * unset variable is the realistic arrival — and `??` guards nullish, which `NaN` is not.
 *
 * Neither lands anywhere that refuses it. `timeoutMs` is handed to the driver, which passes it to
 * `page.goto(url, { timeout })`; `serviceWorkerTimeoutMs` is INTERPOLATED into the in-page source
 * as `setTimeout(() => resolve(false), NaN)`, which is `setTimeout(…, 0)` — so the deadline fires
 * on the next tick and every `waitForServiceWorker()` refuses with
 * `X_E2E_SERVICE_WORKER_ABSENT`, naming a budget of `NaN` for a worker that took control.
 * A misdiagnosis is worse than a failure, which is why this is refused at construction.
 */
describe('e2e page — a deadline that is not a number', () => {
  const NOT_A_BOUND = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

  interface Timed extends Recorder {
    readonly timeouts: readonly (number | undefined)[];
  }

  const timing = (answers: readonly unknown[] = []): Timed => {
    const timeouts: (number | undefined)[] = [];
    const base = recorder(answers);
    return {
      ...base,
      timeouts,
      goto: (url: string, options?: { readonly timeout?: number | undefined }) => {
        timeouts.push(options?.timeout);
        return base.goto(url);
      },
    };
  };

  test('a non-finite timeoutMs is refused before a navigation is attempted', () => {
    for (const timeoutMs of NOT_A_BOUND) {
      const page = timing();
      expect(() => e2ePage({ page, baseUrl: BASE, timeoutMs })).toThrow('X_INVARIANT');
      expect(page.timeouts).toEqual([]);
    }
  });

  test('a non-finite serviceWorkerTimeoutMs is refused, never interpolated into the page', () => {
    for (const serviceWorkerTimeoutMs of NOT_A_BOUND) {
      const page = timing();
      expect(() => e2ePage({ page, baseUrl: BASE, serviceWorkerTimeoutMs })).toThrow('X_INVARIANT');
      expect(page.evaluated).toEqual([]);
    }
  });

  // 0 is the driver's own "no deadline" — puppeteer reads `timeout: 0` as "wait forever" — so the
  // floor is 0 and not 1. Refusing it would take a documented value away from an app.
  test('a timeoutMs of 0 is accepted and reaches the driver unchanged', async () => {
    const page = timing();
    await e2ePage({ page, baseUrl: BASE, timeoutMs: 0 }).goto('/feed');
    expect(page.timeouts).toEqual([0]);
  });

  test('the deadline the caller declared is still the one the page is given', async () => {
    const page = timing([JSON.stringify({ controlled: true })]);
    const subject = e2ePage({ page, baseUrl: BASE, timeoutMs: 250, serviceWorkerTimeoutMs: 750 });
    await subject.goto('/feed');
    await subject.waitForServiceWorker();
    expect(page.timeouts).toEqual([250]);
    expect(page.evaluated[0]).toContain('750');
  });
});

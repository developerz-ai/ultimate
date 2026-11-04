/**
 * e2e — a failed island on an `app/` page reaches the server (`clientErrors: { enabled: true }` in
 * `app.config.ts`). The hydration runtime marks an island whose `mount()` rejected with
 * `data-x-failed` and swallows the rejection, so the only door is `/x-client-errors.js`'s observer:
 * the marker is set here exactly as the runtime sets it, and the report must leave the tab as ONE
 * same-origin POST, the path without its query string, accepted with 204. A `site/` page carries no
 * script at all. With the feature off there is no script and no POST, so every case fails.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { E2eApp, E2eTab } from '@ultimat3/testing';
import { DEFAULT_CDP_TIMEOUT_MS, E2E_TAB_OPEN_MS } from '@ultimat3/testing';
import type { AcceptanceBrowser } from './fixtures/postly';
import {
  ACCEPTANCE_CLOSE_MS,
  ACCEPTANCE_OPEN_MS,
  acceptanceBrowser,
  noBrowser,
  SIGN_IN_MS,
  signInAs,
  startPostly,
} from './fixtures/postly';

/**
 * The tab's own request log for the report route: `fetch` wrapped before any page script runs, so
 * the reporter's call is recorded with the body it sent and the status the server answered.
 */
const RECORD_REPORTS = `(() => {
  const real = window.fetch.bind(window);
  window.__reports = [];
  window.fetch = (input, init) => {
    const answer = real(input, init);
    if (String(input) === '/_client-errors') {
      const entry = { body: init && init.body, status: 0 };
      window.__reports.push(entry);
      answer.then((response) => { entry.status = response.status; }, () => { entry.status = -1; });
    }
    return answer;
  };
})()`;

/** What `hydrate.ts` does to an island whose `mount()` rejected, done to the first island. */
const FAIL_FIRST_ISLAND = `document.querySelector('[data-x-island]').setAttribute('data-x-failed', 'mount threw')`;

describe.skipIf(noBrowser)('browser failures reach the server', () => {
  let app: E2eApp;
  let browser: AcceptanceBrowser;
  let tab: E2eTab;

  beforeAll(
    async () => {
      app = await startPostly();
      browser = await acceptanceBrowser(RECORD_REPORTS);
      await signInAs(browser.session, app, 'ada');
      tab = await browser.session.newTab();
    },
    ACCEPTANCE_OPEN_MS + SIGN_IN_MS + E2E_TAB_OPEN_MS,
  );

  afterAll(async () => {
    await tab?.close();
    await browser?.close();
    await app?.stop();
  }, ACCEPTANCE_CLOSE_MS + DEFAULT_CDP_TIMEOUT_MS);

  test('a failed island on an app/ page is one POST, its path bare, accepted', async () => {
    await tab.goto(`${app.base}/settings?tab=profile`);
    await tab.waitFor(
      `document.querySelector('script[src="/x-client-errors.js"]') !== null && document.readyState === 'complete' && document.querySelector('[data-x-island]') !== null`,
      'the settings page and its reporter',
    );
    await tab.evaluate(FAIL_FIRST_ISLAND);
    await tab.waitFor(
      'window.__reports.length === 1 && window.__reports[0].status !== 0',
      'the report',
    );
    const [report] = (await tab.evaluate('window.__reports')) as readonly {
      readonly body: string;
      readonly status: number;
    }[];
    expect(report?.status).toBe(204);
    const sent = JSON.parse(report?.body ?? '{}') as Record<string, unknown>;
    expect(sent['kind']).toBe('island');
    expect(sent['message']).toBe('mount threw');
    expect(sent['path']).toBe('/settings');
    expect(typeof sent['island']).toBe('string');
    expect(sent['build']).not.toBe('');
  }, 60_000);

  test('a site/ page names no reporter', async () => {
    await tab.goto(`${app.base}/pricing`);
    await tab.waitFor(`document.readyState === 'complete'`, 'the pricing page');
    expect(
      await tab.evaluate(`document.querySelector('script[src="/x-client-errors.js"]') === null`),
    ).toBe(true);
  }, 60_000);
});

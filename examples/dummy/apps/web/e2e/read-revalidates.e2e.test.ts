/**
 * e2e — plan 101 slice 41, done-when #1: a declared read answers 304 across a real browser reload.
 * `postRecord` is `etag: true`, so the like island's seed read is stored `private, no-cache`, and
 * the reload's read goes back to the server with `If-None-Match` and comes home bodiless. No code in
 * `useQuery` does this — the browser's own cache revalidates, which is the claim under test.
 *
 * Read off Resource Timing, the one view of the HTTP cache a page has: `transferSize` is the bytes
 * that crossed the wire, the spec's flat 300 for headers plus the body. A 304 is exactly 300 with
 * the full `encodedBodySize` still handed to the island — from the browser's copy, not the network.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { E2eApp, E2eTab } from '@ultimat3/testing';
import { DEFAULT_CDP_TIMEOUT_MS, E2E_GOTO_MS, E2E_TAB_OPEN_MS } from '@ultimat3/testing';
import { everyCount, requestsSince } from './fixtures/page-reads';
import type { AcceptanceBrowser } from './fixtures/postly';
import {
  ACCEPTANCE_CLOSE_MS,
  ACCEPTANCE_OPEN_MS,
  acceptanceBrowser,
  fail,
  noBrowser,
  POSTS,
  SIGN_IN_MS,
  signInAs,
  startPostly,
} from './fixtures/postly';

/** What each document saw of its own `postRecord` reads, as JSON — a fresh document per load. */
const SEED_READS = `JSON.stringify(performance.getEntriesByType('resource')
  .filter((entry) => entry.name.includes('/_x/query/post-record'))
  .map((entry) => ({ wire: entry.transferSize, body: entry.encodedBodySize })))`;

/** The spec's fixed header size: what `transferSize` adds for a response that crossed the wire. */
const HEADER_BYTES = 300;

interface SeedRead {
  readonly wire: number;
  readonly body: number;
}

async function seedReads(tab: E2eTab): Promise<readonly SeedRead[]> {
  await tab.waitFor(`${SEED_READS} !== '[]'`, "the like island's postRecord read");
  const text = await tab.evaluate(SEED_READS);
  return typeof text === 'string'
    ? (JSON.parse(text) as readonly SeedRead[])
    : fail(`resource timing answered ${JSON.stringify(text)}, not JSON`);
}

describe.skipIf(noBrowser)('a declared read across a reload', () => {
  let app: E2eApp;
  let browser: AcceptanceBrowser;
  let tab: E2eTab;

  beforeAll(
    async () => {
      app = await startPostly();
      browser = await acceptanceBrowser();
      await signInAs(browser.session, app, 'ada');
      tab = await browser.session.newTab();
      await tab.goto(`${app.base}/posts/${POSTS.tenancy.id}`);
    },
    ACCEPTANCE_OPEN_MS + SIGN_IN_MS + E2E_TAB_OPEN_MS + E2E_GOTO_MS,
  );

  afterAll(async () => {
    await tab?.close();
    await browser?.close();
    await app?.stop();
  }, ACCEPTANCE_CLOSE_MS + DEFAULT_CDP_TIMEOUT_MS);

  test('the reload asks the server again and is answered 304, with the row from the cache', async () => {
    const [first] = await seedReads(tab);
    // Non-vacuity: the first load paid for its body, so a later 300 is a saving and not a blank.
    expect(first?.body ?? 0).toBeGreaterThan(0);
    expect(first?.wire).toBe(HEADER_BYTES + (first?.body ?? 0));

    const mark = browser.session.requests().length;
    await tab.reload();
    const [again] = await seedReads(tab);
    // It went to the server — a revalidation, never a stale copy served without asking.
    expect(
      requestsSince(browser.session, app.base, mark, /^GET .*\/_x\/query\/post-record/),
    ).toHaveLength(1);
    // Headers only on the wire, and the island still handed the whole body.
    expect(again?.wire).toBe(HEADER_BYTES);
    expect(again?.body).toBe(first?.body);
    // Bruno and kenji like Tenancy in the seed: the island shows the row the 304 confirmed.
    await tab.waitFor(everyCount(POSTS.tenancy.id, 2), 'the like count from the revalidated row');
  }, 60_000);
});

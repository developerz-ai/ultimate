/**
 * e2e — plan 101, done-when #5 and decision 8: signing out leaves NO record of the previous
 * principal — not on screen, not in the page's store, not in IndexedDB. The client scope fence
 * (`rescope()`) is what makes that true; this is the browser proving it.
 *
 * CONTRACT this assumes of slice 16: a "Sign out" control (`t('…signOut')`, already in the en
 * catalog) that ends the demo session and rescopes the page, and posts persisted per principal
 * (slice 12's `persist`), so ada has an IndexedDB database to lose. Fails until then — expected.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { E2eApp, E2eTab } from '@ultimat3/cli';
import { seedId } from '@ultimat3/entity';
import { indexedDbDump, likeCount, readFlag, readText, until } from './fixtures/page-reads';
import type { AcceptanceBrowser } from './fixtures/postly';
import { acceptanceBrowser, noBrowser, POSTS, signInAs, startPostly } from './fixtures/postly';

const ACME_TITLE = POSTS.tenancy.title;
/** What ada's records carry: her org's id on every post, her member id on her own. */
const ADA_TRACES = [POSTS.tenancy.orgId, seedId('member:ada')];
const traces = (dump: string): readonly string[] => ADA_TRACES.filter((id) => dump.includes(id));
const SIGN_OUT = `(() => {
  const control = [...document.querySelectorAll('button, a')].find((el) => /^\\s*sign out\\s*$/i.test(el.textContent ?? ''));
  if (!control) return false;
  control.click();
  return true;
})()`;
const shows = (title: string): string =>
  `document.body.textContent.includes(${JSON.stringify(title)})`;

describe.skipIf(noBrowser)('signing out', () => {
  let app: E2eApp;
  let browser: AcceptanceBrowser;
  let tab: E2eTab;

  beforeAll(async () => {
    app = await startPostly();
    browser = await acceptanceBrowser();
    await signInAs(browser.session, app, 'ada');
    tab = await browser.session.newTab();
    await tab.goto(`${app.base}/feed`);
  }, 240_000);

  afterAll(async () => {
    await tab?.close();
    browser?.close();
    await app?.stop();
  });

  test('leaves no record of the previous principal on screen or on disk', async () => {
    await tab.waitFor(`${likeCount(POSTS.tenancy.id)} !== null`, "ada's feed to render");
    // Non-vacuity: ada's records reached IndexedDB, or "none left" proves nothing.
    await until(
      async () => traces(await readText(tab, indexedDbDump)).length > 0,
      "ada's records to reach IndexedDB",
    );

    expect(await readFlag(tab, SIGN_OUT)).toBe(true);
    await tab.waitFor(`!${shows(ACME_TITLE)}`, "ada's posts to leave the screen");
    // Every row of every store, read back: nothing that names ada's org or ada survives.
    expect(traces(await readText(tab, indexedDbDump))).toEqual([]);

    // A different principal on the same tab sees only their own tenant — nothing of ada's lingers
    // in the store to be rendered on the next page.
    await signInAs(browser.session, app, 'mara');
    await tab.goto(`${app.base}/feed`);
    await tab.waitFor(`${likeCount(POSTS.offline.id)} !== null`, "mara's feed to render");
    expect(await readFlag(tab, shows(ACME_TITLE))).toBe(false);
  }, 60_000);
});

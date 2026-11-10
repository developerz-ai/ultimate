// The frame and keyboard half of the `ScrapeDriver` contract. A frame target is built by spreading
// the parent's, so a verb nobody overrode acts on the PARENT document — an iframe'd SSO login
// typing a password into the page around it. Lifted from
// `scraping/src/driver-parity-{frames,keys}.test.ts`.

import { expect } from 'bun:test';
import type { ScrapeDriverCheck } from './scrape-driver-conformance-page-checks';
import { codeOf, SCRAPE_CONFORMANCE_URLS } from './scrape-driver-conformance-site';

export const SCRAPE_FRAME_CHECKS: readonly ScrapeDriverCheck[] = [
  {
    name: 'a frame reads its OWN document, through values and query alike',
    async run({ page }) {
      await page.goto(SCRAPE_CONFORMANCE_URLS.login);
      expect((await page.frame('idp').values('#q'))[0]?.value).toBe('frame-value');
      expect((await page.frame('idp').query('#q'))[0]?.value).toBe('frame-value');
      expect((await page.query('#q'))[0]?.value).toBe('page-value');
    },
  },
  {
    name: 'fill inside a frame REPLACES the frame field and leaves the parent untouched',
    async run({ page }) {
      await page.goto(SCRAPE_CONFORMANCE_URLS.login);
      await page.frame('idp').fill('#q', 'typed');
      expect((await page.frame('idp').values('#q'))[0]?.value).toBe('typed');
      expect((await page.frame('idp').query('#q'))[0]?.value).toBe('typed');
      expect((await page.values('#q'))[0]?.value).toBe('page-value');
    },
  },
  {
    name: 'type inside a frame appends to the frame value, never the parent`s',
    async run({ page }) {
      await page.goto(SCRAPE_CONFORMANCE_URLS.login);
      await page.frame('idp').type('#q', '-more');
      expect((await page.frame('idp').values('#q'))[0]?.value).toBe('frame-value-more');
      expect((await page.values('#q'))[0]?.value).toBe('page-value');
    },
  },
  {
    name: 'select inside a frame sets the frame control, never the parent`s',
    async run({ page }) {
      await page.goto(SCRAPE_CONFORMANCE_URLS.login);
      await page.frame('idp').select('#s', ['f1']);
      expect((await page.frame('idp').values('#s'))[0]?.value).toBe('f1');
      expect((await page.values('#s'))[0]?.value).toBe('');
    },
  },
  {
    name: 'a click inside a frame leaves the PARENT where it was',
    async run({ page }) {
      await page.goto(SCRAPE_CONFORMANCE_URLS.login);
      await page.frame('idp').click('#go');
      expect(page.url()).toBe(SCRAPE_CONFORMANCE_URLS.login);
      expect((await page.values('#q'))[0]?.value).toBe('page-value');
    },
  },
  {
    name: 'focus resolves on a present control and is X_SCRAPE_SELECTOR_MISSING on a missing one',
    async run({ page }) {
      await page.goto(SCRAPE_CONFORMANCE_URLS.search);
      expect(await page.focus('#q')).toBeUndefined();
      expect(await codeOf(() => page.focus('#nothing', { timeout: 50 }))).toBe(
        'X_SCRAPE_SELECTOR_MISSING',
      );
    },
  },
  {
    name: "a well-formed chord resolves; a bad one is X_SCRAPE_KEY_INVALID — 'Ctrl' is no modifier",
    async run({ page }) {
      await page.goto(SCRAPE_CONFORMANCE_URLS.search);
      expect(await codeOf(() => page.press('Meta+K'))).toBeUndefined();
      expect(await codeOf(() => page.press('Enter'))).toBeUndefined();
      expect(await codeOf(() => page.press('Ctrl+K'))).toBe('X_SCRAPE_KEY_INVALID');
      expect(await codeOf(() => page.press('Shift+'))).toBe('X_SCRAPE_KEY_INVALID');
    },
  },
  {
    name: 'accessibility() answers the computed role and name, or is refused X_NOT_IMPLEMENTED',
    async run({ page }) {
      await page.goto(SCRAPE_CONFORMANCE_URLS.search);
      // Screened before any driver is asked, whichever kind this is.
      expect(await codeOf(() => page.accessibility('#go', { max: Number.NaN }))).toBe(
        'X_INVARIANT',
      );
      expect(await codeOf(() => page.accessibility('#go', { max: 0 }))).toBe('X_INVARIANT');
      const refused = await codeOf(() => page.accessibility('#go'));
      if (refused !== undefined) {
        // An offline driver refuses rather than reading `role=` off the markup and inventing one.
        expect(refused).toBe('X_NOT_IMPLEMENTED');
        return;
      }
      expect(await page.accessibility('#go')).toMatchObject([
        { role: 'button', name: 'Run search' },
      ]);
    },
  },
];

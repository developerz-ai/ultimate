// The page half of the `ScrapeDriver` contract: the read vocabulary, clicks, the allow list on both
// legs, and the members an offline driver must REFUSE by name rather than fake. Lifted from
// `scraping/src/driver-parity.test.ts`, where each held only for the three drivers that file named.

import { expect } from 'bun:test';
import type { ScrapeSession } from '@ultimat3/scraping';
import { codeOf, SCRAPE_CONFORMANCE_URLS } from './scrape-driver-conformance-site';

export interface ScrapeDriverCheck {
  readonly name: string;
  run(session: ScrapeSession): Promise<void>;
}

export const SCRAPE_PAGE_CHECKS: readonly ScrapeDriverCheck[] = [
  {
    name: 'text, values and count read the document',
    async run({ page }) {
      await page.goto(SCRAPE_CONFORMANCE_URLS.orders);
      expect(await page.text('#title')).toBe('Orders');
      expect(await page.count('.row')).toBe(2);
      const rows = await page.values('.row');
      expect(rows.map((row) => [row.text, row.attrs['data-id']])).toEqual([
        ['One', '1'],
        ['Two', '2'],
      ]);
    },
  },
  {
    name: 'query answers every match with visible and enabled; no match is [], never a refusal',
    async run({ page }) {
      await page.goto(SCRAPE_CONFORMANCE_URLS.orders);
      expect((await page.query('.row')).map((row) => row.attrs['data-id'])).toEqual(['1', '2']);
      expect((await page.query('#pay'))[0]?.enabled).toBe(false);
      expect((await page.query('#hidden'))[0]?.visible).toBe(false);
      expect((await page.query('#title'))[0]?.visible).toBe(true);
      expect(await page.query('#nothing')).toEqual([]);
    },
  },
  {
    name: 'a click that navigates lands on the next page, and url() follows it',
    async run({ page }) {
      await page.goto(SCRAPE_CONFORMANCE_URLS.orders);
      expect(page.url()).toBe(SCRAPE_CONFORMANCE_URLS.orders);
      // Read again after an operation that navigates nothing: a url() refreshed only by a wait.
      expect(await page.text('#title')).toBe('Orders');
      expect(page.url()).toBe(SCRAPE_CONFORMANCE_URLS.orders);
      await page.click('#next');
      expect([page.url(), await page.text('#title')]).toEqual([
        SCRAPE_CONFORMANCE_URLS.second,
        'Page two',
      ]);
    },
  },
  {
    name: 'a multi-match selector clicks the FIRST match',
    async run({ page }) {
      await page.goto(SCRAPE_CONFORMANCE_URLS.orders);
      // The second `.go` points at a page the site does not have.
      await page.click('.go');
      expect(await page.text('#title')).toBe('Page two');
    },
  },
  {
    name: 'a disabled control is X_SCRAPE_NOT_ACTIONABLE; a missing one X_SCRAPE_SELECTOR_MISSING',
    async run({ page }) {
      await page.goto(SCRAPE_CONFORMANCE_URLS.orders);
      expect(await codeOf(() => page.click('#pay', { timeout: 50 }))).toBe(
        'X_SCRAPE_NOT_ACTIONABLE',
      );
      expect(await codeOf(() => page.waitFor('#nothing', { timeout: 50 }))).toBe(
        'X_SCRAPE_SELECTOR_MISSING',
      );
    },
  },
  {
    name: 'a host the allow list does not name is X_SCRAPE_HOST_BLOCKED on BOTH legs',
    async run({ page, http }) {
      expect(await codeOf(() => page.goto('https://evil.test/'))).toBe('X_SCRAPE_HOST_BLOCKED');
      expect(await codeOf(() => http.request('https://evil.test/api'))).toBe(
        'X_SCRAPE_HOST_BLOCKED',
      );
    },
  },
  {
    name: 'the HTTP leg answers the site`s endpoint in the same session as the page',
    async run({ page, http }) {
      await page.goto(SCRAPE_CONFORMANCE_URLS.orders);
      const response = await http.request(SCRAPE_CONFORMANCE_URLS.api);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ orders: [{ id: 1 }] });
    },
  },
  {
    name: 'pageErrors() answers, empty on a page that threw nothing',
    async run({ page }) {
      await page.goto(SCRAPE_CONFORMANCE_URLS.orders);
      expect([page.pageErrors(), page.pageErrorsDropped()]).toEqual([[], 0]);
    },
  },
  {
    name: 'offline(true) cuts the browser off or is refused X_NOT_IMPLEMENTED — never a no-op',
    async run({ page }) {
      await page.goto(SCRAPE_CONFORMANCE_URLS.orders);
      const refused = await codeOf(() => page.offline(true));
      if (refused !== undefined) {
        expect(refused).toBe('X_NOT_IMPLEMENTED');
        return;
      }
      // Set: then the browser must actually fail a navigation, or a test proved nothing offline.
      expect(await codeOf(() => page.goto(SCRAPE_CONFORMANCE_URLS.second))).not.toBeUndefined();
      await page.offline(false);
    },
  },
];

/**
 * e2e — the pricing page is ISR and varies on ONE query parameter, `currency`. Each currency is its
 * own stored document; anything else in the query string is the same one.
 *
 * `revalidate: { query: [] }` on this route made every currency a single stored page: the first
 * visitor's, answered to everyone after. No browser: the verdict is the served document.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BILLING_CURRENCIES } from '@postly/domain';
import type { E2eApp } from '@ultimat3/testing';
import { E2E_APP_START_MS, E2E_APP_STOP_MS } from '@ultimat3/testing';
import { startPostly } from './fixtures/postly';

/** The currencies a document's structured data quotes its offers in. */
const quoted = (body: string): readonly string[] => [
  ...new Set([...body.matchAll(/"priceCurrency":"([A-Z]{3})"/g)].map((match) => match[1] ?? '')),
];

describe('the pricing page, per currency', () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startPostly();
  }, E2E_APP_START_MS);

  afterAll(async () => {
    await app?.stop();
  }, E2E_APP_STOP_MS);

  const page = async (query: string): Promise<string> =>
    (await fetch(`${app.base}/pricing${query}`)).text();

  test('two currencies are two documents, in whichever order they are asked for', async () => {
    // Every currency once, then again in reverse: a single stored page would answer the first
    // one's document to all of them.
    for (const currency of [...BILLING_CURRENCIES, ...[...BILLING_CURRENCIES].reverse()]) {
      const body = await page(`?currency=${currency}`);
      expect({ currency, quoted: quoted(body) }).toEqual({ currency, quoted: [currency] });
    }
  });

  test('a parameter the page does not vary on is the same stored document', async () => {
    const [currency] = BILLING_CURRENCIES;
    const tracked = await page(`?utm_source=mail&currency=${currency}`);
    expect(quoted(tracked)).toEqual([currency]);
    // The same bytes as the page without the tracking parameter: one stored document.
    expect(tracked).toBe(await page(`?currency=${currency}`));
  });
});

/**
 * unit — the fake billing vendor both readers lean on: a feed that resumes strictly after its
 * cursor, a lag that agrees with it, and a catalog whose pages cover every price exactly once.
 */

import { expect, unitTest } from '@ultimat3/testing';
import {
  CATALOG_PAGE_SIZE,
  catalogPage,
  priceFeed,
  pricesBehind,
  VENDOR_ACCOUNT,
  VENDOR_PRICES,
  type VendorPrice,
} from './vendor';

const read = async (feed: AsyncIterable<VendorPrice>): Promise<readonly number[]> => {
  const seqs: number[] = [];
  for await (const price of feed) seqs.push(price.seq);
  return seqs;
};

const live = (): AbortSignal => new AbortController().signal;

unitTest('the feed resumes strictly after its cursor, and lag counts what is left', async () => {
  expect(await read(priceFeed(VENDOR_ACCOUNT, null, live()))).toEqual([1, 2, 3, 4, 5, 6]);
  expect(await read(priceFeed(VENDOR_ACCOUNT, 4, live()))).toEqual([5, 6]);
  expect(pricesBehind(VENDOR_ACCOUNT, 4)).toBe(2);
  expect(pricesBehind(VENDOR_ACCOUNT, null)).toBe(VENDOR_PRICES.length);
});

unitTest('an account the vendor does not know has an empty feed', async () => {
  expect(await read(priceFeed('someone-else', null, live()))).toEqual([]);
  expect(pricesBehind('someone-else', null)).toBe(0);
});

unitTest('a drained run stops reading the feed', async () => {
  const drain = new AbortController();
  drain.abort();
  await expect(read(priceFeed(VENDOR_ACCOUNT, null, drain.signal))).rejects.toThrow();
});

unitTest('the catalog pages cover every price exactly once, then end', async () => {
  const seen: number[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: Awaited<ReturnType<typeof catalogPage>> = await catalogPage(cursor, live());
    seen.push(...page.rows.map((row) => row.seq));
    cursor = page.next;
    pages += 1;
  } while (cursor !== null);
  expect(seen).toEqual(VENDOR_PRICES.map((price) => price.seq));
  expect(pages).toBe(Math.ceil(VENDOR_PRICES.length / CATALOG_PAGE_SIZE));
});

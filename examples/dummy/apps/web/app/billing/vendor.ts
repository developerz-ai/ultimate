/**
 * The billing vendor Postly prices its plans through, faked in memory: this app has no vendor
 * account, and a reference app that called one would gate on the network. Two surfaces, the two
 * a real vendor has — a change feed read from a cursor (`planPrices`, a `consumer()`), and a paged
 * catalog read once (`planCatalog`, a `backfill({ pages })`). Its prices ARE `PLAN_CATALOG`, so
 * applying either converges on the rows the seed already wrote.
 *
 * The catalog is read through the vendor's GENERATED client (`x client vendor billing`, from the
 * document committed at `apps/web/clients/billing/source.json`): every answer is parsed against
 * the vendor's declared shapes, and only the transport underneath is the in-memory fake.
 */

import type { PlanRow } from '@postly/db';
import { BILLING_CURRENCIES, PLAN_CATALOG, PLAN_CODES, priceOf } from '@postly/domain';
import { createBillingClient } from '../../clients/billing/client';
import type { Price } from '../../clients/billing/schemas';

/** The one account Postly holds with the vendor — the consumer's only key. */
export const VENDOR_ACCOUNT = 'postly';

/** One price, as the vendor publishes it: the catalog row, plus where it sits in the feed. */
export interface VendorPrice extends PlanRow {
  readonly seq: number;
}

/** The vendor's log, oldest first. `seq` from 1 is the feed's own order and the consumer's cursor. */
export const VENDOR_PRICES: readonly VendorPrice[] = PLAN_CODES.flatMap((code) =>
  BILLING_CURRENCIES.map((currency) => ({
    code,
    currency,
    monthly: priceOf(code, currency),
    seats: PLAN_CATALOG[code].seats,
  })),
).map((price, index) => ({ seq: index + 1, ...price }));

const feedOf = (account: string): readonly VendorPrice[] =>
  account === VENDOR_ACCOUNT ? VENDOR_PRICES : [];

/**
 * Every price published after `after`, then the end of the stream — a real feed stays open, and
 * `consumer()` handles both: a stream that ends is a run that returns, re-armed by its supervisor.
 */
export async function* priceFeed(
  account: string,
  after: number | null,
  signal: AbortSignal,
): AsyncGenerator<VendorPrice> {
  for (const price of feedOf(account)) {
    signal.throwIfAborted();
    if (price.seq > (after ?? 0)) yield price;
  }
}

/** How many prices `account` has not read past `after` — the consumer's declared `lag`. */
export const pricesBehind = (account: string, after: number | null): number =>
  feedOf(account).filter((price) => price.seq > (after ?? 0)).length;

/** Prices per catalog page: small, so even this catalog takes more than one. */
export const CATALOG_PAGE_SIZE = 2;

/**
 * The vendor's `GET /v1/prices`, answered in memory as its API spells a page: snake_case fields, an
 * opaque `starting_after` cursor (here the next offset) and `next_cursor: null` on the last page.
 */
const vendorHttp = async (url: string): Promise<Response> => {
  const query = new URL(url).searchParams;
  const start = Number(query.get('starting_after') ?? '0');
  const end = start + Number(query.get('limit') ?? String(CATALOG_PAGE_SIZE));
  const data: readonly Price[] = VENDOR_PRICES.slice(start, end).map((price) => ({
    seq: price.seq,
    plan: price.code,
    currency: price.currency,
    unit_amount: price.monthly.minor,
    seats: price.seats,
  }));
  return Response.json({ data, next_cursor: end < VENDOR_PRICES.length ? String(end) : null });
};

/** The one wrapper that decides how the vendor is reached: a named host, a deadline per call. */
export const billingVendor = createBillingClient({
  baseUrl: 'https://billing.invalid',
  dial: 'named',
  deadlineMs: 10_000,
  deps: { fetch: vendorHttp },
});

/** The vendor's price, in Postly's shape: a `Money` is both its minor units and its currency. */
const fromVendor = (price: Price): VendorPrice => ({
  seq: price.seq,
  code: price.plan,
  currency: price.currency,
  monthly: { minor: price.unit_amount, currency: price.currency },
  seats: price.seats,
});

/** One page of the vendor's catalog. Its cursor is opaque to Postly; `next: null` is the last page. */
export async function catalogPage(
  cursor: string | null,
  signal: AbortSignal,
): Promise<{ readonly rows: readonly VendorPrice[]; readonly next: string | null }> {
  signal.throwIfAborted();
  const page = await billingVendor.listPrices(
    { limit: CATALOG_PAGE_SIZE, ...(cursor === null ? {} : { starting_after: cursor }) },
    { signal },
  );
  return { rows: page.data.map(fromVendor), next: page.next_cursor };
}

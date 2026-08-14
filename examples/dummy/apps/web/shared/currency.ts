/**
 * Which currency a public page is priced in. It is a URL parameter, never a client-side toggle:
 * each currency is its own prerendered, indexable page.
 *
 * One rule, read from two places that must agree — the page body reads the parsed query, `meta`
 * reads the URL, because `RouteMetaContext` carries `url` and no query object. A JSON-LD offer
 * quoting a different currency from the price beside it is a structured-data lie, and two
 * hand-written ternaries is how that happens.
 */

import { BILLING_CURRENCIES, type BillingCurrency, DEFAULT_BILLING_CURRENCY } from '@postly/domain';

/** Never `assertBillingCurrency`: an unpriceable `?currency=` is a bad link, not a 500. */
export const currencyOf = (value: string | undefined): BillingCurrency =>
  BILLING_CURRENCIES.find((candidate) => candidate === value) ?? DEFAULT_BILLING_CURRENCY;

/** The same rule applied to a whole URL — what `meta` is given. */
export const currencyFromUrl = (url: string): BillingCurrency =>
  currencyOf(new URL(url).searchParams.get('currency') ?? undefined);

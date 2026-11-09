// The typed budget on a sales enquiry: read by the action in the visitor's OWN locale, so the
// receipt quotes the amount they meant — `1.234,56` on the Spanish page is twelve hundred euros,
// never 1.234 — and a reading the currency cannot hold is a 422 on this request, never a rounding.

import { jobDriver, memoryJobDriver } from '@ultimat3/jobs';
import { installJobDriver } from '@ultimat3/jobs/adapter';
import { afterEach, beforeEach, expect, unitTest } from '@ultimat3/testing';
import { contactSales } from './contact-sales';

// The install answers its own undo, which puts back whatever was installed before it.
let release = (): void => {};
beforeEach(() => {
  release = installJobDriver(memoryJobDriver());
});
afterEach(() => release());

const enquiry = {
  email: 'ada@example.test',
  plan: 'team',
  currency: 'EUR',
  message: 'Twelve seats, please.',
  locale: 'es',
} as const;

/** The one receipt job the enquiry queued: its input, as the worker will read it. */
const queued = async (): Promise<unknown> => {
  const rows = (await jobDriver()?.introspect?.list()) ?? [];
  expect(rows).toHaveLength(1);
  return rows[0]?.input;
};

unitTest('a budget typed on the Spanish page is read in Spanish', async () => {
  await contactSales.as(null, { ...enquiry, budget: '1.234,56 €' });
  expect(await queued()).toMatchObject({ budget: { minor: 123456, currency: 'EUR' } });
});

unitTest('the same characters on the English page are the English reading', async () => {
  await contactSales.as(null, { ...enquiry, currency: 'USD', locale: 'en', budget: '1,234.56' });
  expect(await queued()).toMatchObject({ budget: { minor: 123456, currency: 'USD' } });
});

unitTest('no budget, or a blank one, queues `null`', async () => {
  await contactSales.as(null, { ...enquiry, budget: '   ' });
  expect(await queued()).toMatchObject({ budget: null });
});

unitTest('a third decimal is refused before anything is queued', async () => {
  await expect(contactSales.as(null, { ...enquiry, budget: '12,345' })).rejects.toBeUltimateError(
    'X_MONEY_INPUT_INVALID',
  );
  expect((await jobDriver()?.introspect?.list()) ?? []).toEqual([]);
});

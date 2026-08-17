// One row, two surfaces. A WAL tuple folded by `entityRow` and the same physical row read back
// through `@ultimat3/entity`'s repository must produce the IDENTICAL object — a live subscriber
// and a refetch reporting different shapes for one row is the bug this file exists to catch.
// `@ultimat3/entity` is tier 2, a legal downward import, and this file never ships: `*.test.ts`
// is excluded from the tarball. Comparing against the real reader is the point — a hand-written
// expectation of what it "would" produce is the copy that drifts.

import { afterAll, expect, test } from 'bun:test';
import { clearRegistry, entity, money, postgresRepo, text, uuid } from '@ultimat3/entity';
import type { JsonValue } from './json';
import { entityRow } from './pg-entity-row';

const PRODUCT_ID = '0192f0c0-0000-7000-8000-000000000001';

const products = entity('realtime_parity_products', {
  columns: { id: uuid().primaryKey(), title: text(), price: money() },
});

afterAll(() => {
  // The registry is process-global; a leaked entry breaks an unrelated package's tests.
  clearRegistry();
});

/**
 * The narrowest `DbClient` a point read needs. Typed structurally rather than imported:
 * `@ultimat3/db` is not a dependency of this package, and the row is all the repository reads.
 */
const clientOver = (row: Readonly<Record<string, unknown>>) => ({
  query: () => Promise.resolve([row]),
  one: () => Promise.resolve(row),
  execute: () => Promise.resolve(1),
});

/** The same physical row, read the way a repository reads one. */
const throughRepository = async (
  physical: Readonly<Record<string, JsonValue>>,
): Promise<Readonly<Record<string, unknown>>> => {
  const repo = postgresRepo(products, { client: clientOver(physical) });
  const row = await repo.findById(PRODUCT_ID);
  expect(row).not.toBeNull();
  return row as Readonly<Record<string, unknown>>;
};

const priceOf = (row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> =>
  row['price'] as Readonly<Record<string, unknown>>;

test('a scaled amount is one object on both surfaces', async () => {
  const physical: Record<string, JsonValue> = {
    id: PRODUCT_ID,
    title: 'widget',
    price_minor: '2',
    price_currency: 'USD',
    price_scale: 6,
  };

  const live = entityRow(physical);
  const stored = await throughRepository(physical);

  // Both sides absolutely, so the two cannot fail open together and still agree.
  expect(live).toStrictEqual({
    id: PRODUCT_ID,
    title: 'widget',
    price: { minor: 2, currency: 'USD', scale: 6 },
  });
  expect(stored).toStrictEqual({
    id: PRODUCT_ID,
    title: 'widget',
    price: { minor: 2, currency: 'USD', scale: 6 },
  });
  expect(live).toStrictEqual(stored);
});

test('an unscaled amount carries no scale key on either surface', async () => {
  // NULL is what every row written before the column existed holds, and `0` is a different value:
  // it means whole units, a 100x reinterpretation of an ordinary price.
  const physical: Record<string, JsonValue> = {
    id: PRODUCT_ID,
    title: 'widget',
    price_minor: 1990,
    price_currency: 'USD',
    price_scale: null,
  };

  const live = entityRow(physical);
  const stored = await throughRepository(physical);

  expect(live).toStrictEqual({
    id: PRODUCT_ID,
    title: 'widget',
    price: { minor: 1990, currency: 'USD' },
  });
  expect(Object.hasOwn(priceOf(live), 'scale')).toBe(false);
  expect(Object.hasOwn(priceOf(stored), 'scale')).toBe(false);
  expect(live).toStrictEqual(stored);
});

test('a projection that left the scale column out reads as no scale, not as zero', async () => {
  const physical: Record<string, JsonValue> = {
    id: PRODUCT_ID,
    title: 'widget',
    price_minor: 1990,
    price_currency: 'USD',
  };

  const live = entityRow(physical);
  const stored = await throughRepository(physical);

  expect(priceOf(live)).toStrictEqual({ minor: 1990, currency: 'USD' });
  expect(Object.hasOwn(priceOf(stored), 'scale')).toBe(false);
  expect(live).toStrictEqual(stored);
});

test('the scale column never survives as a property of its own', async () => {
  const physical: Record<string, JsonValue> = {
    id: PRODUCT_ID,
    title: 'widget',
    price_minor: 2,
    price_currency: 'USD',
    price_scale: 6,
  };

  const live = entityRow(physical);
  const stored = await throughRepository(physical);

  expect(Object.keys(live)).toEqual(['id', 'title', 'price']);
  expect(Object.keys(stored)).toEqual(['id', 'title', 'price']);
});

// `MoneyValue.scale` is persisted, not dropped: one property, THREE physical columns. Both drivers
// are here for the reason every parity file in this package exists — a rule applied to one of them
// is the drift the two-driver split prevents — and the `null` column has its own case, because
// "no explicit scale" and `scale: 0` are different values and only one of them round-trips.

import { afterAll, beforeEach, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { createRecordingClient, type RecordingClient, setDbClient } from '@ultimat3/db';
import { money, text, uuid } from './columns';
import { entity } from './entity';
import { postgresRepo } from './pg-driver';
import { bindValues, columnsOf, decodeRow } from './pg-row';
import { clearRegistry } from './registry';
import { memoryRepo } from './repo';

const invoices = entity('money_scale_invoices', {
  columns: {
    id: uuid().primaryKey(),
    label: text({ max: 40 }),
    price: money(),
  },
});

type Invoice = typeof invoices.$row;

const ID = '00000000-0000-7000-8000-000000000001';

let client: RecordingClient;

beforeEach(() => {
  client = createRecordingClient();
  setDbClient(client);
});

afterAll(() => {
  setDbClient(undefined);
  clearRegistry();
});

test('a scaled amount parses to the amount that was written, scale included', () => {
  expect(money().$parse({ minor: 2, currency: 'USD', scale: 6 })).toEqual({
    minor: 2,
    currency: 'USD',
    scale: 6,
  });
});

test('no scale stays no scale — the key is absent, never 0', () => {
  const parsed = money().$parse({ minor: 250, currency: 'USD' });
  expect(parsed).toEqual({ minor: 250, currency: 'USD' });
  expect(Object.hasOwn(parsed, 'scale')).toBe(false);
});

test('scale 0 is a value of its own and survives as one', () => {
  const parsed = money().$parse({ minor: 250, currency: 'USD', scale: 0 });
  expect(Object.hasOwn(parsed, 'scale')).toBe(true);
  expect(parsed.scale).toBe(0);
});

test('a scale outside 0…15 is refused with the column code, never stored', () => {
  let code = 'resolved';
  try {
    money().$parse({ minor: 2, currency: 'USD', scale: 42 });
  } catch (error) {
    code = isUltimateError(error) ? error.code : String(error);
  }
  expect(code).toBe('X_INVARIANT_VIOLATED');
});

test('money is three physical columns', () => {
  expect(columnsOf('price', money())).toEqual(['price_minor', 'price_currency', 'price_scale']);
});

test('the scale column is bound on write and null when the value carries none', () => {
  const scaled = bindValues(invoices, { price: { minor: 2, currency: 'USD', scale: 6 } });
  expect(scaled.get('price_scale')).toBe(6);

  const plain = bindValues(invoices, { price: { minor: 250, currency: 'USD' } });
  expect(plain.get('price_scale')).toBe(null);
});

test('a null scale column decodes to no scale at all, never to 0', () => {
  const row = decodeRow(invoices, {
    id: ID,
    label: 'a',
    price_minor: '250',
    price_currency: 'USD',
    price_scale: null,
  });
  expect(Object.hasOwn(row.price, 'scale')).toBe(false);
});

test('the scale column decodes back onto the value', () => {
  const row = decodeRow(invoices, {
    id: ID,
    label: 'a',
    price_minor: '2',
    price_currency: 'USD',
    // int2 arrives as a string from the driver exactly as int8 does.
    price_scale: '6',
  });
  expect(row.price).toEqual({ minor: 2, currency: 'USD', scale: 6 });
});

test('the memory driver round-trips a scaled amount', async () => {
  const repo = memoryRepo<Invoice>(invoices, []);
  await repo.insert({ id: ID, label: 'llm call', price: { minor: 16, currency: 'USD', scale: 5 } });
  const found = await repo.findById(ID);
  expect(found?.price).toEqual({ minor: 16, currency: 'USD', scale: 5 });
});

test('the postgres driver writes the scale and reads it back', async () => {
  client.on('insert into', {
    rows: [{ id: ID, label: 'llm call', price_minor: '16', price_currency: 'USD', price_scale: 5 }],
  });
  const written = await postgresRepo(invoices).insert({
    id: ID,
    label: 'llm call',
    price: { minor: 16, currency: 'USD', scale: 5 },
  });
  expect(written.price).toEqual({ minor: 16, currency: 'USD', scale: 5 });
  expect(client.texts.at(-1)).toContain('"price_scale"');
  expect(client.statements.at(-1)?.values).toContain(5);
});

test('the entity description carries the third column, so a migration emits it', () => {
  const scale = invoices.$describe().columns.find((column) => column.column === 'price_scale');
  expect(scale).toMatchObject({ kind: 'integer', notNull: false });
});

// A posted form is strings and omissions; a row is numbers, booleans, Dates and money. Each widget
// decodes its own value here, and a value that will not convert is handed on AS TYPED so the
// entity's schema refuses it against the field that carried it.

import { describe, expect, test } from 'bun:test';
import type { AdminField } from './fields';
import { currencyFieldOf, decodeForm, posted } from './form-decode';
import type { AdminResource } from './resource';

const field = (over: Partial<AdminField>): AdminField => ({
  entity: 'invoice',
  name: 'title',
  type: 'text',
  widget: 'text-input',
  labelKey: 'admin.invoice.field.title',
  required: true,
  readOnly: false,
  sensitive: false,
  inList: true,
  filterable: false,
  sortable: false,
  searchable: false,
  ...over,
});

const resourceOf = (
  formFields: readonly AdminField[],
  secretFields: readonly AdminField[] = [],
): AdminResource => ({ formFields, secretFields }) as unknown as AdminResource;

const decode = (over: Partial<AdminField>, form: Record<string, unknown>): unknown =>
  decodeForm(resourceOf([field(over)]), form)[over.name ?? 'title'];

describe('unit · posted()', () => {
  test('a repeated name is its LAST value; an absent or non-text one is undefined', () => {
    expect(posted({ a: 'x' }, 'a')).toBe('x');
    expect(posted({ a: ['x', 'y'] }, 'a')).toBe('y');
    expect(posted({}, 'a')).toBeUndefined();
    expect(posted({ a: 7 }, 'a')).toBeUndefined();
    // An inherited member is not a posted field.
    expect(posted({}, 'toString')).toBeUndefined();
  });
});

describe('unit · decodeForm, per widget', () => {
  test('text passes through; empty is "" for a required column and null for a nullable one', () => {
    expect(decode({}, { title: 'Hello' })).toBe('Hello');
    expect(decode({}, { title: '' })).toBe('');
    expect(decode({ required: false }, { title: '' })).toBeNull();
    expect(decode({ required: false }, {})).toBeNull();
  });

  // `''` is a value only for a column that holds text. For money, a number, an instant or JSON an
  // empty box is NO value, required or not: the schema then says "required" against the field —
  // and the refused form re-renders. A required money field left empty decoded to `''`, and the
  // 422 that should have named it was a 500 out of the money widget instead.
  test('an empty box of a typed widget is null, required or not — never the empty string', () => {
    for (const typed of [
      { widget: 'money', type: 'money', name: 'price' },
      { widget: 'number-input', type: 'number', name: 'price' },
      { widget: 'datetime', type: 'timestamptz', name: 'price' },
      { widget: 'json-editor', type: 'json', name: 'price' },
    ] as const) {
      expect([typed.widget, decode(typed, { price: '' })]).toEqual([typed.widget, null]);
      expect([typed.widget, decode(typed, {})]).toEqual([typed.widget, null]);
    }
  });

  test('a checkbox is its PRESENCE — an unchecked box posts nothing at all', () => {
    const box = { widget: 'checkbox', type: 'boolean', name: 'paid' } as const;
    expect(decode(box, { paid: 'on' })).toBe(true);
    expect(decode(box, {})).toBe(false);
    expect(decode(box, { paid: 'false' })).toBe(false);
  });

  test('a number is a number, and a non-number stays the string the schema will refuse', () => {
    const qty = { widget: 'number-input', type: 'number', name: 'qty' } as const;
    expect(decode(qty, { qty: '12' })).toBe(12);
    expect(decode(qty, { qty: '1.5' })).toBe(1.5);
    expect(decode(qty, { qty: 'twelve' })).toBe('twelve');
    expect(decode({ ...qty, required: false }, { qty: '' })).toBeNull();
  });

  test('money is BOTH halves: integer minor units and the currency posted beside them', () => {
    const total = { widget: 'money', type: 'money', name: 'total' } as const;
    expect(decode(total, { total: '1999', [currencyFieldOf('total')]: 'EUR' })).toEqual({
      minor: 1999,
      currency: 'EUR',
    });
    // No posted currency: the field's declared one, never an invented default.
    expect(decode({ ...total, currency: 'JPY' }, { total: '500' })).toEqual({
      minor: 500,
      currency: 'JPY',
    });
    expect(decode(total, { total: '500' })).toEqual({ minor: 500, currency: '' });
    expect(decode({ ...total, required: false }, { total: '' })).toBeNull();
  });

  test('a datetime-local value is read as the UTC instant the control says it is', () => {
    const at = { widget: 'datetime', type: 'timestamptz', name: 'at' } as const;
    const decoded = decode(at, { at: '2026-08-18T10:30' });
    expect(decoded).toBeInstanceOf(Date);
    expect(decoded instanceof Date ? decoded.toISOString() : '').toBe('2026-08-18T10:30:00.000Z');
  });

  test('a calendar date stays the YYYY-MM-DD string its column holds — no zone can move it', () => {
    expect(decode({ widget: 'datetime', type: 'date', name: 'on' }, { on: '2026-08-18' })).toBe(
      '2026-08-18',
    );
  });

  test('json is parsed; text that is not json stays the string the schema will refuse', () => {
    const meta = { widget: 'json-editor', type: 'json', name: 'meta' } as const;
    expect(decode(meta, { meta: '{"a":1}' })).toEqual({ a: 1 });
    expect(decode(meta, { meta: '{nope' })).toBe('{nope');
  });

  test('only the fields the form RENDERED are read — a stray posted name never reaches a row', () => {
    const out = decodeForm(resourceOf([field({})]), {
      title: 'x',
      role: 'admin',
      _operation: 'delete',
    });
    expect(Object.keys(out)).toEqual(['title']);
  });

  test('a sealed column rides as the text that was typed; absent is the empty string', () => {
    const token = field({ name: 'token', widget: 'secret-input', type: 'secret' });
    expect(decodeForm(resourceOf([], [token]), { token: 's3cret' })).toEqual({ token: 's3cret' });
    expect(decodeForm(resourceOf([], [token]), {})).toEqual({ token: '' });
  });
});

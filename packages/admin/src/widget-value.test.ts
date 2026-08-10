import { describe, expect, test } from 'bun:test';
import type { AdminField } from './fields';
import { widgetProps } from './widget-value';

const field = (over: Partial<AdminField>): AdminField => ({
  entity: 'invoice',
  name: 'total',
  type: 'money',
  widget: 'money',
  labelKey: 'admin.invoice.field.total',
  required: true,
  readOnly: false,
  sensitive: false,
  inList: true,
  filterable: false,
  sortable: true,
  searchable: false,
  ...over,
});

const ctx = { timeZone: 'Europe/Madrid', locale: 'es-ES' };

describe('money never renders as a float', () => {
  test('minor units and currency reach the Money widget intact', () => {
    const props = widgetProps(field({ currency: 'EUR' }), { minor: 1999, currency: 'EUR' }, ctx);
    expect(props).toEqual({
      widget: 'money',
      field: 'total',
      value: { minor: 1999, currency: 'EUR' },
    });
  });

  test('the column currency is used when the row omits it', () => {
    const props = widgetProps(field({ currency: 'JPY' }), { minor: 500 }, ctx);
    expect(props.widget).toBe('money');
    expect(props).toMatchObject({ value: { minor: 500, currency: 'JPY' } });
  });

  test('the bigint minor units money() puts on a row widen without rounding', () => {
    const props = widgetProps(field({}), { minor: 1999n, currency: 'EUR' }, ctx);
    expect(props).toEqual({
      widget: 'money',
      field: 'total',
      value: { minor: 1999, currency: 'EUR' },
    });
  });

  test('a bigint past the safe integer range is refused, never truncated', () => {
    expect(() =>
      widgetProps(field({}), { minor: 9007199254740993n, currency: 'EUR' }, ctx),
    ).toThrow(/minor units are integers/);
  });

  test('a float is refused, not rounded', () => {
    expect(() => widgetProps(field({ currency: 'EUR' }), 19.99, ctx)).toThrow(
      /money value arrived as the number/,
    );
    try {
      widgetProps(field({ currency: 'EUR' }), 19.99, ctx);
    } catch (error) {
      expect((error as { code: string }).code).toBe('X_ADMIN_FIELD_UNSUPPORTED');
    }
  });

  test('non-integer minor units are refused', () => {
    expect(() => widgetProps(field({}), { minor: 19.5, currency: 'EUR' }, ctx)).toThrow(
      /minor units are integers/,
    );
  });

  test('a missing ISO currency is refused', () => {
    expect(() => widgetProps(field({}), { minor: 100 }, ctx)).toThrow(/ISO-4217/);
  });
});

describe('timestamps never render without a zone', () => {
  const at = field({ name: 'issuedAt', type: 'timestamptz', widget: 'datetime' });

  test('the zone travels with the value', () => {
    const props = widgetProps(at, '2026-07-26T09:00:00.000Z', ctx);
    expect(props).toEqual({
      widget: 'datetime',
      field: 'issuedAt',
      value: '2026-07-26T09:00:00.000Z',
      timeZone: 'Europe/Madrid',
      precision: 'instant',
    });
  });

  test('an empty zone is refused with the fix line', () => {
    expect(() => widgetProps(at, '2026-07-26T09:00:00.000Z', { ...ctx, timeZone: '' })).toThrow(
      /IANA time zone/,
    );
    try {
      widgetProps(at, new Date(0), { ...ctx, timeZone: '   ' });
    } catch (error) {
      const thrown = error as { code: string; fix: string };
      expect(thrown.code).toBe('X_ADMIN_FIELD_UNSUPPORTED');
      expect(thrown.fix).toContain('actor.timeZone');
    }
  });

  test('a date column keeps date precision', () => {
    const day = field({ name: 'dueOn', type: 'date', widget: 'datetime' });
    expect(widgetProps(day, new Date('2026-01-02T00:00:00Z'), ctx)).toMatchObject({
      precision: 'date',
      timeZone: 'Europe/Madrid',
    });
  });
});

describe('other widgets', () => {
  test('enum options carry i18n keys, not labels', () => {
    const status = field({
      name: 'status',
      type: 'enum',
      widget: 'select',
      values: ['draft', 'sent'],
    });
    expect(widgetProps(status, 'sent', ctx)).toEqual({
      widget: 'select',
      field: 'status',
      value: 'sent',
      options: [
        { value: 'draft', labelKey: 'admin.invoice.field.status.option.draft' },
        { value: 'sent', labelKey: 'admin.invoice.field.status.option.sent' },
      ],
    });
  });
});

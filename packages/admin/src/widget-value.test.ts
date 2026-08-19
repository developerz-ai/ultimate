import { describe, expect, test } from 'bun:test';
import { isCurrencyCode } from '@ultimat3/schema';
import type { AdminField } from './fields';
import { widgetProps } from './widget-value';

/** The corpus `@ultimat3/schema`'s `money-value.test.ts` and `@ultimat3/entity`'s `columns.test.ts`
 * run their own projection against — one list, compared to by each, never to each other's
 * behaviour. `USD\n` is here for the reason it is there: `$` is end-of-input in ECMAScript and
 * end-of-line in PCRE, so a bound copied through a third dialect would accept it. */
const CURRENCY_CASES: readonly (readonly [string, boolean])[] = [
  ['USD', true],
  ['EUR', true],
  ['XBT', true],
  ['AAA', true],
  ['ZZZ', true],
  ['usd', false],
  ['UsD', false],
  ['US', false],
  ['USDD', false],
  ['US1', false],
  ['US_', false],
  ['US ', false],
  [' US', false],
  ['', false],
  ['USD\n', false],
];

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

  test('the float refusal cites a command that exists', () => {
    // Same class as the `listFields` fix: `x g migration` is not a generator, and an operator
    // reading this line pastes it and gets X_CLI_UNKNOWN_COMMAND on top of the money bug.
    try {
      widgetProps(field({ currency: 'EUR' }), 19.99, ctx);
      throw new Error('expected the money refusal');
    } catch (error) {
      const thrown = error as { fix?: string };
      expect(thrown.fix).toContain('x db gen');
      expect(thrown.fix).not.toContain('x g migration');
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

  test('the widget accepts exactly the codes isCurrencyCode accepts', () => {
    // The bound has one declaration (`CURRENCY_CODE_PATTERN`, tier 0) and this widget is one of
    // its readers, not a fourth copy. A local `/^[A-Z]{3}$/` here is only wrong once it drifts —
    // and the only place that would have shown up is a row the app stored and the admin then
    // refused to render, so the comparison is a test rather than a review comment.
    for (const [value, accepted] of CURRENCY_CASES) {
      expect([value, isCurrencyCode(value)]).toEqual([value, accepted]);
      const render = (): unknown => widgetProps(field({}), { minor: 100, currency: value }, ctx);
      if (accepted) expect(render()).toMatchObject({ value: { minor: 100, currency: value } });
      else expect(render).toThrow(/ISO-4217/);
    }
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

describe('the value guards refuse rather than render something wrong', () => {
  test('a money value that is not an object at all names the type it got', () => {
    // A repo that returned a formatted STRING: rendering it would put "€19.99" through a
    // formatter that expects minor units, and the amount on screen would be arbitrary.
    let thrown: { code?: string; cause?: string; fix?: string } = {};
    try {
      widgetProps(field({}), '19.99', ctx);
    } catch (error) {
      thrown = error as typeof thrown;
    }
    expect(thrown.code).toBe('X_ADMIN_FIELD_UNSUPPORTED');
    expect(thrown.cause).toContain('money value is a string');
    expect(thrown.fix).toContain('{ minor, currency }');
  });

  test('a boolean money value is refused the same way', () => {
    expect(() => widgetProps(field({}), true, ctx)).toThrow(
      expect.objectContaining({ code: 'X_ADMIN_FIELD_UNSUPPORTED' }),
    );
  });

  test('a timestamp stored as epoch milliseconds is widened to an ISO instant', () => {
    // Not refused: a number IS a timestamp, unlike a number that claims to be money.
    const props = widgetProps(
      field({ name: 'sentAt', type: 'timestamptz', widget: 'datetime' }),
      Date.UTC(2026, 7, 19, 12, 30),
      ctx,
    );
    expect(props).toMatchObject({
      widget: 'datetime',
      value: '2026-08-19T12:30:00.000Z',
      precision: 'instant',
    });
  });

  test('a timestamp that is neither a Date, a string nor a number is refused', () => {
    let thrown: { code?: string; cause?: string } = {};
    try {
      widgetProps(field({ name: 'sentAt', type: 'timestamptz', widget: 'datetime' }), {}, ctx);
    } catch (error) {
      thrown = error as typeof thrown;
    }
    expect(thrown.code).toBe('X_ADMIN_FIELD_UNSUPPORTED');
    expect(thrown.cause).toContain('timestamp value is a object');
  });
});

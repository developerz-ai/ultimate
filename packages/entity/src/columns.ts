// The blessed column builders. There is exactly one way to store an id, an instant, money, a
// locale and a time zone — the alternatives (float money, naive timestamps, a single implied
// currency) are the bugs this file exists to make unreachable.

import { uuid as uuidV7 } from '@ultimat3/core';
import { BARE, column, GENERATED_UUID, makeColumn, makeTimestamp } from './column';
import { invariantViolated } from './errors';
import type { Column, MoneyInput, MoneyValue, TimestampColumn, UuidColumn } from './types';

const reject = (rule: string, detail: string): never => {
  throw invariantViolated('column', rule, detail);
};

/** uuid v7: time-ordered, so a primary key index stays append-friendly. */
export const newId = (): string => uuidV7();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const parseUuid = (value: unknown): string =>
  typeof value === 'string' && UUID.test(value)
    ? value
    : reject('format', `expected a uuid, got ${String(value)}`);

export const uuid = (): UuidColumn => ({
  ...makeColumn<string, false>({ ...BARE, kind: 'uuid' }, parseUuid, false),
  // Narrower than the generic chain: a uuid key is generated when omitted, so it is the one
  // primary key an insert may leave out.
  primaryKey: () =>
    makeColumn<string, true>(
      { ...BARE, kind: 'uuid', primaryKey: true, default: GENERATED_UUID },
      parseUuid,
      true,
    ),
});

export interface TextOptions {
  /** Emits `char_length(<column>) <= max`, so Postgres refuses an over-long string too. */
  readonly max?: number;
}

export const text = (options: TextOptions = {}): Column<string> =>
  column<string>(
    'text',
    (value) =>
      typeof value === 'string' ? value : reject('type', `expected a string, got ${typeof value}`),
    options.max === undefined
      ? {}
      : { length: options.max, check: (name) => `char_length(${name}) <= ${options.max}` },
  );

export const integer = (): Column<number> =>
  column<number>('integer', (value) =>
    typeof value === 'number' && Number.isSafeInteger(value)
      ? value
      : reject('type', `expected a safe integer, got ${String(value)}`),
  );

export const boolean = (): Column<boolean> =>
  column<boolean>('boolean', (value) =>
    typeof value === 'boolean' ? value : reject('type', `expected a boolean, got ${typeof value}`),
  );

const parseInstant = (value: unknown): Date => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return reject('format', `expected a UTC instant, got ${String(value)}`);
};

/** Always `timestamptz`. UTC storage is not a per-table decision. */
export const timestamp = (): TimestampColumn =>
  makeTimestamp<false>({ ...BARE, kind: 'timestamptz' }, parseInstant, false);

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const oneOf =
  (values: readonly string[]) =>
  (name: string): string =>
    `${name} in (${values.map(quote).join(', ')})`;

/**
 * A closed set of strings, emitted as a CHECK rather than a Postgres `ENUM` type: adding a
 * variant is then a one-line migration instead of `ALTER TYPE`, which cannot run inside a
 * transaction on older servers.
 */
export const enumerated = <const V extends readonly string[]>(values: V): Column<V[number]> => {
  const allowed = new Set<string>(values);
  return column<V[number]>(
    'text',
    (value) =>
      typeof value === 'string' && allowed.has(value)
        ? value
        : reject('enum', `expected one of ${values.join(' | ')}, got ${String(value)}`),
    { values, check: oneOf(values) },
  );
};

/**
 * An absolute http(s) URL, validated on write rather than on render: a bad URL stored once is
 * served to every reader, and `<img src>` fails silently in the browser.
 */
export const url = (): Column<string> =>
  column<string>(
    'text',
    (value) => {
      if (typeof value === 'string') {
        try {
          const parsed = new URL(value);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return value;
        } catch {
          // fall through to the shared rejection so the error names the rule
        }
      }
      return reject('format', `expected an absolute http(s) URL, got ${String(value)}`);
    },
    { check: (name) => `${name} ~ '^https?://'` },
  );

const isIanaZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
};

/**
 * IANA identifiers, checked against `Intl` when the column is declared — a typo or a UTC offset
 * is a startup error rather than a row nobody can format. An offset is wrong twice a year.
 */
export const tz = <const Z extends readonly string[]>(zones: Z): Column<Z[number]> => {
  for (const zone of zones) {
    if (!isIanaZone(zone)) reject('iana-tz', `${zone} is not an IANA time zone`);
  }
  const allowed = new Set<string>(zones);
  return column<Z[number]>(
    'text',
    (value) =>
      typeof value === 'string' && allowed.has(value)
        ? value
        : reject('iana-tz', `expected one of ${zones.join(' | ')}, got ${String(value)}`),
    { values: zones, check: oneOf(zones) },
  );
};

const BCP47 = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export const locale = <const L extends readonly string[]>(locales: L): Column<L[number]> => {
  for (const tag of locales) {
    if (!BCP47.test(tag)) reject('bcp-47', `${tag} is not a BCP-47 language tag`);
  }
  const allowed = new Set<string>(locales);
  return column<L[number]>(
    'text',
    (value) =>
      typeof value === 'string' && allowed.has(value)
        ? value
        : reject('bcp-47', `expected one of ${locales.join(' | ')}, got ${String(value)}`),
    { values: locales, check: oneOf(locales) },
  );
};

const parseMinor = (value: unknown): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      return reject(
        'money-minor-units',
        `got the float ${value}; money is integer minor units — 12.34 EUR is 1234n, not 12.34`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return reject('money-minor-units', `expected integer minor units, got ${String(value)}`);
};

const parseCurrency = (value: unknown): string =>
  typeof value === 'string' && /^[A-Z]{3}$/.test(value)
    ? value
    : reject('iso-4217', `expected a 3-letter ISO-4217 code, got ${String(value)}`);

const parseMoney = (value: unknown): MoneyValue => {
  if (typeof value !== 'object' || value === null) {
    return reject('money', `expected { minor, currency }, got ${String(value)}`);
  }
  const input: Partial<MoneyInput> = value;
  return { minor: parseMinor(input.minor), currency: parseCurrency(input.currency) };
};

/**
 * One property, two physical columns: `<name>_minor bigint` and `<name>_currency char(3)`.
 * A single implied currency is a migration nobody wants to write later, and a float is a
 * rounding bug nobody wants to debug.
 */
export const money = (): Column<MoneyValue> => column<MoneyValue>('money', parseMoney);

/** The CHECK that stops a psql session writing a currency the app would refuse. */
export const currencyCheck = (currencyColumn: string): string => `${currencyColumn} ~ '^[A-Z]{3}$'`;

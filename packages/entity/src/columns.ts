// The blessed column builders. There is exactly one way to store an id, an instant, money, a
// locale and a time zone — the alternatives (float money, naive timestamps, a single implied
// currency) are the bugs this file exists to make unreachable.

import { uuid as uuidV7 } from '@ultimat3/core';
import { describeValue } from '@ultimat3/schema';
import { BARE, column, GENERATED_UUID, makeColumn, makeTimestamp } from './column';
import { invariantViolated } from './errors';
import type {
  Column,
  ColumnMap,
  MoneyInput,
  MoneyValue,
  TimestampColumn,
  UuidColumn,
} from './types';

const reject = (rule: string, detail: string): never => {
  throw invariantViolated('column', rule, detail);
};

/**
 * The rejected value, rendered as its SHAPE and never its content — `@ultimat3/schema`'s
 * `describeValue`, the same renderer every builtin validator fails through, so a column and a
 * schema describe one bad value the same way.
 *
 * WHY it is not `String(value)`: a column rejection is not a private diagnostic. It becomes
 * `X_INVARIANT_VIOLATED`'s `cause` and a `$view` issue, which `@ultimat3/http` returns to the
 * caller AND writes into the log line — and core's logger redacts by KEY, so a value baked into a
 * message has no key left to redact. `text()` on a password field wrote the mistyped password to
 * the central log index in cleartext and into the user's own network tab; a `uuid()` holding an
 * API key surrogate does the same. A column is the worse half of that pair, because the value can
 * arrive from the DATABASE — so the leak is not bounded by what someone just typed.
 *
 * `got` stays `got` and the "expected …" half is untouched: only what follows it changes.
 */
const got = (value: unknown): string => `got ${describeValue(value)}`;

/** uuid v7: time-ordered, so a primary key index stays append-friendly. */
export const newId = (): string => uuidV7();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const parseUuid = (value: unknown): string =>
  typeof value === 'string' && UUID.test(value)
    ? value
    : reject('format', `expected a uuid, ${got(value)}`);

/**
 * The one place a brand is applied. A brand is a compile-time tag with no runtime witness, so
 * there is nothing here to check that `parseUuid` has not already checked — same shape as core's
 * `parseId`, and the reason `uuid<PostId>()` needs no cast at any call site afterwards.
 */
const parseBrandedUuid = <T extends string>(value: unknown): T => parseUuid(value) as T;

/**
 * `uuid()` for a plain id, `uuid<PostId>()` to declare the brand ONCE. The brand then rides the
 * derivation — row, insert, `findById`, `update`, `delete` — so mixing two entities' ids is a
 * compile error instead of a query that silently matches nothing.
 */
export const uuid = <T extends string = string>(): UuidColumn<T> => ({
  ...makeColumn<T, false>({ ...BARE, kind: 'uuid' }, parseBrandedUuid, false),
  // Narrower than the generic chain: a uuid key is generated when omitted, so it is the one
  // primary key an insert may leave out.
  primaryKey: () =>
    makeColumn<T, true>(
      { ...BARE, kind: 'uuid', primaryKey: true, default: GENERATED_UUID },
      parseBrandedUuid,
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
      typeof value === 'string' ? value : reject('type', `expected a string, ${got(value)}`),
    options.max === undefined
      ? {}
      : { length: options.max, check: (name) => `char_length(${name}) <= ${options.max}` },
  );

export const integer = (): Column<number> =>
  column<number>('integer', (value) =>
    typeof value === 'number' && Number.isSafeInteger(value)
      ? value
      : reject('type', `expected a safe integer, ${got(value)}`),
  );

export const boolean = (): Column<boolean> =>
  column<boolean>('boolean', (value) =>
    typeof value === 'boolean' ? value : reject('type', `expected a boolean, ${got(value)}`),
  );

const parseInstant = (value: unknown): Date => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return reject('format', `expected a UTC instant, ${got(value)}`);
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
        : reject('enum', `expected one of ${values.join(' | ')}, ${got(value)}`),
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
      return reject('format', `expected an absolute http(s) URL, ${got(value)}`);
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
        : reject('iana-tz', `expected one of ${zones.join(' | ')}, ${got(value)}`),
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
        : reject('bcp-47', `expected one of ${locales.join(' | ')}, ${got(value)}`),
    { values: locales, check: oneOf(locales) },
  );
};

/**
 * The column is `bigint` and the value type is a `number`, which is the one narrowing in this
 * package that can lose information — so it is the one narrowing that refuses rather than rounds.
 *
 * `number` is not a compromise here: money is projected onto every wire this framework generates,
 * and `JSON.stringify` throws on a bigint. What the wide column buys is the ability to *hold* a
 * value written by something that is not this framework — a psql session, a backfill, another
 * service — and the honest answer to reading one back is a coded refusal naming the row, not a
 * `minor` that silently rounds and not a `bigint` that crashes the response three layers later.
 * `@ultimat3/realtime` refuses the identical value for the identical reason (`pg-entity-row.ts`),
 * so the two readers of one column agree.
 */
const parseMinor = (value: unknown): number => {
  const minor =
    typeof value === 'bigint' || (typeof value === 'string' && /^-?\d+$/.test(value))
      ? Number(value)
      : value;
  if (typeof minor !== 'number' || !Number.isFinite(minor)) {
    return reject('money-minor-units', `expected integer minor units, ${got(value)}`);
  }
  if (!Number.isInteger(minor)) {
    return reject(
      'money-minor-units',
      `got the float ${minor}; money is integer minor units — 12.34 EUR is 1234, not 12.34`,
    );
  }
  if (!Number.isSafeInteger(minor)) {
    return reject(
      'money-minor-units',
      `${String(value)} is past ±2^53 and no JS number holds it exactly — money is minor units ` +
        'inside that range; store the overflow in its own column or split the amount',
    );
  }
  return minor;
};

const parseCurrency = (value: unknown): string =>
  typeof value === 'string' && /^[A-Z]{3}$/.test(value)
    ? value
    : reject('iso-4217', `expected a 3-letter ISO-4217 code, ${got(value)}`);

const parseMoney = (value: unknown): MoneyValue => {
  if (typeof value !== 'object' || value === null) {
    return reject('money', `expected { minor, currency }, ${got(value)}`);
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

/**
 * Money is the one column whose write type is wider than its row type — `MoneyInput` takes a
 * `bigint` so a minor unit read straight off a `bigint` column needs no conversion at the call
 * site — so it is the one column where "the caller's value" and "the row's value" can differ.
 * This is where they stop differing, and BOTH drivers call it: `bindValues` before a statement,
 * `memoryRepo`'s `write` before it stores. A rule applied to one of them and not the other is
 * exactly the drift the two-driver split exists to prevent — here it would mean an in-memory row
 * holding a `bigint` that `JSON.stringify` refuses while the Postgres row holds a `number`.
 *
 * Every other kind is returned untouched: writes are asserted, not parsed, and money is the only
 * kind that widens. A value already holding safe-integer minor units is left alone — that is the
 * overwhelmingly common case and it costs one `typeof`-grade check and no allocation (axiom 6);
 * everything else goes through `parseMinor`, so a `bigint` narrows and a float is refused with
 * the same message it would get coming back from the database.
 */
export const narrowMoney = <Row>(columns: ColumnMap, row: Row): Row => {
  let narrowed: Record<string, unknown> | undefined;
  const record = row as Readonly<Record<string, unknown>>;
  for (const [property, column] of Object.entries(columns)) {
    if (column.$meta.kind !== 'money') continue;
    const value = record[property] as Partial<MoneyInput> | null | undefined;
    if (value === null || value === undefined || Number.isSafeInteger(value.minor)) continue;
    // Spread rather than rebuild: `currency` is the column's to validate on read and Postgres's
    // to CHECK on write, and narrowing a minor unit is not the place to start refusing one.
    narrowed ??= { ...record };
    narrowed[property] = { ...value, minor: parseMinor(value.minor) };
  }
  return (narrowed ?? row) as Row;
};

/** The CHECK that stops a psql session writing a currency the app would refuse. */
export const currencyCheck = (currencyColumn: string): string => `${currencyColumn} ~ '^[A-Z]{3}$'`;

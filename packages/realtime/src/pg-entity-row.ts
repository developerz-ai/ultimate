// Physical Postgres row -> entity-row shaping: snake_case columns become camelCase properties,
// and a `<p>_minor` / `<p>_currency` column pair folds into one `<p>: Money`-shaped property.
// The inverse of the camelCasing here is `@ultimat3/entity`'s `column.ts#snake` — not imported
// (a tier-3 package may not reach across to tier-2), so the round trip is pinned by a test instead.

import { describeValue } from '@ultimat3/core';
import { ReplicationProtocolError } from './errors';
import type { JsonObject, JsonValue } from './json';

/** `org_id` -> `orgId`, `published_at` -> `publishedAt`. The inverse of `@ultimat3/entity`'s `snake()`. */
export function camel(column: string): string {
  const [head = '', ...tail] = column.split('_');
  return head + tail.map(capitalize).join('');
}

/** A leading, trailing, or doubled underscore produces an empty part; it contributes nothing. */
function capitalize(part: string): string {
  return part.charAt(0).toUpperCase() + part.slice(1);
}

interface MoneyPair {
  readonly property: string;
  readonly minorKey: string;
  readonly currencyKey: string;
  readonly minor: number;
  readonly currency: string;
}

/** `price_minor` / `price_currency` -> `price`; any other column name has no money prefix. */
function moneyPrefix(column: string): string | null {
  if (column.endsWith('_minor')) return column.slice(0, -'_minor'.length);
  if (column.endsWith('_currency')) return column.slice(0, -'_currency'.length);
  return null;
}

/**
 * `Money` is `{ minor: number; currency: string }` everywhere in the framework, so `minor` is
 * normalised here rather than passed through: `pgoutput` decodes an int8 as text once it leaves
 * `Number.isSafeInteger` range and a numeric as text always, which would otherwise make one column
 * a number on one row and a string on the next. A value no JS number holds exactly is not money
 * this pipeline can carry, and saying so is better than shipping a `minor` the contract forbids.
 */
function moneyMinor(column: string, value: number | string): number {
  const minor =
    typeof value === 'number' ? value : /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
  if (Number.isSafeInteger(minor)) return minor;
  throw new ReplicationProtocolError({
    stage: 'value',
    detail: `column "${column}" carries ${shownMinor(value)}, which is not a whole number of minor units`,
    fix: `store ${column} as a bigint inside ±2^53 — Money.minor is a number, never a float or a bigint`,
  });
}

/**
 * **Paired with `parseMinor` in `@ultimat3/entity`'s `columns.ts`, and the pairing is the rule
 * rather than the spelling: an amount may be echoed when it is *provably numeric*, and this file
 * has to prove it at run time because entity proves it from the branch.**
 *
 * Entity reaches its echo only on a value already narrowed to a finite non-integer `number`, a
 * `bigint`, or a `/^-?\d+$/` string. Here the value came off the WAL, and a `<p>_minor` pair is
 * matched by column *name*: any `text` column called `note_minor` beside `note_currency` routes
 * arbitrary user content through this throw. `"${value}"` on that path is the leak
 * `describeValue` exists for — the message is built before any field-level redaction can see it,
 * and it reaches the log store and the operator alike.
 *
 * So the amount survives when its content is a number (a float, an out-of-range integer, or a
 * string that *is* one), and everything else is reported as shape.
 */
function shownMinor(value: number | string): string {
  if (typeof value === 'number') return `"${value}"`;
  const numeric = value.trim() !== '' && Number.isFinite(Number(value));
  return numeric ? `"${value}"` : describeValue(value);
}

/**
 * `name` is one half of a `<p>_minor` / `<p>_currency` pair, or null if it is not part of one.
 * Both halves must be present *and* typed like money — a null currency (an unset money value) is
 * not "half a pair", it simply is not a pair, so both columns fall through as ordinary values.
 */
function moneyPairAt(
  physical: Readonly<Record<string, JsonValue>>,
  name: string,
): MoneyPair | null {
  const prefix = moneyPrefix(name);
  if (prefix === null) return null;

  const minorKey = `${prefix}_minor`;
  const currencyKey = `${prefix}_currency`;
  if (!Object.hasOwn(physical, minorKey) || !Object.hasOwn(physical, currencyKey)) return null;

  const minor = physical[minorKey];
  const currency = physical[currencyKey];
  if ((typeof minor === 'number' || typeof minor === 'string') && typeof currency === 'string') {
    return {
      property: camel(prefix),
      minorKey,
      currencyKey,
      minor: moneyMinor(minorKey, minor),
      currency,
    };
  }
  return null;
}

/**
 * `camel()` is not injective — `a_b` and `a__b` both give `aB`, `x` and `x_` both give `x` — and
 * `entityRow` writes by assignment, so without this the second column would silently overwrite the
 * first and the row would be short one value with nothing to read about it.
 */
function claim(taken: Map<string, string>, property: string, column: string): void {
  const first = taken.get(property);
  if (first !== undefined) {
    throw new ReplicationProtocolError({
      stage: 'value',
      detail: `columns "${first}" and "${column}" both map to the entity property "${property}"`,
      fix: `rename one of them — two columns cannot share one property once camelCased`,
    });
  }
  taken.set(property, column);
}

/**
 * A physical postgres row -> the row shape the rest of the pipeline is written against.
 * Two things are not one-to-one and both live here: the column is snake_case while the entity
 * property is camelCase, and money is one property over the two columns `<p>_minor`/`<p>_currency`.
 */
export function entityRow(physical: Readonly<Record<string, JsonValue>>): JsonObject {
  const row: JsonObject = {};
  // Column order in is key order out; a folded money property lands wherever its earlier half
  // (whichever of _minor/_currency the source happened to emit first) would otherwise have sat.
  const consumed = new Set<string>();
  // Which column produced each property, so a collision names both sides rather than losing one.
  const taken = new Map<string, string>();

  for (const name of Object.keys(physical)) {
    if (consumed.has(name)) continue;

    const money = moneyPairAt(physical, name);
    if (money !== null) {
      claim(taken, money.property, `${money.minorKey}/${money.currencyKey}`);
      row[money.property] = { minor: money.minor, currency: money.currency };
      consumed.add(money.minorKey);
      consumed.add(money.currencyKey);
      continue;
    }

    const property = camel(name);
    claim(taken, property, name);
    row[property] = physical[name] ?? null;
  }
  return row;
}

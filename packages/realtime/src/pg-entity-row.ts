// Physical Postgres row -> entity-row shaping: snake_case columns become camelCase properties,
// and the `<p>_minor` / `<p>_currency` / `<p>_scale` columns fold into one `<p>: Money`-shaped
// property. The inverse of the camelCasing here is `@ultimat3/entity`'s `column.ts#snake`, and
// the fold is its `pg-row.ts#moneyOf` — neither is imported (this package declares no dependency
// on tier 2), so both are pinned by a test instead: `pg-entity-row-parity.test.ts` reads one
// physical row through both surfaces and asserts one object.

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

interface FoldedMoney {
  readonly property: string;
  /** The physical columns the fold consumed, in declaration order — named together on a collision. */
  readonly columns: readonly string[];
  readonly value: JsonObject;
}

/**
 * `price_minor` / `price_currency` / `price_scale` -> `price`; any other column name has no money
 * prefix. The scale column is matched here for the same reason the other two are: unmatched, it
 * survived the fold as a physical `priceScale` property beside `price`, so one row read live and
 * the same row read through a repository reported two different shapes — and the sub-cent amount
 * the scale names was delivered to every subscriber unscaled.
 */
function moneyPrefix(column: string): string | null {
  if (column.endsWith('_minor')) return column.slice(0, -'_minor'.length);
  if (column.endsWith('_currency')) return column.slice(0, -'_currency'.length);
  if (column.endsWith('_scale')) return column.slice(0, -'_scale'.length);
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
    detail: `column "${column}" carries ${shownNumber(value)}, which is not a whole number of minor units`,
    fix: `store ${column} as a bigint inside ±2^53 — Money.minor is a number, never a float or a bigint`,
  });
}

/**
 * `MoneyValue.scale` is a whole, non-negative count of decimal places, so that — and only that —
 * is what this decoder refuses: a fractional or negative scale is not a value the shape can carry
 * at all, exactly as an out-of-range `minor` is not.
 *
 * The `0…MAX_MONEY_SCALE` CEILING is `@ultimat3/schema`'s and is deliberately not restated here:
 * it is enforced at both ends of this column already — the CHECK `@ultimat3/entity`'s
 * `describeColumn` emits on `<p>_scale`, and `parseScale` on the repository read — and this
 * package declares no `@ultimat3/schema` dependency, so a copy of the bound here would be a
 * second declaration that can drift from the one that decides.
 *
 * `/^\d+$/` and not `Number(value)`: `Number('')` is 0, and 0 means whole units — the one value
 * an empty column must never decode to. The same guard `parseScale` uses.
 */
function moneyScale(column: string, value: JsonValue): number {
  const digits = typeof value === 'string' && /^\d+$/.test(value);
  const scale = typeof value === 'number' ? value : digits ? Number(value) : Number.NaN;
  if (Number.isSafeInteger(scale) && scale >= 0) return scale;
  throw new ReplicationProtocolError({
    stage: 'value',
    detail: `column "${column}" carries ${shownNumber(value)}, which is not a whole number of decimal places`,
    fix: `store ${column} as a non-negative integer, or null for the currency's own minor unit`,
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
 * string that *is* one), and everything else is reported as shape. The scale column is matched by
 * name the same way and carries the same risk, so it renders through here too.
 */
function shownNumber(value: JsonValue): string {
  if (typeof value === 'number') return `"${value}"`;
  if (typeof value !== 'string') return describeValue(value);
  const numeric = value.trim() !== '' && Number.isFinite(Number(value));
  return numeric ? `"${value}"` : describeValue(value);
}

/**
 * `name` is part of a `<p>_minor` / `<p>_currency` (/ `<p>_scale`) group, or null if it is not.
 * The first two must be present *and* typed like money — a null currency (an unset money value) is
 * not "half a pair", it simply is not a pair, so every column falls through as an ordinary value.
 *
 * The scale column is the one member that may be absent or NULL, and both mean the same thing:
 * "the currency's own minor unit". Neither produces a `scale` key, because `undefined` and `0` are
 * different values — `0` claims whole units, a 100x reinterpretation of an ordinary price — which
 * is exactly the rule `moneyOf` follows on the repository side. What it may NOT do is survive as a
 * column of its own: the fold consumes it whenever the group folds.
 */
function foldMoney(
  physical: Readonly<Record<string, JsonValue>>,
  name: string,
): FoldedMoney | null {
  const prefix = moneyPrefix(name);
  if (prefix === null) return null;

  const minorKey = `${prefix}_minor`;
  const currencyKey = `${prefix}_currency`;
  if (!Object.hasOwn(physical, minorKey) || !Object.hasOwn(physical, currencyKey)) return null;

  const minor = physical[minorKey];
  const currency = physical[currencyKey];
  if (!(typeof minor === 'number' || typeof minor === 'string') || typeof currency !== 'string') {
    return null;
  }

  const scaleKey = `${prefix}_scale`;
  const scale = Object.hasOwn(physical, scaleKey) ? physical[scaleKey] : undefined;
  return {
    property: camel(prefix),
    columns: scale === undefined ? [minorKey, currencyKey] : [minorKey, currencyKey, scaleKey],
    value: {
      minor: moneyMinor(minorKey, minor),
      currency,
      ...(scale === undefined || scale === null ? {} : { scale: moneyScale(scaleKey, scale) }),
    },
  };
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
 * property is camelCase, and money is one property over the columns `<p>_minor`/`<p>_currency`
 * and the nullable `<p>_scale`.
 */
export function entityRow(physical: Readonly<Record<string, JsonValue>>): JsonObject {
  const row: JsonObject = {};
  // Column order in is key order out; a folded money property lands wherever its earliest member
  // (whichever of the three the source happened to emit first) would otherwise have sat.
  const consumed = new Set<string>();
  // Which column produced each property, so a collision names both sides rather than losing one.
  const taken = new Map<string, string>();

  for (const name of Object.keys(physical)) {
    if (consumed.has(name)) continue;

    const money = foldMoney(physical, name);
    if (money !== null) {
      claim(taken, money.property, money.columns.join('/'));
      row[money.property] = money.value;
      for (const column of money.columns) consumed.add(column);
      continue;
    }

    const property = camel(name);
    claim(taken, property, name);
    row[property] = physical[name] ?? null;
  }
  return row;
}

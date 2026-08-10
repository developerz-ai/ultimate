// Physical Postgres row -> entity-row shaping: snake_case columns become camelCase properties,
// and a `<p>_minor` / `<p>_currency` column pair folds into one `<p>: Money`-shaped property.
// The inverse of the camelCasing here is `@ultimat3/entity`'s `column.ts#snake` — not imported
// (a tier-3 package may not reach across to tier-2), so the round trip is pinned by a test instead.

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
  readonly minor: number | string;
  readonly currency: string;
}

/** `price_minor` / `price_currency` -> `price`; any other column name has no money prefix. */
function moneyPrefix(column: string): string | null {
  if (column.endsWith('_minor')) return column.slice(0, -'_minor'.length);
  if (column.endsWith('_currency')) return column.slice(0, -'_currency'.length);
  return null;
}

/**
 * `name` is one half of a `<p>_minor` / `<p>_currency` pair, or null if it is not part of one.
 * Both halves must be present *and* typed like money — a null currency (an unset money value) is
 * not "half a pair", it simply is not a pair, so both columns fall through as ordinary values.
 * A string `minor` (an int8 outside `Number.isSafeInteger` range, as `pgoutput.ts` decodes it) is
 * kept as a string here too — folding it into a number would make it a lossy one.
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
    return { property: camel(prefix), minorKey, currencyKey, minor, currency };
  }
  return null;
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

  for (const name of Object.keys(physical)) {
    if (consumed.has(name)) continue;

    const money = moneyPairAt(physical, name);
    if (money !== null) {
      row[money.property] = { minor: money.minor, currency: money.currency };
      consumed.add(money.minorKey);
      consumed.add(money.currencyKey);
      continue;
    }

    row[camel(name)] = physical[name] ?? null;
  }
  return row;
}

// Single responsibility: the framework's ONE money declaration and the validator that guards it.
// Split out of `validators.ts` because it is the only builtin whose *shape* other packages alias
// — `@ultimat3/money`'s `Money`, `@ultimat3/entity`'s `MoneyValue` — so it earns a file a reader
// can open by name instead of scrolling to.

import { fail, failWith, isPlainObject, makeSchema, pass, type Schema } from './builder';
import { expected } from './describe-value';
import type { StandardIssue } from './standard';

/**
 * The shape of an ISO 4217 alphabetic code, as a pattern SOURCE — the one declaration every
 * projection of that bound derives from. It is a string rather than a `RegExp` because the two
 * surfaces that cannot call a predicate need the source itself: `json-schema.ts` emits it as the
 * `pattern` of the published OpenAPI contract, and `@ultimat3/entity`'s `currencyCheck` emits it
 * inside a Postgres `~` CHECK so a psql session cannot write a code the app would refuse to read.
 *
 * Keep it inside the syntax ECMAScript, JSON Schema and POSIX ERE spell identically — anchors,
 * a literal character class, a bounded repetition. A construct only one of the three understands
 * (`\d`, a lookahead, a non-greedy quantifier) makes the CHECK stop meaning what `isCurrencyCode`
 * means, and a real server is the first thing that says so.
 */
export const CURRENCY_CODE_PATTERN = '^[A-Z]{3}$';

const CURRENCY_RE = new RegExp(CURRENCY_CODE_PATTERN);

/**
 * The framework's ONE declaration of a money value. `@ultimat3/money`'s `Money` and
 * `@ultimat3/entity`'s `MoneyValue` are aliases of this type, not copies of its shape — three
 * structural restatements are how `minor` became a `number` here and a `bigint` there, which made
 * a row the entity layer produced fail `t.money` and throw inside `JSON.stringify`.
 *
 * It lives at tier 0 because that is the only tier every other package may import, and `number`
 * rather than `bigint` because money crosses the wire on every surface this framework projects —
 * `JSON.stringify` refuses a bigint, and this node is also the OpenAPI contract. A value past
 * `Number.MAX_SAFE_INTEGER` is refused HERE, at the boundary, with the field path — and again
 * where it is decoded; it is never widened.
 *
 * Never a float, and never an amount without its currency.
 */
export interface MoneyValue {
  readonly minor: number;
  readonly currency: string;
  /**
   * Decimal places `minor` counts, when they are not the currency's own. Absent — the shape every
   * existing value and every existing row still has — means the currency's natural minor unit: 2
   * for USD, 0 for JPY, 3 for KWD. `{ minor: 2, currency: 'USD', scale: 6 }` is $0.000002.
   *
   * It exists because a cents-only value could not name a sub-cent amount at all, so the one
   * place that needed one — a model call costing $0.00016 — rounded it up to a whole cent and
   * reported 62x the real spend. The alternative was a second money type, which is the axiom-1
   * violation this declaration exists to prevent.
   */
  readonly scale?: number;
}

/**
 * The largest decimal exponent a money value may carry. 10^15 is the last power of ten that is
 * itself a safe integer, so a finer scale could not name its own unit inside the range `minor` is
 * already checked against.
 */
export const MAX_MONEY_SCALE = 15;

/**
 * What a legal `MoneyValue.currency` is — declared once, here, beside the type that carries it and
 * beside `isMoneyScale`, which is the twin of this predicate and the precedent for it. Takes
 * `unknown` because every caller is a boundary: a row off a `char(3)` column, a body off the wire,
 * a `registerCurrency` argument from an untyped caller. `String(value).test(…)` on a symbol throws
 * where a refusal was due, so the `typeof` half belongs in here rather than at each call.
 */
export function isCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY_RE.test(value);
}

/** What a legal `MoneyValue.scale` is — declared once, here, beside the type that carries it. */
export function isMoneyScale(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_MONEY_SCALE
  );
}

export const moneySchema: Schema<MoneyValue, MoneyValue> = makeSchema<MoneyValue, MoneyValue>(
  {
    kind: 'money',
    description: 'integer minor units plus an ISO 4217 currency code',
    properties: {
      minor: {
        kind: 'number',
        integer: true,
        minimum: -Number.MAX_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      currency: { kind: 'string', pattern: CURRENCY_CODE_PATTERN },
      scale: {
        kind: 'number',
        integer: true,
        optional: true,
        minimum: 0,
        maximum: MAX_MONEY_SCALE,
        description: 'decimal places `minor` counts; absent means the currency’s own',
      },
    },
  },
  (value, path) => {
    if (!isPlainObject(value)) return fail(path, expected('a Money object', value));
    const minor = value['minor'];
    const currency = value['currency'];
    const scale = value['scale'];
    const issues: StandardIssue[] = [];
    // Safe, not merely whole: `money()` and `entity`'s `parseMinor` both demand a safe integer, so
    // `Number.isInteger` here let 2^53 through the boundary as a 200 and failed at the row write
    // as a 500 — the same value refused twice, once with a field path and once without.
    if (typeof minor !== 'number' || !Number.isSafeInteger(minor)) {
      issues.push({
        message: expected('a safe integer number of minor units', minor),
        path: [...path, 'minor'],
      });
    }
    if (!isCurrencyCode(currency)) {
      issues.push({
        message: expected('a 3-letter ISO 4217 code', currency),
        path: [...path, 'currency'],
      });
    }
    if (scale !== undefined && !isMoneyScale(scale)) {
      issues.push({
        message: expected(
          `a whole number of decimal places between 0 and ${MAX_MONEY_SCALE}`,
          scale,
        ),
        path: [...path, 'scale'],
      });
    }
    if (issues.length > 0) return failWith(issues);
    // The key is carried only when it was sent: a value at the currency's own scale must
    // round-trip byte-for-byte, or every stored amount in every app changes shape on one parse.
    return pass({
      minor: minor as number,
      currency: currency as string,
      ...(scale === undefined ? {} : { scale: scale as number }),
    });
  },
);

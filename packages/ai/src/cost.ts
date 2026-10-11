// Single responsibility: the money arithmetic over a call's reported usage — what it cost exactly,
// and that figure rounded up to the currency's own minor unit, once.
//
// Exact, in integers: a price is `Money` per million tokens at whatever `scale` the row states
// (`{ minor: 75, currency: 'USD', scale: 3 }` is $0.075), and a cost is `Money` at
// `COST_SCALE_DIGITS` more digits than the currency's minor unit — millionths of a cent for USD.
// The multiplication is done in bigint, so no call, however large, loses a digit on the way.

import type { Money } from '@ultimat3/money';
import { commonScale, exponentOf, minorAt } from '@ultimat3/money';
import type { ModelId, ModelSpec } from './models';
import { modelSpec, PRICE_SCALE_DIGITS } from './models';
import type { TokenUsage } from './provider';

/** Digits an exact cost carries beyond the currency's minor unit: micro-units of it. */
export const COST_SCALE_DIGITS = PRICE_SCALE_DIGITS;

const MICRO = 10n ** BigInt(COST_SCALE_DIGITS);
const MILLION = 1_000_000n;
/** Prices are summed in TWENTIETHS so the default cache multipliers (0.1x, 1.25x) stay whole. */
const TWENTIETHS = 20n;

/** The scale an exact cost in `currency` is stated at. */
export const costScale = (currency: string): number => exponentOf(currency) + COST_SCALE_DIGITS;

/**
 * What one call cost, EXACTLY to a micro-unit of the currency's minor unit (rounded up at that
 * digit, which no real price reaches). `Money` with an explicit `scale` — never a float, never a
 * second type: `{ minor: 105_000, currency: 'USD', scale: 8 }` is 0.105 cents.
 *
 * The one price lookup: a model the app never `registerModel`-ed is `X_AI_MODEL_UNKNOWN` here, so
 * no call is priced — and no budget reserved — against a number nobody chose.
 */
export function exactCostOf(model: ModelId, usage: TokenUsage): Money {
  const spec = modelSpec(model);
  const { currency } = spec.inputPerMillion;
  const scale = costScale(currency);
  return {
    minor: toSafe(ceilDiv(units(spec, usage, scale), TWENTIETHS * MILLION)),
    currency,
    scale,
  };
}

/**
 * Cost of one call in the currency's own minor units — the figure every existing reader of
 * `cost.minor` means. Rounded UP: a fraction we round away is money the framework silently
 * absorbs, and under-reporting spend defeats a budget. Rounded ONCE, over the whole call: the
 * input and output halves were each rounded up before, so a call worth a tenth of a cent read two.
 */
export function costOf(model: ModelId, usage: TokenUsage): Money {
  const spec = modelSpec(model);
  const { currency } = spec.inputPerMillion;
  const total = units(spec, usage, costScale(currency));
  return { minor: toSafe(ceilDiv(total, TWENTIETHS * MILLION * MICRO)), currency };
}

/** An exact cost (or any finer `Money`) rounded up to its currency's minor unit. */
export function roundUpCost(exact: Money): Money {
  const from = exact.scale ?? exponentOf(exact.currency);
  const drop = 10n ** BigInt(Math.max(0, from - exponentOf(exact.currency)));
  return { minor: toSafe(ceilDiv(BigInt(exact.minor), drop)), currency: exact.currency };
}

/** `usage` priced, in twentieths of (a unit at `scale`) per million tokens — before any division. */
function units(spec: ModelSpec, usage: TokenUsage, scale: number): bigint {
  const input = minorAt(spec.inputPerMillion, scale);
  // A cache read is 0.1x input (2/20) and a 5-minute write 1.25x (25/20) unless the row states
  // its own — a vendor's 0.05x or 0.025x read is a row, which a fixed 0.1x overstated.
  const read =
    spec.cacheReadPerMillion === undefined
      ? input * 2n
      : minorAt(spec.cacheReadPerMillion, scale) * TWENTIETHS;
  const write =
    spec.cacheWritePerMillion === undefined
      ? input * 25n
      : minorAt(spec.cacheWritePerMillion, scale) * TWENTIETHS;
  return (
    count(usage.inputTokens) * input * TWENTIETHS +
    count(usage.cacheReadTokens) * read +
    count(usage.cacheWriteTokens) * write +
    count(usage.outputTokens) * minorAt(spec.outputPerMillion, scale) * TWENTIETHS
  );
}

/** A token count as a bigint. Usage is the provider's number: floored, and never negative. */
const count = (tokens: number): bigint =>
  Number.isFinite(tokens) && tokens > 0 ? BigInt(Math.floor(tokens)) : 0n;

const ceilDiv = (numerator: bigint, denominator: bigint): bigint =>
  (numerator + denominator - 1n) / denominator;

/** Back to the `number` `Money` carries. Past 2^53 minor units there is no honest answer. */
const toSafe = (value: bigint): number =>
  value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);

/**
 * `a` against `b` as MONEY — negative, zero or positive — at the finer of their two scales. Never
 * `a.minor - b.minor`: `{ minor: 500, scale: 3 }` is fifty cents, and read by `minor` alone it
 * outranked four dollars.
 */
export function compareMoney(a: Money, b: Money): number {
  const scale = commonScale(a, b);
  const left = minorAt(a, scale);
  const right = minorAt(b, scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Two amounts of one currency as one, at the finer scale — stated only when either stated one. */
export function addMoney(a: Money, b: Money): Money {
  const scale = commonScale(a, b);
  const minor = toSafe(minorAt(a, scale) + minorAt(b, scale));
  return a.scale === undefined && b.scale === undefined
    ? { minor, currency: a.currency }
    : { minor, currency: a.currency, scale };
}

/**
 * A cost as a `Provider` reported it, made bookable. The built-in providers price in integers, but
 * `Provider` is an interface an app implements, and its `cost.minor` was summed as a plain number
 * until the ledger went exact: a fraction was accepted. So a fraction is ROUNDED UP (never down:
 * under-reporting spend defeats a budget), and a value that is no amount at all — `NaN`, an
 * infinity, a negative, which a ledger would read as a credit — is booked as zero. Never a throw:
 * this runs after the provider was paid, and a bookkeeping error must not cost the answer.
 */
export function bookableCost(cost: Money): Money {
  const minor = Number.isFinite(cost.minor) && cost.minor > 0 ? Math.ceil(cost.minor) : 0;
  const scale = Number.isInteger(cost.scale) ? cost.scale : undefined;
  return scale === undefined
    ? { minor, currency: cost.currency }
    : { minor, currency: cost.currency, scale };
}

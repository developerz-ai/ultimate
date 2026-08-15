/**
 * Largest-remainder allocation: split a total so the parts add back up to the total.
 *
 * The classic bug: 100 cents split three ways with `round(100 / 3)` gives 33/33/33 and
 * loses a cent, or 34/34/34 and invents one. Invoices that do this fail reconciliation,
 * and a revenue share that does it pays out the wrong amount forever. The fix is to
 * floor every part, then hand the leftover minor units out one at a time, largest
 * fractional remainder first — deterministic, total-preserving, no floats in the result.
 */

import { assertSameCurrency } from './arithmetic';
import { allocationInvalid } from './errors';
import { factorFraction } from './factor';
import { formatMoneyDebug, type Money, money } from './money';
import { minorAt, moneyScale } from './scale';

/** Split into `parts` equal shares. `allocate(money(100,'USD'), 3)` → 34, 33, 33. */
export function allocate(amount: Money, parts: number): Money[] {
  if (!Number.isSafeInteger(parts) || parts <= 0) {
    throw allocationInvalid(`part count must be a positive integer, got ${String(parts)}`);
  }
  return allocateByRatios(amount, new Array<number>(parts).fill(1));
}

/**
 * Split by weights. `allocateByRatios(money(1000,'USD'), [70, 20, 10])` → 700, 200, 100;
 * `[1, 1, 1]` over 100 → 34, 33, 33. Weights need not sum to anything in particular.
 */
export function allocateByRatios(amount: Money, ratios: readonly number[]): Money[] {
  if (ratios.length === 0) throw allocationInvalid('ratios must not be empty');
  const weights = weigh(ratios);
  let total = 0n;
  for (const weight of weights) total += weight;
  if (total <= 0n) throw allocationInvalid('ratios must not all be zero');

  const sign = amount.minor < 0 ? -1 : 1;
  const magnitude = BigInt(Math.abs(amount.minor));

  const floors: bigint[] = [];
  const remainders: bigint[] = [];
  let assigned = 0n;
  for (const weight of weights) {
    const exact = magnitude * weight;
    const floor = exact / total;
    floors.push(floor);
    remainders.push(exact % total);
    assigned += floor;
  }

  // Hand out the leftover units, largest remainder first; ties go to the earlier index
  // so the same input always produces the same split (invoices must be reproducible).
  let leftover = magnitude - assigned;
  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder < b.remainder ? 1 : -1,
    );
  for (const { index } of order) {
    if (leftover <= 0n) break;
    floors[index] = (floors[index] ?? 0n) + 1n;
    leftover -= 1n;
  }

  return floors.map((minor) => money(sign * Number(minor), amount.currency, amount.scale));
}

/**
 * The ratios as exact integer weights over one common denominator.
 *
 * `(magnitude * ratio) / total` in floats was only exact while the product stayed under 2^53 —
 * true of most cent amounts and false of the same invoice held in micros, where the floor came
 * out one unit low and largest-remainder handed the difference to the wrong part. Every
 * denominator `factorFraction` produces is a power of ten, so the common one is just the largest.
 */
function weigh(ratios: readonly number[]): bigint[] {
  const fractions = ratios.map((ratio) => {
    if (!Number.isFinite(ratio) || ratio < 0) {
      throw allocationInvalid(`ratios must be finite and non-negative, got ${String(ratio)}`);
    }
    return factorFraction(ratio);
  });
  let common = 1n;
  for (const fraction of fractions) {
    if (fraction.denominator > common) common = fraction.denominator;
  }
  return fractions.map((fraction) => fraction.numerator * (common / fraction.denominator));
}

/**
 * Split into shares given as percentages that must sum to 100 — the invoice-line case
 * where a mis-typed percentage should be an error, not a silent re-normalization.
 */
export function allocateByPercentages(amount: Money, percentages: readonly number[]): Money[] {
  const total = percentages.reduce((sum, percentage) => sum + percentage, 0);
  if (Math.abs(total - 100) > 1e-9) {
    throw allocationInvalid(`percentages must sum to 100, got ${String(total)}`);
  }
  return allocateByRatios(amount, percentages);
}

/** Guard for callers building their own splits: parts must reconstruct the whole. */
export function assertAllocationSums(amount: Money, parts: readonly Money[]): void {
  let scale = moneyScale(amount);
  for (const part of parts) {
    assertSameCurrency(amount, part);
    scale = Math.max(scale, moneyScale(part));
  }
  // Summed at the finest scale present, so parts split finer than the whole still reconcile
  // against it rather than reading as a total that lost everything below a cent.
  let total = 0n;
  for (const part of parts) total += minorAt(part, scale);
  const whole = minorAt(amount, scale);
  if (total !== whole) {
    throw allocationInvalid(
      `allocation of ${formatMoneyDebug(amount)} sums to ${total} at scale ${scale} — ${whole - total} minor unit(s) lost`,
    );
  }
}

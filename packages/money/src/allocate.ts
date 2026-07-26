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
import { type Money, money } from './money';

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
  let total = 0;
  for (const ratio of ratios) {
    if (!Number.isFinite(ratio) || ratio < 0) {
      throw allocationInvalid(`ratios must be finite and non-negative, got ${String(ratio)}`);
    }
    total += ratio;
  }
  if (total <= 0) throw allocationInvalid('ratios must not all be zero');

  const sign = amount.minor < 0 ? -1 : 1;
  const magnitude = Math.abs(amount.minor);

  const floors: number[] = [];
  const remainders: number[] = [];
  let assigned = 0;
  for (const ratio of ratios) {
    const exact = (magnitude * ratio) / total;
    const floor = Math.floor(exact);
    floors.push(floor);
    remainders.push(exact - floor);
    assigned += floor;
  }

  // Hand out the leftover units, largest remainder first; ties go to the earlier index
  // so the same input always produces the same split (invoices must be reproducible).
  let leftover = magnitude - assigned;
  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (leftover <= 0) break;
    floors[index] = (floors[index] ?? 0) + 1;
    leftover -= 1;
  }

  return floors.map((minor) => money(sign * minor, amount.currency));
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
  let total = 0;
  for (const part of parts) {
    assertSameCurrency(amount, part);
    total += part.minor;
  }
  if (total !== amount.minor) {
    throw allocationInvalid(
      `allocation of ${amount.currency} ${amount.minor} sums to ${total} — ${amount.minor - total} minor unit(s) lost`,
    );
  }
}

// The shapes a chart refuses rather than draws wrong: a series whose values do not line up with
// the keys, x positions that are not ascending, gauge thresholds out of order. A misaligned row
// drawn anyway puts a value under the wrong key — a chart that lies quietly — so each is coded.

import { renderCauseValue } from '@ultimat3/core';
import { UI_ERROR_CODES, UiError } from '../errors';
import type { ChartSeries } from './chart-frame-view';

function refused(cause: string, fix: string): UiError {
  return new UiError({ code: UI_ERROR_CODES.invalidValue, cause, fix });
}

/** Every series carries exactly one value per key; `null` is how a gap is said. */
export function checkSeries(
  chart: string,
  keys: readonly string[],
  series: readonly ChartSeries[],
): void {
  for (const one of series) {
    if (one.values.length === keys.length) continue;
    throw refused(
      `<${chart}> series ${renderCauseValue(one.label)} has ${one.values.length} values for ${keys.length} keys`,
      'values: keys.map((key) => byKey.get(key) ?? null)   # one value per key, null for a gap — never a shorter row',
    );
  }
}

/** True x positions: one per key, finite, strictly ascending. */
export function checkAt(chart: string, keys: readonly string[], at: readonly number[]): void {
  const fix =
    'at: rows.map((row) => row.at.getTime())   # one finite number per key, oldest first, no repeats';
  if (at.length !== keys.length) {
    throw refused(`<${chart}> at has ${at.length} positions for ${keys.length} keys`, fix);
  }
  for (let i = 0; i < at.length; i += 1) {
    const value = at[i] as number;
    if (!Number.isFinite(value) || (i > 0 && value <= (at[i - 1] as number))) {
      throw refused(
        `<${chart}> at[${i}] is ${renderCauseValue(value)}, which is not finite and above at[${i - 1}]`,
        fix,
      );
    }
  }
}

/** Thresholds ascend by `at`, so "the last one passed" is one answer. */
export function checkThresholds(
  chart: string,
  thresholds: readonly { readonly at: number }[],
): void {
  for (let i = 0; i < thresholds.length; i += 1) {
    const at = thresholds[i]?.at as number;
    if (Number.isFinite(at) && (i === 0 || at > (thresholds[i - 1]?.at as number))) continue;
    throw refused(
      `<${chart}> thresholds[${i}].at is ${renderCauseValue(at)}, which is not finite and above the one before`,
      "thresholds: [{ at: 70, tone: 'warning' }, { at: 90, tone: 'danger' }]   # ascending by at, in the value's unit",
    );
  }
}

// A slider's numbers: bounds checked, the value snapped onto the step grid and kept in range. Pure,
// so the refusals — a zero step, a min above max, a non-finite anything — are tested without a DOM.

import { finiteOption } from '@ultimat3/core';
import { invalidValueError } from '../errors';

export interface SliderNumbers {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
}

/**
 * Decimal places `n` is written with, so a snapped `0.1 * 3` reads `0.3`, not `0.30000000000000004`.
 * `String` spells a small number in exponent form — `1e-7`, `2.5e-7` — and those places are the
 * mantissa's less the exponent: seven and eight, never the zero a search for `.` alone counted.
 */
const decimals = (n: number): number => {
  const [mantissa = '', exponent = '0'] = String(n).split('e');
  const dot = mantissa.indexOf('.');
  const places = dot === -1 ? 0 : mantissa.length - dot - 1;
  return Math.max(0, places - Number(exponent));
};

/**
 * The slider's numbers, validated. `step` of zero or below, `min` not below `max`, and any
 * non-finite number are refused naming the prop; `value` is clamped into range and snapped to the
 * nearest step from `min` — never past `max`, a grid `max` is off pulls back a step — which is what
 * the native control would do with it anyway. Rounded by the places of `min` AND `step`: the grid
 * from `min: 0.25` by `0.5` holds `0.75`, which `step`'s one place alone rounded to `0.8`.
 */
export function sliderNumbers(input: {
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly step?: number | undefined;
  readonly value?: number | undefined;
}): SliderNumbers {
  const min = finiteOption('Slider', 'min', input.min ?? 0);
  const max = finiteOption('Slider', 'max', input.max ?? 100);
  const step = finiteOption('Slider', 'step', input.step ?? 1);
  if (step <= 0) throw invalidValueError('Slider step', step, 'a step above 0');
  if (min >= max)
    throw invalidValueError(
      'Slider min',
      `${String(min)} not below max ${String(max)}`,
      'a min below max',
    );
  const raw = finiteOption('Slider', 'value', input.value ?? min);
  const clamped = Math.min(max, Math.max(min, raw));
  // `toFixed` takes at most 100 places and throws a bare RangeError past them.
  const places = Math.min(100, Math.max(decimals(min), decimals(step)));
  const at = (steps: number): number => Number((min + steps * step).toFixed(places));
  const nearest = Math.round((clamped - min) / step);
  // `max` need not sit on the grid: the native control keeps the last step at or below it. Compared
  // once rounded, or `3 * 0.1` — `0.30000000000000004` — would read as past a `max` of `0.3`.
  const value = at(nearest) > max ? at(nearest - 1) : at(nearest);
  return { min, max, step, value };
}

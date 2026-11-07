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

/** Decimal places of `step`, so a snapped `0.1 * 3` reads `0.3`, not `0.30000000000000004`. */
const decimals = (step: number): number => {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
};

/**
 * The slider's numbers, validated. `step` of zero or below, `min` not below `max`, and any
 * non-finite number are refused naming the prop; `value` is clamped into range and snapped to the
 * nearest step from `min`, which is what the native control would do with it anyway.
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
  const snapped = min + Math.round((clamped - min) / step) * step;
  const value = Number(Math.min(max, snapped).toFixed(decimals(step)));
  return { min, max, step, value };
}

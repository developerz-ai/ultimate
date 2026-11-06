// Reference lines — a target, a limit, last week's mean — as geometry every xy chart shares: a
// horizontal rule at a value, its label, and its tone. The value widens the chart's range, so a
// target above every bar is still on the plot rather than silently off it.

import { finiteOrNull } from './chart-frame-view';
import type { Tone } from './variants';

export interface ChartReference {
  readonly value: number;
  /** Already translated: "Target", "SLO 99.9%". Drawn beside the rule with its value. */
  readonly label: string;
  /** Default `neutral`. The rule is dashed in every tone, so it never reads as a series. */
  readonly tone?: Tone | undefined;
}

export interface ReferenceLine {
  readonly value: number;
  readonly y: number;
  readonly label: string;
  readonly tone: Tone;
}

/** The finite values among `references` — what an extent folds in. */
export function referenceValues(references: readonly ChartReference[] | undefined): number[] {
  return (references ?? []).flatMap((ref) => {
    const value = finiteOrNull(ref.value);
    return value === null ? [] : [value];
  });
}

/** Each drawable reference at its y, by the chart's own scale; a non-finite value is dropped. */
export function referenceLines(
  references: readonly ChartReference[] | undefined,
  yOf: (value: number) => number,
): readonly ReferenceLine[] {
  return (references ?? []).flatMap((ref) => {
    const value = finiteOrNull(ref.value);
    if (value === null) return [];
    return [{ value, y: yOf(value), label: ref.label, tone: ref.tone ?? 'neutral' }];
  });
}

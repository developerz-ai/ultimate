// A stepper's rule: exactly one step is current, and the count the compact form reads ("Step 2 of
// 4") is that step's POSITION — never a number the caller restates, which drifts the day a step
// is inserted.

import { invalidValueError } from '../errors';

export type StepState = 'done' | 'current' | 'upcoming';

export interface StepperStep {
  /** Stable — the id `onSelect` answers. */
  readonly id: string;
  /** Already translated. */
  readonly label: string;
  /** A passed step's page; a `done` step with one renders as a link. */
  readonly href?: string | undefined;
  readonly state: StepState;
}

export interface StepperModel {
  /** Zero-based index of the current step. */
  readonly current: number;
  readonly total: number;
}

/** Where the current step is, or `X_UI_INVALID_VALUE` naming the ids when not exactly one is. */
export function stepperModel(steps: readonly StepperStep[]): StepperModel {
  const current = steps.filter((step) => step.state === 'current');
  if (current.length !== 1) {
    throw invalidValueError(
      'Stepper',
      current.length === 0
        ? 'no current step'
        : `current steps ${current.map((s) => s.id).join(', ')}`,
      'exactly one step with state "current"',
    );
  }
  return { current: steps.findIndex((step) => step.state === 'current'), total: steps.length };
}

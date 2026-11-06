import { describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES } from '../errors';
import { type StepperStep, stepperModel } from './stepper-view';

const step = (id: string, state: StepperStep['state']): StepperStep => ({ id, label: id, state });

describe('stepperModel', () => {
  test('the current step is found by position', () => {
    expect(stepperModel([step('a', 'done'), step('b', 'current'), step('c', 'upcoming')])).toEqual({
      current: 1,
      total: 3,
    });
  });

  test('two current steps, or none, are X_UI_INVALID_VALUE naming the ids', () => {
    for (const [steps, needle] of [
      [[step('a', 'current'), step('b', 'current')], 'a, b'],
      [[step('a', 'done')], 'no current step'],
    ] as const) {
      try {
        stepperModel(steps);
        expect.unreachable(`accepted ${needle}`);
      } catch (error) {
        expect((error as { code?: unknown }).code).toBe(UI_ERROR_CODES.invalidValue);
        expect(String((error as { cause?: unknown }).cause)).toContain(needle);
      }
    }
  });
});

import { describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES } from '../errors';
import { CONFIRM_IDLE, confirmLabelOf, confirmStep } from './confirm-dialog-view';

describe('confirmStep', () => {
  test('a submit goes busy, and a second submit while busy is refused', () => {
    const busy = confirmStep(CONFIRM_IDLE, { type: 'submit' });
    expect(busy).toEqual({ kind: 'busy' });
    expect(confirmStep({ kind: 'busy' }, { type: 'submit' })).toBeNull();
  });

  test('a settled act is idle; a refusal keeps its message', () => {
    expect(confirmStep({ kind: 'busy' }, { type: 'settled', refusal: undefined })).toEqual(
      CONFIRM_IDLE,
    );
    expect(confirmStep({ kind: 'busy' }, { type: 'settled', refusal: 'Not yours' })).toEqual({
      kind: 'refused',
      message: 'Not yours',
    });
  });

  test('a refused act can be retried, and closing forgets the refusal — but not mid-flight', () => {
    const refused = { kind: 'refused', message: 'No' } as const;
    expect(confirmStep(refused, { type: 'submit' })).toEqual({ kind: 'busy' });
    expect(confirmStep(refused, { type: 'closed' })).toEqual(CONFIRM_IDLE);
    expect(confirmStep({ kind: 'busy' }, { type: 'closed' })).toBeNull();
    expect(confirmStep(CONFIRM_IDLE, { type: 'settled', refusal: undefined })).toBeNull();
  });
});

describe('confirmLabelOf', () => {
  test('an empty or blank label is X_UI_INVALID_VALUE; a verb passes through', () => {
    expect(confirmLabelOf('Withdraw post')).toBe('Withdraw post');
    for (const blank of ['', '   ']) {
      try {
        confirmLabelOf(blank);
        expect.unreachable('a blank confirm label was accepted');
      } catch (error) {
        expect((error as { code?: unknown }).code).toBe(UI_ERROR_CODES.invalidValue);
      }
    }
  });
});

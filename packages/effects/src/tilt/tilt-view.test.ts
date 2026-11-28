import { describe, expect, test } from 'bun:test';
import { EffectsInvalidValueError } from '../errors';
import { TILT_DEFAULT_DEG, TILT_MAX_DEG, tiltAngles, tiltCap, tiltEnabled } from './tilt-view';

const box = { left: 0, top: 0, width: 200, height: 100 };

describe('tiltCap', () => {
  test('defaults, passes through and caps', () => {
    expect(tiltCap(undefined)).toBe(TILT_DEFAULT_DEG);
    expect(tiltCap(10)).toBe(10);
    expect(tiltCap(90)).toBe(TILT_MAX_DEG);
  });

  test('refuses NaN, zero and negatives with the registered code', () => {
    for (const bad of [Number.NaN, 0, -3, Number.POSITIVE_INFINITY]) {
      try {
        tiltCap(bad);
        expect.unreachable('tiltCap accepted a bad angle');
      } catch (error) {
        expect(error).toBeInstanceOf(EffectsInvalidValueError);
        expect((error as EffectsInvalidValueError).code).toBe('X_EFFECTS_INVALID_VALUE');
      }
    }
  });
});

describe('tiltAngles', () => {
  test('the centre is flat', () => {
    expect(tiltAngles(box, 100, 50, 10)).toEqual({ rotateX: 0, rotateY: 0 });
  });

  test('a corner reaches the cap and no further, even from outside the box', () => {
    expect(tiltAngles(box, 200, 0, 10)).toEqual({ rotateX: 10, rotateY: 10 });
    expect(tiltAngles(box, 5000, -5000, 10)).toEqual({ rotateX: 10, rotateY: 10 });
  });

  test('an empty box is flat, not NaN', () => {
    expect(tiltAngles({ ...box, width: 0 }, 1, 1, 10)).toEqual({ rotateX: 0, rotateY: 0 });
  });
});

describe('tiltEnabled', () => {
  const on = { coarsePointer: false, insideFocusTrap: false, motionAllowed: true };
  test('on for a fine pointer, free page, motion allowed', () => {
    expect(tiltEnabled(on)).toBe(true);
  });
  test.each([
    ['coarse pointer', { ...on, coarsePointer: true }],
    ['inside a focus trap', { ...on, insideFocusTrap: true }],
    ['reduced motion', { ...on, motionAllowed: false }],
  ])('off for %s', (_name, env) => {
    expect(tiltEnabled(env)).toBe(false);
  });
});

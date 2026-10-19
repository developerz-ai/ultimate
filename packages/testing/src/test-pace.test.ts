import { describe, expect, test } from 'bun:test';
import { paced, TEST_PACE_ENV, testPace } from './test-pace';

describe('a test deadline at this machine’s pace', () => {
  test('absent or blank is pace 1: a hand-run bun test keeps the declared number', () => {
    expect(testPace({})).toBe(1);
    expect(testPace({ [TEST_PACE_ENV]: ' ' })).toBe(1);
    expect(paced(90_000, {})).toBe(90_000);
  });

  test('the pace x verify measured stretches the declared number', () => {
    expect(testPace({ [TEST_PACE_ENV]: '2.75' })).toBe(2.75);
    expect(paced(90_000, { [TEST_PACE_ENV]: '2.75' })).toBe(247_500);
    expect(paced(5_000, { [TEST_PACE_ENV]: '1.333' })).toBe(6_665);
  });

  test('a value that does not parse, or one below 1, is refused by name — never read as 1', () => {
    for (const bad of ['fast', 'NaN', 'Infinity', '0.5', '0', '-2']) {
      expect(() => testPace({ [TEST_PACE_ENV]: bad })).toThrow('X_TEST_PACE_INVALID');
    }
  });
});

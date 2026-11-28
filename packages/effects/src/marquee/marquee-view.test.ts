import { describe, expect, test } from 'bun:test';
import { EffectsInvalidValueError } from '../errors';
import { MARQUEE_DEFAULT_SECONDS, marqueeSeconds, marqueeVars } from './marquee-view';

describe('marquee', () => {
  test('default and explicit seconds', () => {
    expect(marqueeSeconds(undefined)).toBe(MARQUEE_DEFAULT_SECONDS);
    expect(marqueeSeconds(12)).toBe(12);
  });

  test('refuses a loop that would never move or never end', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => marqueeSeconds(bad)).toThrow(EffectsInvalidValueError);
    }
  });

  test('vars carry the duration and the direction', () => {
    expect(marqueeVars(10, true)).toEqual({
      '--marquee-seconds': '10s',
      '--marquee-direction': 'reverse',
    });
    expect(marqueeVars(undefined, false)['--marquee-direction']).toBe('normal');
  });
});

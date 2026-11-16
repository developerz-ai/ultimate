// The exact-pin shape a lockstep release rewrites: semver's one prerelease then one build, a range
// or tag left alone, and no exponential backtracking on a hostile `+----…` (CodeQL, #1169).

import { describe, expect, test } from 'bun:test';
import { EXACT_PIN } from './release-text';

describe('unit · release · EXACT_PIN', () => {
  test('an exact version, with a prerelease and a build, is a pin', () => {
    for (const pin of [
      '31.32.0',
      '1.0.0-rc.1',
      '1.0.0-rc-1.a',
      '1.0.0+build.5',
      '1.0.0-rc.1+sha-abc',
    ]) {
      expect(EXACT_PIN.test(pin)).toBe(true);
    }
  });

  test('a range, a tag or a malformed version is somebody intent, never rewritten', () => {
    for (const range of [
      '^31.32.0',
      '~1.0.0',
      'latest',
      'workspace:*',
      '1.0',
      '1.0.0+a+b',
      '1.0.0-',
    ]) {
      expect(EXACT_PIN.test(range)).toBe(false);
    }
  });

  test('a long run of dashes after a plus answers at once', () => {
    const started = performance.now();
    expect(EXACT_PIN.test(`0.0.0+${'--'.repeat(5_000)}!`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

import { describe, expect, test } from 'bun:test';
import { patternSamples } from './seed-pattern-sample';

const accepted = (pattern: RegExp, seed = 'a1b2c3d4e5'): readonly string[] => {
  const samples = patternSamples(pattern, seed);
  for (const sample of samples)
    expect({ sample, ok: pattern.test(sample) }).toEqual({ sample, ok: true });
  return samples;
};

describe('patternSamples', () => {
  test.each([
    /^ORD-\d{4}$/,
    /^[a-z][a-z0-9-]{2,30}$/,
    /^(draft|live|archived)$/,
    /^\+?[0-9]{7,15}$/,
    /^[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3}$/,
    /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/,
    /^v\d+\.\d+\.\d+(-[a-z]+)?$/,
    /^#[0-9a-fA-F]{6}$/,
    /^(?<area>\d{3})-\d{4}$/,
    /^[a-z]+$/i,
    /^\x41B[-_.]*?$/,
    /^.{3}$/,
  ])('every sample of %s is accepted by the pattern it came from', (pattern) => {
    expect(accepted(pattern).length).toBeGreaterThan(0);
  });

  test('a pattern none of the fixed text shapes meets still yields a value', () => {
    // The six shapes `seed-graph-values.ts` offered all carry a lower-case canary or a dot.
    expect(accepted(/^ORD-\d{4}$/)).toContainEqual(expect.stringMatching(/^ORD-\d{4}$/));
  });

  test('the same seed draws the same samples; another seed draws others', () => {
    const pattern = /^[a-z]{4}-\d{3}$/;
    expect(patternSamples(pattern, 'seed-one')).toEqual(patternSamples(pattern, 'seed-one'));
    expect(patternSamples(pattern, 'seed-one')).not.toEqual(patternSamples(pattern, 'seed-two'));
  });

  test('samples are distinct, up to the count asked for', () => {
    const samples = patternSamples(/^[a-z]{6}$/, 'x', 5);
    expect(samples).toHaveLength(5);
    expect(new Set(samples).size).toBe(5);
  });

  test('a two-value pattern yields both values and stops', () => {
    expect([...patternSamples(/^(yes|no)$/, 'x')].sort()).toEqual(['no', 'yes']);
  });

  test.each([/^(?=a)a$/, /^(?!a)b$/, /^(a)\1$/, /\bword\b/, /^\p{L}+$/u, /^a{$/])(
    '%s is past the subset: no sample, never a guess',
    (pattern) => {
      expect(patternSamples(pattern, 'x')).toEqual([]);
    },
  );

  test('a draw that crosses an anchor is never returned', () => {
    // `a^b` matches nothing; the walk can build "ab", and the judge refuses it.
    expect(patternSamples(/a^b/, 'x')).toEqual([]);
  });
});

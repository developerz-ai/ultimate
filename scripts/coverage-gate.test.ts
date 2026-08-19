// The two halves that decide a package's verdict, driven directly: the lcov scoping that undoes
// Bun's cross-package dilution, and the ratchet that fails in both directions.

import { describe, expect, test } from 'bun:test';
import { judge, scopeLcov } from './coverage-gate';
import { COVERAGE_TARGET, PIN_SLACK } from './lib/coverage-pins';

/** Two records for the package under test, one for a package it merely imported. */
const LCOV = [
  'SF:/repo/packages/cache/src/tiers.ts',
  'FNF:10',
  'FNH:10',
  'LF:100',
  'LH:99',
  'end_of_record',
  'SF:/repo/packages/cache/src/redis.ts',
  'FNF:10',
  'FNH:9',
  'LF:100',
  'LH:98',
  'end_of_record',
  'SF:/repo/packages/core/src/logger.ts',
  'FNF:100',
  'FNH:1',
  'LF:1000',
  'LH:10',
  'end_of_record',
].join('\n');

describe('scoping an lcov report to one package', () => {
  test('a package imported by the run does not count against the package under test', () => {
    // The whole reason this gate exists: folded in, core's 1% would drag cache from 98.5% to 5%.
    expect(scopeLcov(LCOV, 'cache')).toEqual({
      pkg: 'cache',
      lines: 98.5,
      funcs: 95,
      measured: 200,
    });
  });

  test('a test file is not its own coverage', () => {
    const withTest = `${LCOV}\nSF:/repo/packages/cache/src/redis.test.ts\nFNF:50\nFNH:50\nLF:500\nLH:500\nend_of_record`;
    // Counting the test would push cache to 99.6% by measuring the tests' own execution.
    expect(scopeLcov(withTest, 'cache').measured).toBe(200);
  });

  test('an excluded path is not counted — generated glyphs are output volume, not tested surface', () => {
    const withGlyphs = `${LCOV}\nSF:/repo/packages/ui/src/icons/glyphs/a.ts\nFNF:1\nFNH:0\nLF:900\nLH:0\nend_of_record`;
    expect(scopeLcov(withGlyphs, 'ui').measured).toBe(0);
  });

  test('a report naming no file of this package measures nothing, rather than 100%', () => {
    // The false green: 0/0 is not a pass, and `judge` must be handed the zero to say so.
    expect(scopeLcov(LCOV, 'realtime')).toEqual({
      pkg: 'realtime',
      lines: 0,
      funcs: 0,
      measured: 0,
    });
  });
});

describe('the ratchet', () => {
  const reading = (lines: number, funcs: number, measured = 100) => ({
    pkg: 'demo',
    lines,
    funcs,
    measured,
  });

  test('nothing measured is refused, and is not reported as being below the target', () => {
    const codes = judge(reading(0, 0, 0), undefined).findings.map((f) => f.code);
    expect(codes).toEqual(['X_COVERAGE_UNMEASURED']);
  });

  test('an unpinned package must clear the target', () => {
    expect(judge(reading(COVERAGE_TARGET, COVERAGE_TARGET), undefined).findings).toEqual([]);
    expect(judge(reading(COVERAGE_TARGET - 0.1, 99), undefined).findings[0]?.code).toBe(
      'X_COVERAGE_BELOW',
    );
  });

  test('functions are judged as well as lines — a package may pass one and fail the other', () => {
    // packages/time measured 94.6% lines against 88.67% functions, so a lines-only gate would
    // have called it green while a tenth of its functions were never called.
    expect(judge(reading(99, COVERAGE_TARGET - 1), undefined).findings[0]?.code).toBe(
      'X_COVERAGE_BELOW',
    );
  });

  test('a pinned package holds at its pin and fails below it', () => {
    const pin = { lines: 80, funcs: 80, why: 'being written' };
    expect(judge(reading(80, 80), pin).findings).toEqual([]);
    expect(judge(reading(79.9, 80), pin).findings[0]?.code).toBe('X_COVERAGE_BELOW');
  });

  test('a pin the package has outgrown is stale — the ratchet tightens, it does not become a ceiling', () => {
    const pin = { lines: 80, funcs: 80, why: 'being written' };
    expect(judge(reading(96, 96), pin).findings[0]?.code).toBe('X_COVERAGE_PIN_STALE');
    expect(judge(reading(80 + PIN_SLACK, 80 + PIN_SLACK), pin).findings[0]?.code).toBe(
      'X_COVERAGE_PIN_STALE',
    );
  });

  test('drift under the slack is not reported — one uncovered line must not fail the build twice', () => {
    const pin = { lines: 80, funcs: 80, why: 'being written' };
    expect(judge(reading(80.5, 80.5), pin).findings).toEqual([]);
  });

  test('a package over the target with no pin is silent', () => {
    expect(judge(reading(99, 99), undefined).findings).toEqual([]);
  });
});

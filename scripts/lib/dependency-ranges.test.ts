// The range algebra `scripts/lib/dependency-ranges.ts` is: what two declared ranges can be to each
// other. A test that cannot fail is not a test, so every case below pins a verdict the algebra
// could plausibly have got wrong.

import { describe, expect, test } from 'bun:test';
import {
  parseVersionRange,
  type RangeCompatibility,
  rangeCompatibility,
} from './dependency-ranges';

const verdict = (left: string, right: string): RangeCompatibility['kind'] =>
  rangeCompatibility(left, right).kind;

describe('a root pin against an app range', () => {
  test('an exact pin inside a wider caret range is compatible', () => {
    expect(verdict('1.2.3', '^1.2.0')).toBe('compatible');
  });

  test('a caret range inside an exact pin of one of its versions is compatible', () => {
    expect(verdict('^1.2.0', '1.2.3')).toBe('compatible');
  });

  test('the root pin and the app range need not be spelled the same way', () => {
    expect(verdict('^7.0.2', '7.0.2')).toBe('compatible');
    expect(verdict('0.5.10', '^0.5.8')).toBe('compatible');
  });

  test('the same version in both manifests is compatible', () => {
    expect(verdict('1.9.17', '1.9.17')).toBe('compatible');
  });
});

describe('a caret on a zero major', () => {
  test('stops at the next minor, so 0.6.0 is outside ^0.5.8', () => {
    expect(verdict('^0.5.8', '0.6.0')).toBe('incompatible');
  });

  test('stops at the next minor, so 0.5.9 is inside ^0.5.8', () => {
    expect(verdict('^0.5.8', '0.5.9')).toBe('compatible');
  });

  test('a caret on 0.0.x stops at the next patch', () => {
    expect(verdict('^0.0.3', '0.0.4')).toBe('incompatible');
    expect(verdict('^0.0.3', '0.0.3')).toBe('compatible');
  });
});

describe('two genuinely incompatible ranges', () => {
  test('a caret on a major against a caret on the next major', () => {
    expect(verdict('^1.0.0', '^2.0.0')).toBe('incompatible');
  });

  test('a lower bound against the exclusive upper bound it meets', () => {
    expect(verdict('>=2.0.0', '<2.0.0')).toBe('incompatible');
  });

  test('two tilde ranges on different minors', () => {
    expect(verdict('~1.2.3', '~1.3.0')).toBe('incompatible');
  });

  test('an interval with no version between its ends shares nothing', () => {
    expect(verdict('>1.2.3', '<1.2.4')).toBe('incompatible');
  });

  test('a caret on 0.x against a caret on the next 0.x minor', () => {
    expect(verdict('^0.0', '^0.1.0')).toBe('incompatible');
  });
});

describe('a range that does not parse', () => {
  test('is refused, never read as compatible', () => {
    expect(verdict('not-a-range', '^1.0.0')).toBe('unparsable');
  });

  test('is refused from either side of the pair', () => {
    expect(verdict('^1.0.0', 'not-a-range')).toBe('unparsable');
  });

  test('names the range it could not read', () => {
    const answer = rangeCompatibility('^1.0.0', 'workspace:*');
    expect(answer.kind).toBe('unparsable');
    if (answer.kind !== 'unparsable')
      expect.unreachable('the range parsed, so there is none to read');
    expect(answer.range).toBe('workspace:*');
  });

  test('an empty range is refused', () => {
    expect(verdict('', '^1.0.0')).toBe('unparsable');
  });
});

describe('a range with alternatives and conjunctions', () => {
  test('operators stay attached to their versions across whitespace', () => {
    for (const range of ['>= 7.0.0 < 8.0.0', '>=\t7.0.0, <\n8.0.0']) {
      expect(verdict('7.0.2', range)).toBe('compatible');
      expect(verdict('8.0.0', range)).toBe('incompatible');
    }
    expect(verdict('7.0.2', '^ 7.0.0')).toBe('compatible');
    expect(verdict('7.0.2', '~ 7.0.0')).toBe('compatible');
    expect(verdict('7.0.2', '>= < 8.0.0')).toBe('unparsable');
  });

  test('strict wildcard comparators match no version, even an unbounded range', () => {
    for (const range of ['<*', '>*', '<x', '>X', '< *', '> *', '<0.0.0']) {
      for (const other of ['1.2.3', '*', '<2.0.0']) {
        expect(verdict(range, other)).toBe('incompatible');
        expect(verdict(other, range)).toBe('incompatible');
      }
    }
    expect(verdict('<* || 1.2.3', '1.2.3')).toBe('compatible');
  });

  test('non-strict wildcard operators still accept every release version', () => {
    for (const range of ['*', '>=*', '<=*', '=*', '^*', '~*']) {
      expect(verdict(range, '0.0.0')).toBe('compatible');
      expect(verdict(range, '7.0.2')).toBe('compatible');
    }
  });

  test('an alternative is compatible when one of its branches matches', () => {
    expect(verdict('^1.0.0 || ^3.0.0', '^3.1.0')).toBe('compatible');
  });

  test('alternatives that share no version are incompatible', () => {
    expect(verdict('^1.0.0 || ^3.0.0', '^2.0.0')).toBe('incompatible');
  });

  test('a space-separated conjunction is the interval it reads as', () => {
    expect(verdict('^1.0.0', '>=1.0.0 <2.0.0')).toBe('compatible');
    expect(verdict('^1.0.0', '>=2.0.0 <3.0.0')).toBe('incompatible');
  });

  test('a hyphen range is the interval it reads as', () => {
    expect(verdict('1.0.0 - 2.0.0', '1.5.0')).toBe('compatible');
    expect(verdict('1.0.0 - 2.0.0', '2.1.0')).toBe('incompatible');
  });
});

describe('the parsed range', () => {
  test('carries the interval a caret describes', () => {
    const parsed = parseVersionRange('^1.2.3');
    expect(parsed?.intervals).toHaveLength(1);
    expect(parsed?.intervals[0]?.lower?.version).toEqual([1, 2, 3]);
    expect(parsed?.intervals[0]?.upper?.version).toEqual([2, 0, 0]);
  });

  test('carries the narrower interval a zero-major caret describes', () => {
    const parsed = parseVersionRange('^0.5.8');
    expect(parsed?.intervals[0]?.lower?.version).toEqual([0, 5, 8]);
    expect(parsed?.intervals[0]?.upper?.version).toEqual([0, 6, 0]);
  });

  test('carries one interval per alternative', () => {
    expect(parseVersionRange('^1.0.0 || ^3.0.0')?.intervals).toHaveLength(2);
  });

  test('an unparsable range has no parsed form', () => {
    expect(parseVersionRange('workspace:*')).toBeUndefined();
  });
});

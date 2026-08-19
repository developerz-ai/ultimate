import { describe, expect, test } from 'bun:test';
import {
  DAY,
  formatDuration,
  formatDurationIso,
  HOUR,
  MINUTE,
  parseDuration,
  SECOND,
  toSeconds,
} from './duration';

describe('parseDuration', () => {
  test('single-unit forms', () => {
    expect(parseDuration('90s')).toBe(90 * SECOND);
    expect(parseDuration('3d')).toBe(3 * DAY);
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration('1w')).toBe(7 * DAY);
  });

  test('compound forms accumulate', () => {
    expect(parseDuration('2h30m')).toBe(2 * HOUR + 30 * MINUTE);
    expect(parseDuration('1d 12h')).toBe(DAY + 12 * HOUR);
    expect(parseDuration('1h30m15s')).toBe(HOUR + 30 * MINUTE + 15 * SECOND);
  });

  test('m is minutes and ms is milliseconds — never the other way round', () => {
    expect(parseDuration('5m')).toBe(5 * MINUTE);
    expect(parseDuration('5ms')).toBe(5);
  });

  test('ISO-8601 durations parse too', () => {
    expect(parseDuration('PT2H30M')).toBe(2 * HOUR + 30 * MINUTE);
    expect(parseDuration('P3D')).toBe(3 * DAY);
  });

  test('rejects ambiguous or malformed input with X_DURATION_INVALID', () => {
    // A bare number is ambiguous: seconds or milliseconds? Refuse to guess.
    expect(codeOf(() => parseDuration('3'))).toBe('X_DURATION_INVALID');
    expect(codeOf(() => parseDuration('2h30'))).toBe('X_DURATION_INVALID');
    expect(codeOf(() => parseDuration('soon'))).toBe('X_DURATION_INVALID');
    expect(codeOf(() => parseDuration(''))).toBe('X_DURATION_INVALID');
    expect(codeOf(() => parseDuration('3 months'))).toBe('X_DURATION_INVALID');
  });

  test('toSeconds is what a queue delay wants', () => {
    expect(toSeconds('2h30m')).toBe(9000);
    expect(toSeconds(1500)).toBe(2);
  });
});

describe('formatDuration', () => {
  test('localizes units and the list separator', () => {
    expect(formatDuration(9_000_000, 'en-US')).toContain('2 hr');
    expect(formatDuration(9_000_000, 'en-US')).toContain('30 min');
    expect(formatDuration(9_000_000, 'de-DE')).toContain('2 Std');
    expect(formatDuration(45 * SECOND, 'en-US')).toBe('45 sec');
    expect(formatDuration(0, 'en-US')).toBe('0 sec');
  });

  test('maxUnits truncates from the largest unit down', () => {
    expect(formatDuration(DAY + 2 * HOUR + 30 * MINUTE, 'en-US', { maxUnits: 1 })).toBe('1 day');
  });

  test('ISO round-trips', () => {
    expect(formatDurationIso(9_000_000)).toBe('PT2H30M');
    expect(formatDurationIso(3 * DAY)).toBe('P3D');
    expect(parseDuration(formatDurationIso(2 * HOUR + 15 * MINUTE))).toBe(2 * HOUR + 15 * MINUTE);
  });
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return 'no-throw';
}

// T5. Every ISO zero except `P0D` was rejected. The guard exists to reject a degenerate `'P'`, but
// `ISO_8601` already requires a component group for any body that is not bare `'P'` — so the
// `total === 0` test was catching legitimate zeros, and `PT0S` is the canonical zero most
// emitters write.
describe('parseDuration and the ISO zero', () => {
  test('every spelling of zero parses to 0', () => {
    expect(parseDuration('PT0S')).toBe(0);
    expect(parseDuration('PT0H0M0S')).toBe(0);
    expect(parseDuration('PT0M')).toBe(0);
    expect(parseDuration('P0W')).toBe(0);
    expect(parseDuration('P0D')).toBe(0);
    expect(parseDuration('0s')).toBe(0);
    expect(parseDuration('0ms')).toBe(0);
  });

  test('a body with no component group is still refused', () => {
    // The case the guard was written for: `'P'` and `'PT'` name no duration at all.
    expect(codeOf(() => parseDuration('P'))).toBe('X_DURATION_INVALID');
    expect(codeOf(() => parseDuration('PT'))).toBe('X_DURATION_INVALID');
    expect(codeOf(() => parseDuration('-P'))).toBe('X_DURATION_INVALID');
  });

  test('non-zero ISO forms are unchanged', () => {
    expect(parseDuration('PT2H30M')).toBe(2 * HOUR + 30 * MINUTE);
    expect(parseDuration('-PT1S')).toBe(-SECOND);
  });
});

// T8. `Math.round` breaks ties toward `+Infinity`, so a signed half rounded asymmetrically:
// `'1500ms'` was 2 and `'-1500ms'` was -1. `packages/money/src/rounding.ts` is the framework's
// correct pattern — carry the sign out, round the magnitude.
describe('toSeconds rounds both signs the same way', () => {
  test('a half rounds away from zero in both directions', () => {
    expect(toSeconds('1500ms')).toBe(2);
    expect(toSeconds('-1500ms')).toBe(-2);
    expect(toSeconds('2500ms')).toBe(3);
    expect(toSeconds('-2500ms')).toBe(-3);
  });

  test('the magnitudes mirror for every value, which is the property that failed', () => {
    // Magnitudes, because the mirror of `0` is `-0` and `toBe` treats those as two values —
    // which is the second half of the fix, not a hole in it.
    for (const ms of [0, 1, 499, 500, 501, 1500, 2500, 999, 1000, 86_400_000]) {
      expect(Math.abs(toSeconds(-ms))).toBe(Math.abs(toSeconds(ms)));
      expect(toSeconds(-ms) <= 0).toBe(true);
    }
  });

  test('zero never comes back as -0, which a Map key and Object.is treat as another value', () => {
    expect(Object.is(toSeconds('-100ms'), 0)).toBe(true);
    expect(Object.is(toSeconds(-0), 0)).toBe(true);
  });

  test('whole seconds are untouched', () => {
    expect(toSeconds('90s')).toBe(90);
    expect(toSeconds('2h')).toBe(7200);
    expect(toSeconds(-3000)).toBe(-3);
  });
});

// T6. `maxUnits: 0` made `pieces.length >= maxUnits` true before the first unit, so every duration
// fell through to the zero fallback: 9,000,000 ms rendered as "0 sec".
describe('formatDuration and maxUnits', () => {
  test('refuses a maxUnits below 1 rather than reporting every duration as zero', () => {
    expect(codeOf(() => formatDuration(9_000_000, 'en', { maxUnits: 0 }))).toBe(
      'X_SCHEDULE_INVALID',
    );
    expect(codeOf(() => formatDuration(9_000_000, 'en', { maxUnits: -1 }))).toBe(
      'X_SCHEDULE_INVALID',
    );
    expect(codeOf(() => formatDuration(9_000_000, 'en', { maxUnits: 1.5 }))).toBe(
      'X_SCHEDULE_INVALID',
    );
    expect(codeOf(() => formatDuration(9_000_000, 'en', { maxUnits: Number.NaN }))).toBe(
      'X_SCHEDULE_INVALID',
    );
  });

  test('a real ceiling still truncates, and a genuine zero still renders', () => {
    expect(formatDuration(9_000_000, 'en', { maxUnits: 1 })).toBe('2 hr');
    expect(formatDuration(9_000_000, 'en', { maxUnits: 2 })).toBe('2 hr 30 min');
    expect(formatDuration(0, 'en')).toBe('0 sec');
  });
});

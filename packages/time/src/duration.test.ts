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

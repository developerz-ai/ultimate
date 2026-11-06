import { describe, expect, test } from 'bun:test';
import { UiError } from './errors';
import { type TimeRangePreset, timeRangeUrl } from './time-range-url';

const PRESETS: readonly TimeRangePreset[] = [
  { id: 'day', label: 'Last 24 hours', seconds: 86_400 },
  { id: 'week', label: 'Last 7 days', seconds: 604_800 },
  { id: 'q1', label: 'Q1', from: '2026-01-01T00:00:00Z', to: '2026-04-01T00:00:00Z' },
];
const NOW = new Date('2026-03-29T12:00:00Z');
const options = { presets: PRESETS, default: 'day', timeZone: 'Europe/Berlin', now: NOW } as const;

describe('timeRangeUrl', () => {
  test('no window in the URL is the default preset, ending now', () => {
    const range = timeRangeUrl('/runs', options);
    expect(range.preset).toBe('day');
    expect(range.invalid).toBe(false);
    expect(range.to.toISOString()).toBe('2026-03-29T12:00:00.000Z');
    expect(range.from.toISOString()).toBe('2026-03-28T12:00:00.000Z');
  });

  test('a named preset is read; a fixed one is its own instants', () => {
    expect(timeRangeUrl('/runs?range=week', options).preset).toBe('week');
    const q1 = timeRangeUrl('/runs?range=q1', options);
    expect([q1.from.toISOString(), q1.to.toISOString()]).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-04-01T00:00:00.000Z',
    ]);
  });

  test('hostile params fall back to the default, and say so', () => {
    for (const query of [
      'range=__proto__',
      'range=constructor',
      'from=2026-03-01T10:00&to=nonsense',
      'from=2026-02-30T10:00&to=2026-03-01T10:00',
      'from=2026-03-01T25:00&to=2026-03-02T10:00',
      'from=2026-03-01T10:00',
    ]) {
      const range = timeRangeUrl(`/runs?${query}`, options);
      expect([query, range.preset, range.invalid]).toEqual([query, 'day', true]);
    }
  });

  test('a backwards custom window is invalid, and the default shows', () => {
    const range = timeRangeUrl('/runs?from=2026-03-10T10:00&to=2026-03-01T10:00', options);
    expect(range.invalid).toBe(true);
    expect(range.preset).toBe('day');
  });

  test('changing the window drops the cursor and keeps every other parameter', () => {
    const range = timeRangeUrl('/runs?status=failed&after=abc&range=week', options);
    expect(range.href({ preset: 'q1' })).toBe('/runs?status=failed&range=q1');
    // The default preset needs no parameter at all.
    expect(range.href({ preset: 'day' })).toBe('/runs?status=failed');
    expect(range.hidden).toEqual([['status', 'failed']]);
    expect(range.action).toBe('/runs');
  });

  test('ns isolates two windows on one page, and a change still drops every cursor', () => {
    const url = '/ops?a.range=week&b.range=q1&a.after=x&b.after=y';
    const a = timeRangeUrl(url, { ...options, ns: 'a' });
    const b = timeRangeUrl(url, { ...options, ns: 'b' });
    expect([a.preset, b.preset]).toEqual(['week', 'q1']);
    expect(a.names).toEqual({ preset: 'a.range', from: 'a.from', to: 'a.to' });
    expect(a.href({ preset: 'q1' })).toBe('/ops?b.range=q1&a.range=q1');
  });

  test('a custom window round-trips across a DST day, in wall-clock time in its zone', () => {
    // Berlin springs forward on 2026-03-29: noon to noon across it is 47 hours, not 48.
    const from = new Date('2026-03-28T11:00:00Z');
    const to = new Date('2026-03-30T10:00:00Z');
    const href = timeRangeUrl('/runs', options).href({ from, to });
    expect(href).toBe('/runs?from=2026-03-28T12%3A00&to=2026-03-30T12%3A00');
    const back = timeRangeUrl(href, options);
    expect(back.preset).toBeUndefined();
    expect([back.from.toISOString(), back.to.toISOString()]).toEqual([
      from.toISOString(),
      to.toISOString(),
    ]);
    expect((back.to.getTime() - back.from.getTime()) / 3_600_000).toBe(47);
    expect(back.local).toEqual({ from: '2026-03-28T12:00', to: '2026-03-30T12:00' });
  });

  test('a preset with neither seconds nor from/to, and a zone that is not IANA, are refused', () => {
    const bad = [{ id: 'oops', label: 'Oops' }];
    expect(() => timeRangeUrl('/', { ...options, presets: bad, default: 'oops' })).toThrow(UiError);
    expect(() =>
      timeRangeUrl('/', {
        ...options,
        presets: [{ id: 'z', label: 'Z', seconds: 0 }],
        default: 'z',
      }),
    ).toThrow('X_UI_INVALID_VALUE');
    expect(() => timeRangeUrl('/', { ...options, default: 'missing' })).toThrow(
      'X_UI_INVALID_VALUE',
    );
    expect(() => timeRangeUrl('/', { ...options, timeZone: 'Mars/Olympus' })).toThrow(
      'X_TIMEZONE_INVALID',
    );
  });
});

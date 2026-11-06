import { describe, expect, test } from 'bun:test';
import { type PlainDate, plainDate } from '@ultimat3/time';
import { orderedRange, pickRange, spanPosition } from './date-range-view';

const d = (value: string): PlainDate => plainDate(value);

describe('date range rules', () => {
  test('the first pick starts a range, the second completes it', () => {
    const first = pickRange({}, d('2026-03-10'));
    expect(first).toEqual({ range: { from: d('2026-03-10'), to: undefined }, complete: false });
    expect(pickRange(first.range, d('2026-03-14'))).toEqual({
      range: { from: d('2026-03-10'), to: d('2026-03-14') },
      complete: true,
    });
  });

  test('a second pick before the first is swapped into order', () => {
    const started = pickRange({}, d('2026-03-10')).range;
    expect(pickRange(started, d('2026-03-02')).range).toEqual({
      from: d('2026-03-02'),
      to: d('2026-03-10'),
    });
    expect(orderedRange({ from: d('2026-03-10'), to: d('2026-03-02') })).toEqual({
      from: d('2026-03-02'),
      to: d('2026-03-10'),
    });
  });

  test('a pick after a complete range starts the next one', () => {
    const done = { from: d('2026-03-02'), to: d('2026-03-10') };
    expect(pickRange(done, d('2026-04-01'))).toEqual({
      range: { from: d('2026-04-01'), to: undefined },
      complete: false,
    });
  });

  test('span membership: both ends and every day between, nothing outside', () => {
    const range = { from: d('2026-03-02'), to: d('2026-03-04') };
    expect(
      ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05'].map((date) =>
        spanPosition(d(date), range),
      ),
    ).toEqual([undefined, 'start', 'inside', 'end', undefined]);
    expect(spanPosition(d('2026-03-02'), { from: d('2026-03-02') })).toBe('start');
    expect(spanPosition(d('2026-03-03'), {})).toBeUndefined();
  });
});

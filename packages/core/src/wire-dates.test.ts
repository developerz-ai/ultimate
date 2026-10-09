// Which values of an answer were instants, named by the server and revived by the client: a list of
// rows folds to one path per column, a column that also holds text is named row by row, and a
// header that does not parse revives nothing.

import { describe, expect, test } from 'bun:test';
import { reviveWireDates, wireDatePaths } from './wire-dates';

/** What the client holds: the body as `JSON.stringify` wrote it, parsed, then revived. */
const roundTrip = (value: unknown): unknown =>
  reviveWireDates(JSON.parse(JSON.stringify(value)) as unknown, wireDatePaths(value) ?? null);

const at = new Date('2026-10-09T12:00:00.000Z');
const later = new Date('2026-10-10T08:30:00.000Z');

describe('wire dates', () => {
  test('an answer with no Date names nothing', () => {
    expect(wireDatePaths([{ title: 'a', when: '2026-10-09T12:00:00.000Z' }])).toBeUndefined();
    expect(wireDatePaths(null)).toBeUndefined();
  });

  test('a list of rows folds to one path per column, nested lists included', () => {
    const rows = [
      { title: 'a', publishedAt: at, comments: [{ createdAt: later }, { createdAt: at }] },
      { title: 'b', publishedAt: later, comments: [] },
    ];
    expect(JSON.parse(decodeURIComponent(wireDatePaths(rows) ?? ''))).toEqual([
      [null, 'publishedAt'],
      [null, 'comments', null, 'createdAt'],
    ]);
    expect(roundTrip(rows)).toEqual(rows);
  });

  test('a column that also holds text revives only the rows that were instants', () => {
    const rows = [{ when: at }, { when: '2026-10-09T12:00:00.000Z' }, { when: null }];
    const back = roundTrip(rows) as { when: unknown }[];
    expect(back[0]?.when).toEqual(at);
    expect(back[1]?.when).toBe('2026-10-09T12:00:00.000Z');
    expect(back[2]?.when).toBeNull();
  });

  test('a single row, a Page envelope, a bare Date and keys that need encoding', () => {
    expect(roundTrip({ id: 'x', 'créé à': at })).toEqual({ id: 'x', 'créé à': at });
    const page = { rows: [{ at }], nextCursor: null, hasMore: false };
    expect(roundTrip(page)).toEqual(page);
    expect(roundTrip(at)).toEqual(at);
  });

  test('an invalid Date is not named, and a toJSON value is not walked', () => {
    const value = { bad: new Date(Number.NaN), wrapped: { toJSON: () => 'text', at } };
    expect(wireDatePaths(value)).toBeUndefined();
  });

  test('a cycle is left for JSON.stringify to refuse, not a stack overflow', () => {
    const node: Record<string, unknown> = { at };
    node['self'] = node;
    expect(wireDatePaths(node)).toBe(encodeURIComponent(JSON.stringify([['at']])));
  });

  test('a header that does not parse, or names what is not there, revives nothing', () => {
    const body = { at: '2026-10-09T12:00:00.000Z' };
    expect(reviveWireDates({ ...body }, '%E0%A4%A')).toEqual(body);
    expect(reviveWireDates({ ...body }, encodeURIComponent('{"no":1}'))).toEqual(body);
    expect(reviveWireDates({ ...body }, encodeURIComponent('[["missing"],[0]]'))).toEqual(body);
  });

  test('a __proto__ key is never assigned through', () => {
    const parsed = JSON.parse('{"__proto__":{"x":"2026-10-09T12:00:00.000Z"}}') as object;
    reviveWireDates(parsed, encodeURIComponent('[["__proto__","x"]]'));
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });
});

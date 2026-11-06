// The runs page's filter: a range read leniently off the URL, a day decided in the member's zone,
// and the tree `<Tree>` draws — newest day first, a leaf per connection.

import { expect, unitTest } from '@ultimat3/testing';
import { plainDate } from '@ultimat3/time';
import { connectionsByDay, createdRange, dayHref, withinCreated } from './connection-filter';

const row = (id: string, createdAt: string) => ({ id, label: id.toUpperCase(), createdAt });

unitTest('a range reads both ends, ignores a malformed one, and swaps a backwards pair', () => {
  expect(createdRange('/runs?from=2026-03-02&to=2026-03-09')).toEqual({
    from: plainDate('2026-03-02'),
    to: plainDate('2026-03-09'),
  });
  expect(createdRange('/runs?from=2026-02-30&to=nonsense')).toEqual({
    from: undefined,
    to: undefined,
  });
  expect(createdRange('/runs?from=2026-03-09&to=2026-03-02')).toEqual({
    from: plainDate('2026-03-02'),
    to: plainDate('2026-03-09'),
  });
});

unitTest('a connection’s day is the member’s day, not the server’s', () => {
  // 23:30 UTC on the 1st is already the 2nd in Tokyo.
  const late = [row('a', '2026-03-01T23:30:00.000Z')];
  const second = { from: plainDate('2026-03-02'), to: plainDate('2026-03-02') };
  expect(withinCreated(late, second, 'Asia/Tokyo')).toHaveLength(1);
  expect(withinCreated(late, second, 'UTC')).toHaveLength(0);
  expect(withinCreated(late, { from: undefined, to: undefined }, 'UTC')).toHaveLength(1);
});

unitTest('the tree is a branch per day, newest first, each connection a leaf', () => {
  const tree = connectionsByDay(
    [
      row('a', '2026-03-01T09:00:00.000Z'),
      row('b', '2026-03-03T09:00:00.000Z'),
      row('c', '2026-03-01T10:00:00.000Z'),
    ],
    'UTC',
    'en',
  );
  expect(tree.map((day) => [day.id, day.label, day.children?.map((leaf) => leaf.id)])).toEqual([
    ['day:2026-03-03', 'March 3, 2026', ['b']],
    ['day:2026-03-01', 'March 1, 2026', ['a', 'c']],
  ]);
  expect(dayHref(plainDate('2026-03-01'))).toBe('/runs?from=2026-03-01&to=2026-03-01');
});

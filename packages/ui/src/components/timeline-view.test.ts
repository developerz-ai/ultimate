import { describe, expect, test } from 'bun:test';
import { timelineGroups } from './timeline-view';

const day = (item: { readonly day: string }): string => item.day;

describe('timelineGroups', () => {
  test('no groupBy is one unlabelled group, and nothing is no group at all', () => {
    expect(timelineGroups([{ day: 'a' }])).toEqual([{ label: undefined, items: [{ day: 'a' }] }]);
    expect(timelineGroups([])).toEqual([]);
    expect(timelineGroups([], day)).toEqual([]);
  });

  test('consecutive items with one label share a header, in the order given', () => {
    const groups = timelineGroups(
      [
        { day: 'Mon', n: 1 },
        { day: 'Mon', n: 2 },
        { day: 'Tue', n: 3 },
      ],
      day,
    );
    expect(groups.map((group) => [group.label, group.items.map((item) => item.n)])).toEqual([
      ['Mon', [1, 2]],
      ['Tue', [3]],
    ]);
  });

  test('a label seen again after another is a second header, never a re-sort', () => {
    const groups = timelineGroups([{ day: 'Mon' }, { day: 'Tue' }, { day: 'Mon' }], day);
    expect(groups.map((group) => group.label)).toEqual(['Mon', 'Tue', 'Mon']);
  });
});

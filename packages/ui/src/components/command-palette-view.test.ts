import { describe, expect, test } from 'bun:test';
import {
  filterItems,
  groupItems,
  keyAction,
  settleActive,
  stepActive,
} from './command-palette-view';

const items = [
  { id: 'new', label: 'New link', hint: 'N' },
  { id: 'settings', label: 'Settings', hint: '' },
  { id: 'link:abc', label: 'abc123', hint: 'https://example.test/docs' },
];

describe('filterItems', () => {
  test('matches label or hint, case-insensitively; an empty query keeps everything', () => {
    expect(filterItems(items, '').map((i) => i.id)).toEqual(['new', 'settings', 'link:abc']);
    expect(filterItems(items, 'SET').map((i) => i.id)).toEqual(['settings']);
    expect(filterItems(items, 'docs').map((i) => i.id)).toEqual(['link:abc']);
    expect(filterItems(items, 'zzz')).toEqual([]);
  });
});

describe('filterItems — groups, keywords, accents', () => {
  const grouped = [
    { id: 'feed', label: 'Feed', hint: '/feed', group: 'Go to' },
    { id: 'café', label: 'Café menu', hint: '', group: 'Go to' },
    { id: 'new', label: 'New post', hint: '', group: 'Create', keywords: ['write', 'compose'] },
    { id: 'cafe-new', label: 'New café', hint: '', group: 'Create' },
  ];

  test('cafe finds Café — accents fold through the one ranker', () => {
    expect(filterItems(grouped, 'cafe').map((i) => i.id)).toEqual(['café', 'cafe-new']);
  });

  test('a keyword matches and is never the label', () => {
    expect(filterItems(grouped, 'compose').map((i) => i.id)).toEqual(['new']);
  });

  test('groups keep the caller order after a filter, even when a later group ranks higher', () => {
    // `n` is a label prefix in Create (rank 0) and only a substring of "Café menu" (rank 2): the
    // ranker alone would put Create first, and the palette's headings would jump on each key.
    expect(filterItems(grouped, 'n').map((i) => i.id)).toEqual(['café', 'new', 'cafe-new']);
    expect(groupItems(filterItems(grouped, 'n')).map((g) => g.group)).toEqual(['Go to', 'Create']);
  });
});

describe('stepActive', () => {
  test('wraps at both ends and starts at the first item when nothing is active', () => {
    expect(stepActive(items, undefined, 1)).toBe('new');
    expect(stepActive(items, 'link:abc', 1)).toBe('new');
    expect(stepActive(items, 'new', -1)).toBe('link:abc');
    expect(stepActive([], 'new', 1)).toBeUndefined();
  });
});

describe('settleActive', () => {
  test('keeps a survivor of a narrowed list, else falls to the first item', () => {
    expect(settleActive(items, 'settings')).toBe('settings');
    expect(settleActive(items, 'gone')).toBe('new');
    expect(settleActive([], 'new')).toBeUndefined();
  });
});

describe('keyAction', () => {
  test('owns exactly the four palette keys', () => {
    expect(keyAction('ArrowDown')).toBe('next');
    expect(keyAction('ArrowUp')).toBe('previous');
    expect(keyAction('Enter')).toBe('run');
    expect(keyAction('Escape')).toBe('close');
    expect(keyAction('a')).toBeNull();
    expect(keyAction('Tab')).toBeNull();
  });
});

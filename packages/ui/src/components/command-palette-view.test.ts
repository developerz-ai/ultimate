import { describe, expect, test } from 'bun:test';
import { filterItems, keyAction, settleActive, stepActive } from './command-palette-view';

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

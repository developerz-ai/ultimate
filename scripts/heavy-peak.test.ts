import { describe, expect, test } from 'bun:test';
import { parseProc, treeRssBytes } from './heavy-peak';

describe('parseProc', () => {
  test('reads pid and ppid past a command name holding spaces and parentheses', () => {
    expect(parseProc('42 (a b) c) S 7 1 1', '100 3 0')).toEqual({
      pid: 42,
      ppid: 7,
      rssBytes: 12_288,
    });
  });
  test('refuses text with no command name', () => {
    expect(parseProc('garbage', '1 2')).toBeUndefined();
  });
});

describe('treeRssBytes', () => {
  test('sums the root and its descendants and nothing else', () => {
    const samples = [
      { pid: 3, ppid: 2, rssBytes: 4 },
      { pid: 2, ppid: 1, rssBytes: 2 },
      { pid: 1, ppid: 0, rssBytes: 1 },
      { pid: 9, ppid: 0, rssBytes: 100 },
    ];
    expect(treeRssBytes(samples, 1)).toBe(7);
  });
});

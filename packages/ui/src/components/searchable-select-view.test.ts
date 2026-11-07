// The searchable select's rules with no renderer: matching folds accents and keeps order within a
// rank, disabled rows never become active, the walk wraps, groups stay together, and an option
// list the control cannot render honestly is refused with the value named.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { optionRank, rankOptions } from './rank-options';
import type { SearchableOption } from './searchable-select-view';
import {
  checkOptions,
  chosenOptions,
  dropLast,
  firstActive,
  pickValue,
  searchableView,
  stepActive,
} from './searchable-select-view';

const opt = (value: string, extra: Partial<SearchableOption> = {}): SearchableOption => ({
  value,
  label: value,
  ...extra,
});

const ZONES: readonly SearchableOption[] = [
  opt('Europe/Berlin', { label: 'Berlin', group: 'Europe' }),
  opt('Europe/London', { label: 'London', group: 'Europe', keywords: ['GMT'] }),
  opt('Europe/Zurich', { label: 'Zürich', group: 'Europe' }),
  opt('America/New_York', { label: 'New York', group: 'America', description: 'Eastern' }),
  opt('America/Los_Angeles', { label: 'Los Angeles', group: 'America', description: 'Pacific' }),
];

const labels = (query: string, options = ZONES, limit = 25): string[] =>
  searchableView(options, query, limit).rows.map((row) => row.option.label);

describe('rankOptions', () => {
  test('cafe finds Café: case and accents fold by the one normaliser', () => {
    expect(rankOptions([opt('c', { label: 'Café' })], 'cafe').matches).toHaveLength(1);
    expect(labels('zur')).toEqual(['Zürich']);
  });

  test('a label prefix, then a word prefix, then a substring', () => {
    const options = [
      opt('a', { label: 'Mid berlin' }),
      opt('b', { label: 'Xberliny' }),
      opt('c', { label: 'Berlin' }),
    ];
    expect(rankOptions(options, 'berlin').matches.map((o) => o.value)).toEqual(['c', 'a', 'b']);
    expect(optionRank(opt('x', { label: 'New York' }), 'york')).toBe(1);
    expect(optionRank(opt('x', { label: 'Newyork' }), 'york')).toBe(2);
  });

  test('order is stable within a rank — the caller’s order, not alphabetical', () => {
    const options = [
      opt('z', { label: 'Bz' }),
      opt('a', { label: 'Ba' }),
      opt('m', { label: 'Bm' }),
    ];
    expect(rankOptions(options, 'b').matches.map((o) => o.value)).toEqual(['z', 'a', 'm']);
  });

  test('description and keywords match; total counts past the cap', () => {
    expect(labels('gmt')).toEqual(['London']);
    expect(labels('pacific')).toEqual(['Los Angeles']);
    const ranked = rankOptions(ZONES, '', 2);
    expect(ranked.matches).toHaveLength(2);
    expect(ranked.total).toBe(5);
  });

  test('a limit that is not a whole number is refused, not a silently empty list', () => {
    expect(() => rankOptions(ZONES, '', Number.NaN)).toThrow(UltimateError);
  });
});

describe('searchableView', () => {
  test('a ranked list is regathered by group, one heading per group', () => {
    const options = [
      opt('a1', { label: 'Pine', group: 'A' }),
      opt('a2', { label: 'Apple', group: 'A' }),
      opt('b1', { label: 'Ap', group: 'B' }),
    ];
    const rows = searchableView(options, 'ap', 25).rows;
    expect(rows.map((r) => [r.option.value, r.opensGroup])).toEqual([
      ['a2', 'A'],
      ['b1', 'B'],
    ]);
  });
});

describe('stepActive', () => {
  const rows = searchableView(
    [opt('a'), opt('b', { disabled: true }), opt('c'), opt('d', { disabled: true })],
    '',
    25,
  ).rows;

  test('disabled rows are never active — the walk steps over them', () => {
    expect(stepActive(rows, 0, 'ArrowDown')).toBe(2);
    expect(stepActive(rows, 2, 'ArrowUp')).toBe(0);
    expect(stepActive(rows, -1, 'End')).toBe(2);
    expect(firstActive(searchableView([opt('x', { disabled: true }), opt('y')], '', 25).rows)).toBe(
      1,
    );
  });

  test('arrows wrap at both ends; page keys stop at the ends', () => {
    expect(stepActive(rows, 2, 'ArrowDown')).toBe(0);
    expect(stepActive(rows, 0, 'ArrowUp')).toBe(2);
    expect(stepActive(rows, 0, 'PageDown')).toBe(2);
    expect(stepActive(rows, 2, 'PageUp')).toBe(0);
  });

  test('a key it does not own is left alone; an all-disabled list has no active row', () => {
    expect(stepActive(rows, 0, 'a')).toBeUndefined();
    const dead = searchableView([opt('x', { disabled: true })], '', 25).rows;
    expect(stepActive(dead, -1, 'ArrowDown')).toBe(-1);
  });
});

describe('picks', () => {
  test('one value replaces; many toggles; Backspace drops the newest', () => {
    expect(pickValue(['a'], 'b', false)).toEqual(['b']);
    expect(pickValue(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(pickValue(['a', 'b'], 'a', true)).toEqual(['b']);
    expect(dropLast(['a', 'b'])).toEqual(['a']);
    expect(chosenOptions(ZONES, ['Europe/Zurich']).map((o) => o.label)).toEqual(['Zürich']);
  });
});

describe('checkOptions', () => {
  const refusal = (options: readonly SearchableOption[], chosen: readonly string[] = []) => {
    try {
      checkOptions(options, chosen);
    } catch (error) {
      return error instanceof UltimateError ? `${error.code} ${error.message}` : 'not coded';
    }
    return 'accepted';
  };

  test('two options under one value are refused, the value named', () => {
    expect(refusal([opt('a'), opt('a')])).toContain('X_UI_INVALID_VALUE');
    expect(refusal([opt('a'), opt('a')])).toContain('"a"');
  });

  test('a group split in two is refused', () => {
    const split = [opt('a', { group: 'G' }), opt('b'), opt('c', { group: 'G' })];
    expect(refusal(split)).toContain('split');
    expect(refusal(ZONES)).toBe('accepted');
  });

  test('a chosen value naming no option is refused', () => {
    expect(refusal(ZONES, ['Mars/Olympus'])).toContain('Mars/Olympus');
  });
});

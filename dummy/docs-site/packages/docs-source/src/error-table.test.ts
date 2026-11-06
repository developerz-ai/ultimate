import { expect, test } from 'bun:test';
import { cellsOf, codesOf, codeUrl } from './error-table';
import { majorOf, majorUrl } from './upgrading';

test('cellsOf splits on unescaped pipes only and drops the outer ones', () => {
  expect(cellsOf('| `a` | b \\| c | d |')).toEqual(['`a`', 'b \\| c', 'd']);
});

test('codesOf reads one code, a joined pair, and nothing from prose', () => {
  expect(codesOf('`X_A`')).toEqual(['X_A']);
  expect(codesOf('`X_A` / `X_B`, `X_C`')).toEqual(['X_A', 'X_B', 'X_C']);
  expect(codesOf('`X_SIDE_EFFECTS_*`')).toEqual([]);
  expect(codesOf('see `X_A`')).toEqual([]);
});

test('URLs and the major a heading names', () => {
  expect(codeUrl('X_A')).toBe('/errors/X_A');
  expect(majorUrl(30)).toBe('/upgrading/30');
  const heading = (level: number, text: string) => ({ level, heading: text, anchor: '', line: 0 });
  expect(majorOf(heading(2, '4.1.0 → 5.0.0, entry by entry'))).toBe(5);
  expect(majorOf(heading(3, '29.x → 30.0.0'))).toBeUndefined();
  expect(majorOf(heading(2, 'Release policy'))).toBeUndefined();
});

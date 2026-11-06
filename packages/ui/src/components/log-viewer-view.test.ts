// The log window: level floor, text filter, the newest `cap` kept and the rest counted, and a cap
// that is not a count refused.

import { expect, test } from 'bun:test';
import { type LogLine, logWindow } from './log-viewer-view';

const lines: LogLine[] = [
  { id: '1', text: 'boot', level: 'debug' },
  { id: '2', text: 'Listening on :3000', level: 'info' },
  { id: '3', text: 'slow query', level: 'warn' },
  { id: '4', text: 'X_DB_DOWN', level: 'error' },
  { id: '5', text: 'plain line' },
];

const ids = (window: { lines: readonly LogLine[] }): string[] =>
  window.lines.map((line) => line.id);

test('a level keeps itself and everything above it; an unlevelled line always passes', () => {
  expect(ids(logWindow(lines, { minimum: 'warn', locale: 'en' }))).toEqual(['3', '4', '5']);
  expect(ids(logWindow(lines, { locale: 'en' }))).toEqual(['1', '2', '3', '4', '5']);
});

test('the filter matches case-insensitively in the given locale', () => {
  expect(ids(logWindow(lines, { query: 'LISTEN', locale: 'en' }))).toEqual(['2']);
  expect(
    ids(logWindow([{ id: 'i', text: 'İSTANBUL' }], { query: 'istanbul', locale: 'tr' })),
  ).toEqual(['i']);
});

test('the newest cap lines are kept and the rest counted', () => {
  const many = Array.from({ length: 100_000 }, (_, i) => ({ id: String(i), text: `line ${i}` }));
  const window = logWindow(many, { cap: 2_000, locale: 'en' });
  expect(window.lines).toHaveLength(2_000);
  expect(window.dropped).toBe(98_000);
  expect(window.lines.at(-1)?.id).toBe('99999');
});

test('a cap that is not a whole count is refused', () => {
  expect(() => logWindow(lines, { cap: Number.NaN, locale: 'en' })).toThrow();
  expect(() => logWindow(lines, { cap: 0, locale: 'en' })).toThrow();
});

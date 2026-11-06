import { describe, expect, test } from 'bun:test';
import { leadOf, plainText } from './lead';

describe('leadOf', () => {
  test('skips headings, tables, fences and blank lines, and keeps the first sentence', () => {
    const text = ['## H', '', '| a | b |', '```', 'code.', '```', 'One [link](x). Two.'].join('\n');
    expect(leadOf(text)).toBe('One link.');
  });

  test('a line with no sentence end is the whole line; a list item loses its marker', () => {
    expect(leadOf('- `x verify` is the gate')).toBe('x verify is the gate');
  });

  test('a long sentence is cut at a word, with an ellipsis', () => {
    const lead = leadOf(`${'word '.repeat(80)}end.`);
    expect(lead.length).toBeLessThanOrEqual(160);
    expect(lead.endsWith('word…')).toBe(true);
  });

  test('nothing to read is empty', () => {
    expect(leadOf('## only\n\n| t |')).toBe('');
  });
});

test('plainText drops quote marks and emphasis', () => {
  expect(plainText('> **Bold** and _it_')).toBe('Bold and it');
});

test('plainText keeps the underscores of an identifier, in code or out', () => {
  expect(plainText('`X_DB_DRIFT` or X_DB_DRIFT, __bold__')).toBe('X_DB_DRIFT or X_DB_DRIFT, bold');
});

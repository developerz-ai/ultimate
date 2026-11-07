// Terminal output: colours become roles, every escape is dropped and never printed, and a
// 256-colour or truecolor run gets no raw colour — only the default foreground.

import { describe, expect, test } from 'bun:test';
import { parseAnsi } from './ansi';

const joined = (text: string): string =>
  parseAnsi(text)
    .map((line) => line.map((run) => run.text).join(''))
    .join('\n');

describe('parseAnsi', () => {
  test('SGR colours map to semantic roles and reset', () => {
    const [line] = parseAnsi('\u001b[31merror\u001b[0m ok \u001b[1;92mpass\u001b[39m');
    expect(line).toEqual([
      { text: 'error', fg: 'danger' },
      { text: ' ok ' },
      { text: 'pass', fg: 'success', bold: true },
    ]);
  });

  test('no escape or control byte survives, on hostile sequences', () => {
    const hostile = [
      '\u001b[2J\u001b[Hcleared',
      '\u001b]0;title\u0007after',
      '\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\',
      '\u001b[?25lhidden\u001b[?25h',
      'bell\u0007 back\bspace\u0000nul\u009bcsi',
      '\u001b',
      '\u001b[',
      '\u001b[38;5;196mred256\u001b[38;2;255;0;0mtrue',
    ].join('\n');
    const text = joined(hostile);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the assertion is about control bytes
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(text).toContain('cleared');
    expect(text).toContain('after');
    expect(text).toContain('link');
    expect(text).not.toContain('title');
  });

  test('256-colour and truecolor fall to the default foreground', () => {
    const [line] = parseAnsi('\u001b[31mred\u001b[38;5;196mx\u001b[38;2;1;2;3my');
    expect(line?.[0]).toEqual({ text: 'red', fg: 'danger' });
    expect(line?.[1]).toEqual({ text: 'x' });
    expect(line?.[2]).toEqual({ text: 'y' });
    expect(JSON.stringify(line)).not.toMatch(/\d{2,3},|rgb|#[0-9a-f]{3}/i);
  });

  test('lines split on newline, a trailing one adds no empty line', () => {
    expect(parseAnsi('a\nb\n')).toHaveLength(2);
    expect(parseAnsi('')).toEqual([[]]);
  });
});

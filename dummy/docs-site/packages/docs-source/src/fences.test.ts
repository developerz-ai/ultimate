import { describe, expect, test } from 'bun:test';
import { fencedLines, stripComments } from './fences';

describe('fencedLines', () => {
  test('marks the fence and its body, and a longer or other-character marker does not close it', () => {
    const lines = ['a', '````md', '```', '~~~', '````', 'b', '~~~', '# c', '~~~'];
    expect(fencedLines(lines)).toEqual([false, true, true, true, true, false, true, true, true]);
  });

  test('a closing marker with text after it is a line of the fence, not its end', () => {
    expect(fencedLines(['```', '``` js', '```', 'x'])).toEqual([true, true, true, false]);
  });
});

describe('stripComments', () => {
  test('drops a one-line and a multi-line comment, and the lines that held only them', () => {
    const text = ['one <!-- note --> two', '<!--', 'hidden', '-->', 'three  '].join('\n');
    expect(stripComments(text)).toBe(['one  two', 'three  '].join('\n'));
  });

  test('keeps a comment inside a fence, byte for byte', () => {
    const text = ['```html', '<!-- kept -->', '```'].join('\n');
    expect(stripComments(text)).toBe(text);
  });

  test('a comment that opens and closes mid-line keeps the text either side', () => {
    expect(stripComments('a <!--\nx\n--> b')).toBe('a\n b');
  });
});

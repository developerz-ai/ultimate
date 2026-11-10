// The generated-block reader and writer: a block is found only between its own two markers.

import { describe, expect, test } from 'bun:test';
import { fillGenerated, GENERATED_CLOSE, generatedOpen, readGenerated } from './generated-block';

const FIX = 'bun run scripts/fixture.ts --write';
const page = (body: readonly string[]): string =>
  ['# Page', generatedOpen('facts', FIX), ...body, GENERATED_CLOSE, 'after'].join('\n');

describe('generated blocks', () => {
  test('reads the lines between the markers', () => {
    expect(readGenerated(page(['a', 'b']), 'facts', FIX)).toEqual(['a', 'b']);
  });

  test('a block of another name, or with no close, is no block', () => {
    expect(readGenerated(page(['a']), 'other', FIX)).toBeUndefined();
    expect(readGenerated(`${generatedOpen('facts', FIX)}\na`, 'facts', FIX)).toBeUndefined();
    expect(fillGenerated(`${generatedOpen('facts', FIX)}\na`, 'facts', FIX, ['b'])).toBeUndefined();
  });

  test('a close BEFORE the open does not end the block', () => {
    const text = [GENERATED_CLOSE, generatedOpen('facts', FIX), 'a'].join('\n');
    expect(readGenerated(text, 'facts', FIX)).toBeUndefined();
  });

  test('fills the body and keeps everything around it', () => {
    expect(fillGenerated(page(['old', 'lines']), 'facts', FIX, ['new'])).toBe(page(['new']));
  });
});

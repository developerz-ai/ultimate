// The inline parser's own bounds: what a hostile paragraph can make it recurse into. The block
// grammar and the tree it builds are `markdown-parse.test.ts`'s.

import { describe, expect, test } from 'bun:test';
import { parseInline } from './markdown-inline';

describe('parseInline · nesting is bounded', () => {
  // 180 KB of `![`, well under any size cap a caller applies: an image's alt was walked at every
  // level with no depth guard, so the parse ended in a bare `RangeError` instead of a tree.
  test('20,000 nested ![ parse without throwing and stay under the depth cap', () => {
    const levels = 20_000;
    const nodes = parseInline(`${'!['.repeat(levels)}x${'](u)'.repeat(levels)}`);

    expect(nodes).toHaveLength(1);
    const [image] = nodes;
    if (image?.kind !== 'image') expect.unreachable('the outermost ![ is not an image');
    expect(image.src).toBe('u');
    // Past the cap the alt is the source text, as a link's children are: nothing is dropped.
    expect(image.alt).toContain('![x](u)');
  });

  test('an image nested inside the cap still has its markup read out of the alt', () => {
    expect(parseInline('![a *b* ![c](v)](u)')).toEqual([{ kind: 'image', src: 'u', alt: 'a b c' }]);
  });
});

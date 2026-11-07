import { describe, expect, test } from 'bun:test';
import { type LinkAt, rewriteLinks } from './links';

const upper = (link: LinkAt): string => link.target.toUpperCase();

describe('rewriteLinks', () => {
  test('rewrites a link, an image and a titled link, keeping text and title', () => {
    expect(rewriteLinks('[a](x) ![b](y) [c](z "t")', upper)).toBe('[a](X) ![b](Y) [c](Z "t")');
  });

  test('a bracketed text and a parenthesised target are one link each', () => {
    expect(rewriteLinks('[`a` [b]](p(q))', upper)).toBe('[`a` [b]](P(Q))');
  });

  test('never touches a code span or a fence', () => {
    const text = ['`[a](x)` [b](y)', '```', '[c](z)', '```'].join('\n');
    expect(rewriteLinks(text, upper)).toBe(['`[a](x)` [b](Y)', '```', '[c](z)', '```'].join('\n'));
  });

  test('undefined from the resolver leaves the link as written, and the line is 0-based', () => {
    const seen: LinkAt[] = [];
    const out = rewriteLinks('a\n[b](https://x.dev)', (link) => {
      seen.push(link);
      return undefined;
    });
    expect(out).toBe('a\n[b](https://x.dev)');
    expect(seen).toEqual([{ line: 1, target: 'https://x.dev' }]);
  });
});

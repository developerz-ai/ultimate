// The stamp a browser's typed client derives every action URL under — and the absence of one,
// which is what an app that declared no `pathStyle` has always rendered.

import { describe, expect, test } from 'bun:test';
import { clientPathStyleTags } from './client-path-style-tag';
import { renderHead } from './head';

describe('clientPathStyleTags', () => {
  test("a 'readable' server stamps the one meta core's `actionPath` reads", () => {
    expect(renderHead(clientPathStyleTags('readable'))).toBe(
      '<meta name="ultimate-path-style" content="readable">',
    );
  });

  test("the default style is no tag at all — absent IS 'resource', and the document's bytes hold", () => {
    expect(clientPathStyleTags('resource')).toEqual([]);
  });

  test('the tag is keyed, so a second stamp replaces the first instead of doubling it', () => {
    expect(clientPathStyleTags('readable').map((tag) => tag.key)).toEqual([
      'meta:ultimate-path-style',
    ]);
  });
});

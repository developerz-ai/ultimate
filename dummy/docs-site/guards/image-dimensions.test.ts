// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { unsizedImages } from './image-dimensions';

const file = (source: string) => [{ path: 'apps/web/site/page.tsx', source }];

unitTest('an img with no dimensions is refused, and the finding names the line', () => {
  const findings = unsizedImages(file('<main>\n  <img src="/hero.png" alt="" />\n</main>'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_IMAGE_DIMENSIONS');
  expect(findings[0]?.cause).toContain(':2');
  expect(findings[0]?.fix).toContain('aspect-ratio');
});

unitTest('a width without a height is half a box, and half is none', () => {
  expect(unsizedImages(file('<img src="/a.png" width={800} alt="" />'))).toHaveLength(1);
});

unitTest('the pair satisfies it, and so does an aspect-ratio on its own', () => {
  expect(unsizedImages(file('<img src="/a.png" width={800} height={600} alt="" />'))).toEqual([]);
  const styled = '<img src="/a.png" style={{ "aspect-ratio": "16 / 9" }} alt="" />';
  expect(unsizedImages(file(styled))).toEqual([]);
});

unitTest('the framework wrapper is the same element for this purpose', () => {
  expect(unsizedImages(file('<Image src="/a.png" alt="" />'))).toHaveLength(1);
});

unitTest('a lazy priority image is its own finding, with its own edit', () => {
  const source = '<img src="/hero.png" width={800} height={600} priority loading="lazy" alt="" />';
  const findings = unsizedImages(file(source));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.fix).toContain('delete loading="lazy"');
});

unitTest('lazy without priority is the right thing to write', () => {
  const source = '<img src="/thumb.png" width={80} height={80} loading="lazy" alt="" />';
  expect(unsizedImages(file(source))).toEqual([]);
});

// Nothing inside a <template> is laid out, so nothing inside one can shift anything.
unitTest('an img inside a template shifts nothing and is not reported', () => {
  const source = '<template><img src="/a.png" alt="" /></template>';
  expect(unsizedImages(file(source))).toEqual([]);
});

unitTest('maxWidth is not width, and a commented-out img is not an element', () => {
  expect(unsizedImages(file('<img src="/a.png" maxWidth={8} height={6} alt="" />'))).toHaveLength(
    1,
  );
  expect(unsizedImages(file('// <img src="/a.png" alt="" />\nconst a = 1;'))).toEqual([]);
});

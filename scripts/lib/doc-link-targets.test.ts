// `doc-link-targets.ts`: which `](target)` a page links, resolved to the repo path a reader lands on.

import { describe, expect, test } from 'bun:test';
import { linkTargetsIn, resolveLinkTarget } from './doc-link-targets';

describe('resolving a link target', () => {
  test('a relative path resolves against the linking page’s directory', () => {
    expect(resolveLinkTarget('docs/idea/README.md', '../architecture/15-adding-a-feature.md')).toBe(
      'docs/architecture/15-adding-a-feature.md',
    );
    expect(resolveLinkTarget('packages/core/README.md', './src/errors.ts#L10')).toBe(
      'packages/core/src/errors.ts',
    );
    expect(resolveLinkTarget('README.md', 'wiki/Home.md?plain=1')).toBe('wiki/Home.md');
  });

  test('a bare wiki name is the wiki page GitHub renders it as', () => {
    expect(resolveLinkTarget('wiki/Home.md', 'Error-Codes#x_db_drift')).toBe('wiki/Error-Codes.md');
    expect(resolveLinkTarget('wiki/Home.md', '_Footer')).toBe('wiki/_Footer.md');
    expect(resolveLinkTarget('wiki/Home.md', '../docs/ops/README.md')).toBe('docs/ops/README.md');
  });

  test('a URL, a mail address, a bare fragment and a placeholder name no file in this tree', () => {
    for (const target of ['https://x.dev/a', 'mailto:a@b.c', '#heading', '<path>', '../x/*.md']) {
      expect(resolveLinkTarget('wiki/Home.md', target)).toBeUndefined();
    }
  });

  test('a link climbing out of the repository is not a file in it', () => {
    expect(resolveLinkTarget('README.md', '../elsewhere/README.md')).toBeUndefined();
  });

  test('a leading slash is the repository root, as GitHub resolves it', () => {
    expect(resolveLinkTarget('docs/idea/README.md', '/scripts/doc-paths.ts')).toBe(
      'scripts/doc-paths.ts',
    );
  });
});

describe('reading a line', () => {
  test('inline links and images, never a link inside a code span', () => {
    const line = 'see [a](./a.md "title"), ![b](img/b.png) and `[c](./c.md)` and [d](<d e.md>)';
    expect(linkTargetsIn(line)).toEqual(['./a.md', 'img/b.png', 'd e.md']);
  });
});

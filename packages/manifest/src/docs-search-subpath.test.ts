// `@ultimat3/manifest/docs-search` is the ranker WITHOUT the barrel: an island that searches docs
// (dummy/docs-site's `/search`) must pay for `searchDocs` and its tokenizer alone, never for the
// scanner's `node:fs` walk or the manifest's generators. Pinned by resolving the SPECIFIER and by
// bundling it for a browser, so a value import added to the leaf's graph reds here.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no path API; the package root is this file's parent's parent.
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

describe('unit · the docs-search subpath', () => {
  test('is a published subpath of the package', async () => {
    const pkg: unknown = await Bun.file(join(ROOT, 'package.json')).json();
    expect(pkg).toMatchObject({ exports: { './docs-search': './src/docs-search-subpath.ts' } });
  });

  test('resolves by its specifier and carries the ranker, not the scanner', async () => {
    const leaf: Record<string, unknown> = await import('@ultimat3/manifest/docs-search');
    expect(leaf['searchDocs']).toBeTypeOf('function');
    expect(leaf['nearestTopics']).toBeTypeOf('function');
    expect(leaf['scanInstalledDocs']).toBeUndefined();
    expect(leaf['scanWikiDocs']).toBeUndefined();
  });

  test('a browser bundle of it holds no node: import and no filesystem read', async () => {
    const built = await Bun.build({
      entrypoints: [join(ROOT, 'src', 'docs-search-subpath.ts')],
      target: 'browser',
      minify: true,
    });
    expect(built.success).toBe(true);
    const [output] = built.outputs;
    if (output === undefined) return expect.unreachable('Bun.build wrote no output');
    const code = await output.text();
    expect(code).not.toContain('node:');
    expect(code).not.toContain('readdir');
    // The ranker and its tokenizer, minified: a few kB. A barrel import would be hundreds.
    expect(code.length).toBeLessThan(12_000);
  });
});

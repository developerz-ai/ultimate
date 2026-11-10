// `@ultimat3/seo/adapter` resolves through the package's export map and carries exactly the driver
// author's values — each the declaring module's by identity, and none of them also on `.`.

import { describe, expect, test } from 'bun:test';
import * as errors from './errors';

const VALUES: readonly string[] = ['notImplementedDriver'];
const DECLARED: Record<string, unknown> = { ...errors };

describe('unit · @ultimat3/seo/adapter', () => {
  test('is the subpath the export map names', () => {
    expect(import.meta.resolve('@ultimat3/seo/adapter')).toEndWith(
      // a file: URL — '/' on every OS
      '/packages/seo/src/adapter.ts',
    );
  });

  test('carries exactly its values, each the declaring export by identity', async () => {
    const adapter: Record<string, unknown> = await import('@ultimat3/seo/adapter');
    expect(Object.keys(adapter).sort()).toEqual([...VALUES].sort());
    for (const name of VALUES)
      expect([name, adapter[name] === DECLARED[name]]).toEqual([name, true]);
  });

  test('`.` carries none of them, nor the internals v31 dropped from it', async () => {
    const barrel: Record<string, unknown> = await import('@ultimat3/seo');
    const gone = [
      ...VALUES,
      'canonicalMismatch',
      'IMAGE_QUERY_KEYS',
      'MIME_TYPES',
      'sitemapTooLarge',
    ];
    for (const name of gone) expect([name, Object.hasOwn(barrel, name)]).toEqual([name, false]);
  });
});

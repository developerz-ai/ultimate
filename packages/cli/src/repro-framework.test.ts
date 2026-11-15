// The framework checkout `create-ultimate repro` links: found walking up from inside one, never
// from outside; a `packages/core` that is not `@ultimat3/core` is no checkout; one override per
// `@ultimat3/*` package, onto its source directory.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join, resolve } from 'node:path';
import { frameworkCheckoutFrom, frameworkOverrides, isFrameworkCheckout } from './repro-framework';

const CHECKOUT = resolve(import.meta.dir, '..', '..', '..');
const outside = mkdtempSync(join(tmpdir(), 'x-repro-framework-'));
afterAll(() => rmSync(outside, { recursive: true, force: true }));
await Bun.write(join(outside, 'packages/core/package.json'), '{ "name": "@someone/core" }');
await Bun.write(join(outside, 'packages/ui/package.json'), '{ "name": "@ultimat3/ui" }');

describe('repro-framework', () => {
  test('a cwd inside the checkout walks up to it; one outside finds none', () => {
    expect(frameworkCheckoutFrom(join(CHECKOUT, 'packages', 'cli', 'src'))).toBe(CHECKOUT);
    expect(frameworkCheckoutFrom(join(outside, 'packages'))).toBeUndefined();
  });

  test('a packages/core of another name is no checkout', () => {
    expect(isFrameworkCheckout(CHECKOUT)).toBe(true);
    expect(isFrameworkCheckout(outside)).toBe(false);
  });

  test('one file: override per @ultimat3/* package, nothing else', async () => {
    const overrides = await frameworkOverrides(CHECKOUT);
    expect(overrides['@ultimat3/core']).toBe(`file:${join(CHECKOUT, 'packages', 'core')}`);
    expect(Object.keys(overrides).every((name) => name.startsWith('@ultimat3/'))).toBe(true);
    expect(await frameworkOverrides(outside)).toEqual({
      '@ultimat3/ui': `file:${join(outside, 'packages', 'ui')}`,
    });
  });
});

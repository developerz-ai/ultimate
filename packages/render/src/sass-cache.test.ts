// The Sass compile cache: a hit only while every file the stored compilation read is unchanged,
// and never a failure of the compile it stands in for.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, no recursive remove and no synchronous write for fixture setup.
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { compileStylesheet } from './css-modules';
import { cachedSassCompile, type SassOutput, setSassCacheDir } from './sass-cache';

let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'x-sass-cache-'));
});

afterEach(() => {
  setSassCacheDir(undefined);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A compile that counts its calls and reports `deps` as what it read. */
const counting = (css: string, deps: readonly string[]) => {
  let calls = 0;
  const compile = (): SassOutput => {
    calls += 1;
    return { css, loaded: [...deps] };
  };
  return { compile, calls: () => calls };
};

describe('unit · the Sass compile cache', () => {
  test('a second compile of the same key reads the stored css and never compiles', () => {
    const cache = join(dir, 'hit');
    const dep = join(dir, 'hit-tokens.scss');
    writeFileSync(dep, '$a: 1;');
    setSassCacheDir(cache);
    const first = counting('.a{color:red}', [dep]);
    expect(cachedSassCompile('k', first.compile)).toBe('.a{color:red}');
    const second = counting('.never{}', [dep]);
    expect(cachedSassCompile('k', second.compile)).toBe('.a{color:red}');
    expect([first.calls(), second.calls()]).toEqual([1, 0]);
  });

  test('a changed file the compilation read is a miss — an edited token recompiles', () => {
    const cache = join(dir, 'stale');
    const dep = join(dir, 'stale-tokens.scss');
    writeFileSync(dep, '$a: 1;');
    setSassCacheDir(cache);
    cachedSassCompile('k', counting('.old{}', [dep]).compile);
    writeFileSync(dep, '$a: 2; // a different size and different bytes');
    const again = counting('.new{}', [dep]);
    expect(cachedSassCompile('k', again.compile)).toBe('.new{}');
    expect(again.calls()).toBe(1);
  });

  test('a deleted file the compilation read is a miss', () => {
    const cache = join(dir, 'gone');
    const dep = join(dir, 'gone-tokens.scss');
    writeFileSync(dep, '$a: 1;');
    setSassCacheDir(cache);
    cachedSassCompile('k', counting('.old{}', [dep]).compile);
    rmSync(dep);
    const again = counting('.new{}', []);
    expect(cachedSassCompile('k', again.compile)).toBe('.new{}');
  });

  test('a different key is a different entry', () => {
    setSassCacheDir(join(dir, 'keys'));
    cachedSassCompile('one', counting('.one{}', []).compile);
    expect(cachedSassCompile('two', counting('.two{}', []).compile)).toBe('.two{}');
  });

  test('a corrupt entry is a miss, never a throw', () => {
    const cache = join(dir, 'corrupt');
    setSassCacheDir(cache);
    cachedSassCompile('k', counting('.a{}', []).compile);
    for (const name of readdirSync(cache)) writeFileSync(join(cache, name), '{"v":1,"css":');
    expect(cachedSassCompile('k', counting('.b{}', []).compile)).toBe('.b{}');
  });

  test('an unwritable cache directory costs the cache, never the compile', () => {
    const cache = join(dir, 'readonly');
    setSassCacheDir(cache);
    cachedSassCompile('seed', counting('.a{}', []).compile);
    chmodSync(cache, 0o500);
    try {
      expect(cachedSassCompile('k', counting('.b{}', []).compile)).toBe('.b{}');
    } finally {
      chmodSync(cache, 0o700);
    }
  });

  test('null turns it off: every compile runs', () => {
    setSassCacheDir(null);
    const off = counting('.a{}', []);
    cachedSassCompile('k', off.compile);
    cachedSassCompile('k', off.compile);
    expect(off.calls()).toBe(2);
  });

  test('compileStylesheet answers the same css and classes from the cache as from Sass', () => {
    const file = join(dir, 'card.module.scss');
    const partial = join(dir, '_mixins.scss');
    writeFileSync(partial, '@mixin pad { padding: 1px; }');
    const source =
      "@use 'mixins';\n:global(html[data-theme='light']) .card { @include mixins.pad; }";
    setSassCacheDir(null);
    const uncached = compileStylesheet(file, source);
    setSassCacheDir(join(dir, 'real'));
    const cold = compileStylesheet(file, source);
    const warm = compileStylesheet(file, source);
    expect(cold).toEqual(uncached);
    expect(warm).toEqual(uncached);
    // And the partial it @use-d is part of the entry: editing it changes the answer.
    writeFileSync(partial, '@mixin pad { padding: 2px; }');
    expect(compileStylesheet(file, source).css).toContain('padding:2px');
  });
});

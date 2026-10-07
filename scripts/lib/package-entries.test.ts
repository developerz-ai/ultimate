// The values a re-export is measured against come from the packages themselves: every `exports`
// key of every `@ultimat3/*` manifest scanned, the static read equal to the runtime namespace, and
// a fix line aimed at the DECLARING package through its narrowest entry.

import { describe, expect, test } from 'bun:test';
import * as coreIndex from '../../packages/core/src/index';
import * as corePage from '../../packages/core/src/page';
import {
  entryFor,
  homeOf,
  isPackageValue,
  PACKAGE_ENTRIES,
  packageOfPath,
} from './package-entries';

describe('every entry every package publishes', () => {
  test('one entry per module `exports` key, for every @ultimat3 manifest', async () => {
    const glob = new Bun.Glob('packages/*/package.json');
    const expected: string[] = [];
    for (const path of glob.scanSync('.')) {
      const manifest = (await Bun.file(path).json()) as {
        readonly name: string;
        readonly exports?: Readonly<Record<string, string>>;
      };
      if (!manifest.name.startsWith('@ultimat3/')) continue;
      for (const [key, target] of Object.entries(manifest.exports ?? {})) {
        if (/\.tsx?$/.test(target) && !key.includes('*')) expected.push(`${manifest.name}${key}`);
      }
    }
    const found = PACKAGE_ENTRIES.filter((e) => !e.file.includes('/icons/')).map(
      (e) => `${e.pkg}${e.subpath}`,
    );
    expect(found.sort()).toEqual(expected.sort());
    expect(PACKAGE_ENTRIES.length).toBeGreaterThan(40);
  });

  test('a `*` key is expanded, one specifier per module it matches', () => {
    const icons = PACKAGE_ENTRIES.filter((e) => e.specifier.startsWith('@ultimat3/ui/icons/'));
    expect(icons.length).toBeGreaterThan(0);
    expect(icons.every((e) => !e.specifier.includes('*'))).toBe(true);
  });

  test('the static read IS the runtime namespace — values in, types out', () => {
    expect([...(entryFor('@ultimat3/core')?.values ?? [])].sort()).toEqual(
      Object.keys(coreIndex).sort(),
    );
    expect([...(entryFor('@ultimat3/core/page')?.values ?? [])].sort()).toEqual(
      Object.keys(corePage).sort(),
    );
    expect(isPackageValue('@ultimat3/core', 'UltimateError')).toBe(true);
    expect(isPackageValue('@ultimat3/core', 'Page')).toBe(false);
    expect(isPackageValue('./local', 'UltimateError')).toBe(false);
  });

  test('a repo path belongs to its package, the unscoped one included', () => {
    expect(packageOfPath('packages/core/src/errors.ts')).toBe('@ultimat3/core');
    expect(packageOfPath('packages/create-ultimate/src/index.ts')).toBe('create-ultimate');
    expect(packageOfPath('scripts/x.ts')).toBeUndefined();
  });
});

describe('the home a fix line names', () => {
  test('a browser-safe core value is imported from /page, the narrower entry', () => {
    const both = [...(entryFor('@ultimat3/core/page')?.values ?? [])].find((name) =>
      entryFor('@ultimat3/core')?.values.has(name),
    );
    expect(both).toBeDefined();
    expect(homeOf('@ultimat3/core', both ?? '')).toEqual({
      specifier: '@ultimat3/core/page',
      name: both ?? '',
    });
  });

  test('a value only the root carries stays at the root', () => {
    const rootOnly = [...(entryFor('@ultimat3/core')?.values ?? [])].find(
      (name) => !entryFor('@ultimat3/core/page')?.values.has(name),
    );
    expect(homeOf('@ultimat3/core', rootOnly ?? '').specifier).toBe('@ultimat3/core');
  });

  test("a re-exported value's home is the package that declares it, not the barrel", () => {
    expect(homeOf('@ultimat3/action', 't')).toEqual({ specifier: '@ultimat3/schema', name: 't' });
    // i18n's `t` is a different value of the same name: it is i18n's own.
    expect(homeOf('@ultimat3/i18n', 't').specifier).toBe('@ultimat3/i18n');
  });
});

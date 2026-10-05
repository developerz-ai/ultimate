// The stylesheet registry compares paths it was handed by three different callers — the Bun
// plugin, `loadApp`'s root and a package's `import.meta.dir` — and on Windows every one of them
// arrives as `D:\…`. Windows-shaped inputs here, so the rule is proved on the Linux runner too.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  claimStylesheets,
  clearStylesheets,
  loadStylesheet,
  registeredStylesheets,
  setStylesheetRoot,
  stylesFor,
} from './module-loader';
import { comparablePath, isPathBelow } from './stylesheet-path';

afterEach(() => {
  clearStylesheets();
  setStylesheetRoot(undefined);
});

describe('comparablePath', () => {
  test('a Windows path is spelled with `/`, its drive letter upper-cased, `..` folded', () => {
    expect(comparablePath('d:\\a\\app\\apps\\..\\apps\\web\\')).toBe('D:/a/app/apps/web');
  });

  test('a POSIX absolute path is left where it is — never re-rooted on a drive', () => {
    expect(comparablePath('/srv/demo/')).toBe('/srv/demo');
    expect(comparablePath('/')).toBe('/');
  });

  test('a relative path is resolved against the working directory', () => {
    expect(comparablePath('app')).toBe(comparablePath(`${process.cwd()}/app`));
  });
});

describe('isPathBelow', () => {
  test('a directory covers what sits below it and nothing beside it', () => {
    expect(isPathBelow('D:/a/admin/src/x.scss', 'D:/a/admin/src')).toBe(true);
    expect(isPathBelow('D:/a/admin/srcx/x.scss', 'D:/a/admin/src')).toBe(false);
    expect(isPathBelow('/app/x.scss', '/')).toBe(true);
  });
});

describe('the registry on Windows-shaped paths', () => {
  test('a claim made with backslashes covers the sheets the plugin hands it with backslashes', () => {
    claimStylesheets('D:\\srv\\demo\\node_modules\\@acme\\admin\\src', 'app');
    loadStylesheet('D:\\srv\\demo\\node_modules\\@acme\\admin\\src\\shell.module.scss', '.s{a:b}');
    expect(registeredStylesheets()[0]?.surface).toBe('app');
    expect(stylesFor('site')).toBe('');
  });

  test('a root named `D:\\app` classifies by where a sheet sits below it, not by the root', () => {
    setStylesheetRoot('D:\\app');
    loadStylesheet('d:\\app\\apps\\web\\site\\page.module.scss', '.hero{color:red}');
    loadStylesheet('D:\\app\\apps\\web\\shared\\global.scss', ':root{--c:1}');
    const surfaces = registeredStylesheets().map((sheet) => sheet.surface);
    expect(surfaces.sort()).toEqual(['shared', 'site']);
  });
});

// Coverage for the facts `loadApp` projects out of the framework's own registries rather than out
// of the app's source: the default locale is `@ultimat3/i18n`'s `localeConfig()`, and a module that
// will not import is a finding keyed by its app-root-relative path.

import { afterEach, describe, expect, test } from 'bun:test';
// `node:` and not Bun: Bun has no API for a temporary directory (`mkdtempSync` + `tmpdir`) and none
// for a recursive delete (`rmSync`). `node:path` comes with them — `Bun.write` takes the joined
// path, but only `node:path` can build one.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocaleConfig } from '@ultimat3/i18n';
import { configureLocales, localeConfig } from '@ultimat3/i18n';
import { loadApp } from './app-load';

let root = '';

function tempRoot(prefix: string): string {
  root = mkdtempSync(join(tmpdir(), prefix));
  return root;
}

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('unit · loadApp', () => {
  test("defaultLocale is the framework's own answer, not a constant", async () => {
    const dir = tempRoot('x-app-load-locale-');
    const before: LocaleConfig = { ...localeConfig() };
    try {
      // What `defineCatalogs({ default: 'pt' })` does on its way through the import loop. Called
      // directly because a fixture under /tmp cannot resolve `@ultimat3/*` to run it for real.
      configureLocales({ fallback: 'pt' });
      expect((await loadApp(dir)).defaultLocale).toBe('pt');
    } finally {
      configureLocales(before);
    }
    expect((await loadApp(dir)).defaultLocale).toBe(before.fallback);
  });

  test('a module that will not import is a finding at its app-root-relative path', async () => {
    const dir = tempRoot('x-app-load-broken-');
    await Bun.write(
      join(dir, 'packages/i18n/src/index.ts'),
      "import { defineCatalogs } from '@ultimat3/i18n';\nexport const catalogs = defineCatalogs({});\n",
    );

    const app = await loadApp(dir);

    expect(app.root).toBe(dir);
    expect(app.files).toEqual([]);
    expect(app.findings.map((finding) => finding.at)).toEqual(['packages/i18n/src/index.ts']);
  });
});

// Coverage for the facts `loadApp` projects out of the framework's own registries rather than out
// of the app's source: the default locale is `@ultimat3/i18n`'s `localeConfig()`, and a module that
// will not import is a finding keyed by its app-root-relative path.

import { afterEach, describe, expect, test } from 'bun:test';
// why: `node:` and not Bun: Bun has no API for a temporary directory (`mkdtempSync` + `tmpdir`) and
// none for a recursive delete (`rmSync`). `node:path` comes with them — `Bun.write` takes the
// joined path, but only `node:path` can build one.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
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

/**
 * The two files under an app surface this scan must NOT import, and each for its own reason: a
 * `*.island.tsx` is a client entry point whose module graph assumes a browser, and a
 * `*.island.states.ts` is read by a tool — importing it would put `@ultimat3/testing` in the server
 * graph of every `x dev` and every gate step that loads the app.
 */
describe('unit · what loadApp deliberately does not import', () => {
  test('an island and its states file are skipped; the page beside them is not', async () => {
    const dir = tempRoot('x-app-load-island-');
    const at = join(dir, 'apps/web/app/settings');
    // Each would be a FINDING if it were imported: neither can resolve its specifier from /tmp.
    await Bun.write(
      join(at, 'settings.island.tsx'),
      "import 'solid-js';\nexport function mount() {}\n",
    );
    await Bun.write(
      join(at, 'settings.island.states.ts'),
      "import { defineIslandStates } from '@ultimat3/testing';\nexport const s = defineIslandStates({ island: 'x', states: [] });\n",
    );
    // The control is a `.ts`, not the page: a `.tsx` goes through render's JSX loader, whose
    // prelude imports `@ultimat3/render` — unresolvable from /tmp, so it would be a finding for a
    // reason that has nothing to do with this rule.
    await Bun.write(join(at, 'actions.ts'), 'export const noop = (): void => undefined;\n');

    const loaded = await loadApp(dir);

    expect(loaded.files).toEqual(['apps/web/app/settings/actions.ts']);
    // Neither skipped file can resolve its specifier from /tmp, so importing either WOULD be a
    // finding — an empty list is the proof that neither was imported.
    expect(loaded.findings).toEqual([]);
  });
});

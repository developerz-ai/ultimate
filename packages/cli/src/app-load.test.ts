// Coverage for the facts `loadApp` projects out of the framework's own registries rather than out
// of the app's source: the locales are `@ultimat3/i18n`'s `loadAppCatalogs` answer, and a module
// that will not import is a finding keyed by its app-root-relative path.

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
import { UNDECLARED_LOCALES } from '@ultimat3/i18n/app-catalogs';
import { appModulePaths, loadApp, sortModulePaths } from './app-load';
import { toPosix } from './posix-path';

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
  // `loadAppCatalogs` is the one reader: `localeConfig()` read blind answered whatever an earlier
  // import in the process had configured, for an app root that declares nothing at all.
  test('an app that declares no catalogs is the undeclared answer, never the ambient config', async () => {
    const dir = tempRoot('x-app-load-locale-');
    const before: LocaleConfig = { ...localeConfig() };
    try {
      configureLocales({ supported: ['pt', 'en'], fallback: 'pt' });
      expect((await loadApp(dir)).locales).toBe(UNDECLARED_LOCALES);
    } finally {
      configureLocales(before);
    }
  });

  test('an app that declares catalogs is its own declaration, read once at load', async () => {
    const dir = tempRoot('x-app-load-declared-');
    // By absolute path: a module under the OS temp dir cannot resolve `@ultimat3/i18n`.
    const i18n = JSON.stringify(join(import.meta.dir, '../../i18n/src/index.ts'));
    await Bun.write(
      join(dir, 'packages/i18n/src/index.ts'),
      `import { defineCatalogs } from ${i18n};\nexport const catalogs = defineCatalogs({ default: 'es', locales: { es: {}, en: {} } });\n`,
    );
    const before: LocaleConfig = { ...localeConfig() };
    try {
      const app = await loadApp(dir);
      expect(app.findings).toEqual([]);
      expect(app.locales).toEqual({ locales: ['es', 'en'], defaultLocale: 'es' });
    } finally {
      configureLocales(before);
    }
  });

  // Reproduced: an app under `~/dev/node_modules-experiments/myapp` loaded ZERO modules, because
  // `absolute.includes('node_modules')` is true for every file in it. A silent empty registry — a
  // zero-entity manifest, no routes, no actions, and a green gate over all of it.
  test('a root path CONTAINING node_modules still loads the app', async () => {
    const dir = tempRoot('x-app-load-node_modules-experiments-');
    await Bun.write(
      join(dir, 'packages/i18n/src/index.ts'),
      "import { defineCatalogs } from '@ultimat3/i18n';\nexport const catalogs = defineCatalogs({});\n",
    );

    const app = await loadApp(dir);

    // It is a FINDING (the specifier cannot resolve from /tmp) rather than silence, which is the
    // whole point: the file was seen. Skipped, it produced neither a finding nor a registration.
    expect(app.findings.map((finding) => finding.at)).toEqual(['packages/i18n/src/index.ts']);
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

  // Row a: an app whose absolute path contains `.test.` loaded ZERO modules — every file matched
  // `absolute.includes('.test.')` — so manifest, db gen, policy and i18n all checked nothing.
  test('a root path CONTAINING .test. still loads the app', async () => {
    const dir = tempRoot('x-app-load-my.test.app-');
    await Bun.write(join(dir, 'app.config.ts'), 'export default {};\n');
    await Bun.write(join(dir, 'apps/web/shared/format.ts'), 'export const x = 1;\n');
    await Bun.write(join(dir, 'apps/web/shared/format.test.ts'), 'export const y = 2;\n');

    const app = await loadApp(dir);

    expect(app.files).toEqual(['apps/web/shared/format.ts']);
    expect(app.findings).toEqual([]);
  });

  // In a child process: the rule reads the process's registries, and in a shared test process
  // another file has always registered something — the case passed in the parallel gate and failed
  // run alone (`bun test packages/cli`, CI's `packages` job), or the other way round.
  test('an app with an app.config.ts that loads nothing is X_APP_EMPTY, never an empty green', async () => {
    const dir = tempRoot('x-app-load-empty-');
    await Bun.write(join(dir, 'app.config.ts'), 'export default {};\n');
    const probe = `const { loadApp } = await import(${JSON.stringify(`${import.meta.dir}/app-load.ts`)});
const app = await loadApp(${JSON.stringify(dir)});
console.log(JSON.stringify(app.findings.map((finding) => finding.code)));`;
    const child = Bun.spawn(['bun', '-e', probe], {
      cwd: import.meta.dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(out.trim().split('\n').at(-1) ?? '[]')).toEqual(['X_APP_EMPTY']);
  });
});

/**
 * `Bun.Glob` answers in directory order, which ext4 derives from a per-filesystem hash seed: two
 * pods of one image imported the app in two orders, registered its stylesheets in two orders, and
 * served two different `/styles/<hash>.css` for one page (notificado.co, 22.3.2).
 */
describe('unit · the app is imported in one order on every machine', () => {
  test('module paths are sorted within each glob, whatever order the files were created in', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ultimate-app-order-'));
    try {
      const names = ['zeta', 'alpha', 'mu', 'beta', 'omega', 'delta', 'kappa', 'eta'];
      for (const name of names) {
        await Bun.write(join(root, `apps/web/app/${name}/page.tsx`), 'export {};\n');
        await Bun.write(join(root, `packages/${name}/src/index.ts`), 'export {};\n');
      }
      // POSIX before the prefix tests: on Windows the glob answers `apps\web\…`.
      const paths = (await appModulePaths(root)).map((path) =>
        toPosix(path.slice(root.length + 1)),
      );
      const app = paths.filter((path) => path.startsWith('apps/'));
      const packages = paths.filter((path) => path.startsWith('packages/'));
      expect(app).toEqual([...app].sort());
      expect(packages).toEqual([...packages].sort());
      // The glob order itself is kept: every app module before any package module.
      expect(paths).toEqual([...app, ...packages]);
      expect(app).toHaveLength(names.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the order is the POSIX spelling, so a Windows glob sorts like a Linux one', () => {
    // `\` sorts after `1`, `/` before it: sorted raw, Windows put `a1/` ahead of `a/`.
    const windows = ['D:\\w\\apps\\web\\app\\a1\\page.tsx', 'D:\\w\\apps\\web\\app\\a\\page.tsx'];
    const linux = windows.map(toPosix);
    expect(sortModulePaths(windows).map(toPosix)).toEqual(sortModulePaths(linux));
    expect(sortModulePaths(linux)).toEqual([
      'D:/w/apps/web/app/a/page.tsx',
      'D:/w/apps/web/app/a1/page.tsx',
    ]);
  });
});

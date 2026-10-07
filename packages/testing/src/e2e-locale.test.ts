// The locale an e2e browser pins: the app's catalog default, or nothing — never a guess.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
// why: a scratch app root; Bun ships no temp-dir or recursive-delete primitive.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path'; // why: Bun ships no path join.
import { resetCatalogs, resetLocaleConfig } from '@ultimat3/i18n';
import { APP_CATALOGS_PATH } from '@ultimat3/i18n/app-catalogs';
import { e2eDefaultLocale } from './e2e-locale';

// Inside this package, never the OS temp dir: the fixture module imports `@ultimat3/i18n`, which
// only resolves from a directory under the workspace.
const scratch = mkdtempSync(join(import.meta.dir, '.e2e-locale-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => {
  resetCatalogs();
  resetLocaleConfig();
});

const catalogsModule = (fallback: string): string =>
  [
    "import { defineCatalogs } from '@ultimat3/i18n';",
    `export const catalogs = defineCatalogs({ default: '${fallback}', locales: { en: {}, '${fallback}': {} } });`,
    '',
  ].join('\n');

describe('e2eDefaultLocale', () => {
  test("answers the default the app's defineCatalogs() declared", async () => {
    const root = join(scratch, 'declared');
    await Bun.write(join(root, APP_CATALOGS_PATH), catalogsModule('es-co'));
    expect(await e2eDefaultLocale(root)).toBe('es-co');
  });

  test('never reads app.config.ts — its defaultLocale key was deleted in 25.0.0', async () => {
    // The 24.x reader looked here, so after the deletion it answered `undefined` for EVERY app and
    // the browser silently pinned no locale at all.
    const root = join(scratch, 'config-only');
    await Bun.write(
      join(root, 'app.config.ts'),
      "export const config = { name: 'fixture', defaultLocale: 'es-co' };\n",
    );
    expect(await e2eDefaultLocale(root)).toBeUndefined();
  });

  test('answers nothing — not a guessed en — when there is no catalog module or it will not load', async () => {
    expect(await e2eDefaultLocale(join(scratch, 'absent'))).toBeUndefined();
    const broken = join(scratch, 'broken');
    await Bun.write(join(broken, APP_CATALOGS_PATH), "throw new TypeError('env missing');\n");
    expect(await e2eDefaultLocale(broken)).toBeUndefined();
    const silent = join(scratch, 'silent');
    await Bun.write(join(silent, APP_CATALOGS_PATH), 'export const nothing = 1;\n');
    expect(await e2eDefaultLocale(silent)).toBeUndefined();
  });
});

// `x shot --locale` and `--matrix` through an injected browser: the flag reading, the plan (every
// route × locale × theme × width, prefixed paths), that every capture pins `Accept-Language` and
// its viewport before it navigates, and the contact sheet. No Chrome: `fakeShotDriver()`.

import { afterAll, describe, expect, test } from 'bun:test';
// why: a scratch app root; Bun ships no temp-dir or recursive-delete primitive.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os'; // why: Bun exposes no tmpdir().
import { join } from 'node:path'; // why: Bun ships no path join.
import { fakeShotDriver } from './browser-launcher-fake';
import type { ShotDriver, ShotSessionInit } from './browser-launcher-port';
import { runShot, type ShotServer } from './cmd-shot';
import {
  contactSheet,
  isMatrixRoute,
  MATRIX_INDEX,
  planShotMatrix,
  runShotMatrix,
} from './cmd-shot-matrix';
import {
  FALLBACK_SHOT_LOCALES,
  loadShotLocales,
  localizedShotPath,
  readLocaleFlag,
} from './shot-locale';
import { ISLAND_PROBE } from './shot-verdict';

const SERVER_URL = 'http://localhost:4321';
const APP = { locales: ['es-co', 'en'], defaultLocale: 'es-co' } as const;
const scratch = mkdtempSync(join(tmpdir(), 'x-shot-matrix-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const CLEAN = JSON.stringify({
  declared: 0,
  booted: 0,
  mounted: 0,
  failed: 0,
  byStrategy: {},
  failures: [],
});

/** The fake, with every session's init recorded — the seam that shows what was pinned. */
const recording = (paths: readonly string[]): { driver: ShotDriver; opened: ShotSessionInit[] } => {
  const base = fakeShotDriver(
    paths.map((path) => ({
      url: `${SERVER_URL}${path}`,
      html: '<!doctype html><html><body>page</body></html>',
      evaluate: { [ISLAND_PROBE]: CLEAN },
    })),
  );
  const opened: ShotSessionInit[] = [];
  return {
    opened,
    driver: {
      name: base.name,
      open: (init) => {
        opened.push(init);
        return base.open(init);
      },
    },
  };
};

const server = (): {
  boot: () => Promise<ShotServer>;
  boots: () => number;
  stops: () => number;
} => {
  let boots = 0;
  let stops = 0;
  return {
    boot: () => {
      boots += 1;
      return Promise.resolve({
        url: SERVER_URL,
        origin: 'booted',
        stop: () => {
          stops += 1;
          return Promise.resolve();
        },
      });
    },
    boots: () => boots,
    stops: () => stops,
  };
};

describe('--locale', () => {
  test('an undeclared locale is refused by name before anything boots', () => {
    expect(() => readLocaleFlag('fr', APP)).toThrow(
      expect.objectContaining({ code: 'X_CLI_BAD_FLAG' }),
    );
    expect(readLocaleFlag('en', APP)).toBe('en');
    expect(readLocaleFlag(undefined, APP)).toBeUndefined();
  });

  test('prefixes a non-default locale and leaves the default unprefixed', () => {
    expect(localizedShotPath('/precios', 'en', 'es-co')).toBe('/en/precios');
    expect(localizedShotPath('/', 'en', 'es-co')).toBe('/en/');
    expect(localizedShotPath('/precios', 'es-co', 'es-co')).toBe('/precios');
  });

  test("reads the app's locales off app.config.ts, and falls back to en with none", async () => {
    const root = join(scratch, 'app');
    rmSync(root, { recursive: true, force: true });
    await Bun.write(
      join(root, 'app.config.ts'),
      "export const config = { locales: ['es-co', 'en'], defaultLocale: 'es-co' };\n",
    );
    expect(await loadShotLocales(root)).toEqual({
      locales: ['es-co', 'en'],
      defaultLocale: 'es-co',
    });
    expect(await loadShotLocales(join(scratch, 'nothing-here'))).toEqual(FALLBACK_SHOT_LOCALES);
  });

  test('a single shot pins Accept-Language before it navigates', async () => {
    const { driver, opened } = recording(['/en/precios']);
    const artifacts = await runShot({
      route: '/en/precios',
      outDir: join(scratch, 'single'),
      driver,
      boot: server().boot,
      settleMs: 0,
      timeoutMs: 1_000,
      fullPage: true,
      acceptLanguage: 'en',
    });
    expect(artifacts.verdict.ok).toBe(true);
    expect(opened[0]?.headers).toEqual({ 'accept-language': 'en' });
  });
});

describe('--matrix', () => {
  test('plans every static route × locale × theme × width, dynamic routes left out', () => {
    expect(isMatrixRoute('/blog/:slug')).toBe(false);
    const cells = planShotMatrix({ routes: ['/', '/precios', '/blog/:slug'], ...APP });
    expect(cells).toHaveLength(2 * 2 * 2 * 2);
    expect(new Set(cells.map((cell) => cell.path))).toEqual(
      new Set(['/', '/precios', '/en/', '/en/precios']),
    );
    expect(cells.map((cell) => cell.viewport.width)).toContain(390);
    expect(cells.map((cell) => cell.viewport.width)).toContain(1440);
    expect(cells[0]?.dir).toBe(join('root', 'es-co', 'light-390'));
    // Every cell its own directory: two pictures can never overwrite each other.
    expect(new Set(cells.map((cell) => cell.dir)).size).toBe(cells.length);
  });

  test('narrowing an axis keeps only that value', () => {
    const cells = planShotMatrix({ routes: ['/'], ...APP, themes: ['dark'] });
    expect(cells.every((cell) => cell.theme === 'dark')).toBe(true);
    expect(cells).toHaveLength(2 * 2);
  });

  test('one server for the whole run, each cell pinned, and an index of every picture', async () => {
    const cells = planShotMatrix({ routes: ['/', '/precios'], ...APP });
    const { driver, opened } = recording(['/', '/precios', '/en/', '/en/precios']);
    const srv = server();
    const outDir = join(scratch, 'matrix');
    const result = await runShotMatrix({
      cells,
      outDir,
      boot: srv.boot,
      shoot: runShot,
      base: { driver, settleMs: 0, timeoutMs: 1_000, fullPage: true },
    });
    expect(result.ok).toBe(true);
    expect(srv.boots()).toBe(1);
    expect(srv.stops()).toBe(1);
    expect(opened).toHaveLength(cells.length);
    expect(opened.map((init) => init.headers?.['accept-language'])).toEqual(
      cells.map((cell) => cell.locale),
    );
    expect(opened.map((init) => init.viewport?.width)).toEqual(
      cells.map((cell) => cell.viewport.width),
    );
    const index = await Bun.file(join(outDir, MATRIX_INDEX)).text();
    for (const cell of cells) expect(index).toContain(`${cell.dir}/shot.png`);
    expect(await Bun.file(join(outDir, cells[0]?.dir ?? '', 'shot.png')).exists()).toBe(true);
  });

  test('the contact sheet marks a failed cell and escapes what it prints', () => {
    const [cell] = planShotMatrix({ routes: ['/<x>'], ...APP });
    if (cell === undefined) return expect.unreachable('the plan produced no cell');
    const html = contactSheet([{ cell, ok: false, image: 'a/shot.png' }]);
    expect(html).toContain('FAILED');
    expect(html).toContain('&lt;x&gt;');
    expect(html).not.toContain('<x>');
    expect(html).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});

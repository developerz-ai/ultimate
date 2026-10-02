import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no native for creating or removing a directory tree, and the only file that can
// prove the prelude resolves is one OUTSIDE this repository — which needs a real temp directory.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os'; // why: same — no Bun native answers the platform temp root.
import { join } from 'node:path'; // why: same — Bun.write and import() both take a joined path.
import { h } from './jsx';
import {
  claimStylesheets,
  clearStylesheets,
  installRenderLoader,
  JSX_FACTORY_SPECIFIER,
  loadStylesheet,
  registeredStylesheets,
  setStylesheetRoot,
  stylesFor,
  stylesheetsRevision,
  transformTsx,
} from './module-loader';

const SITE = '/srv/demo/apps/web/site/page.module.scss';
const APP = '/srv/demo/apps/web/app/dashboard/page.module.scss';
const PACKAGE = '/srv/demo/packages/ui/src/card.module.scss';
/** The app's global layer: tokens + reset, the one file both surfaces' documents must carry. */
const GLOBAL = '/srv/demo/apps/web/shared/global.scss';
const GLOBAL_CSS = ':root{--color-fg:38 34 31}*{margin:0}';

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

afterEach(() => {
  clearStylesheets();
  setStylesheetRoot(undefined);
});

describe('installRenderLoader', () => {
  test('is idempotent, so importing the package twice installs one plugin', () => {
    expect(() => {
      installRenderLoader();
      installRenderLoader();
    }).not.toThrow();
  });
});

describe('the JSX prelude resolves from the loader, not from the compiled file', () => {
  /**
   * The load-bearing case, and it only fails outside the repository: a bare `@ultimat3/render` in
   * the prelude was resolved from the IMPORTING file, so every `.tsx` compiled anywhere the package
   * is not installed above it died at link time with `Cannot find module '@ultimat3/render'`. A
   * fixture under `packages/` cannot see this — the repo's own `node_modules` answers for it.
   */
  test('a .tsx OUTSIDE the repository compiles AND evaluates', async () => {
    installRenderLoader();
    const root = mkdtempSync(join(tmpdir(), 'ultimate-prelude-'));
    try {
      await Bun.write(
        join(root, 'outside.tsx'),
        // `__xh` is the prelude's own binding, in module scope by the time this line runs — which
        // is what lets the file hand the factory back for an identity check the shape cannot make.
        'export const A = () => <p class="x">hi</p>;\nexport const factory = __xh;\n',
      );
      const mod = (await import(join(root, 'outside.tsx'))) as {
        A: () => unknown;
        factory: unknown;
      };
      // Reference identity, never `toEqual` on the node: a specifier resolving to a SECOND copy of
      // this package answers a structurally identical node, and every brand check that reads it
      // back — `isJsxNode`, `isIslandNode` — would then reject what an out-of-tree module built.
      expect(mod.factory).toBe(h);
      expect(mod.A()).toEqual(h('p', { class: 'x' }, 'hi'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * `x dev` re-imports an edited route module as `<path>?x-reload=<hash>` — the one cache key Bun
   * honours — and Bun hands the plugin that path QUERY INCLUDED. An anchored `/\.tsx$/` did not
   * match it, so the reload fell through to Bun's own loader, which compiles JSX to
   * `React.createElement`: a `ReferenceError` on the first render of every reloaded page.
   */
  test("a query-suffixed .tsx import compiles through this loader, not through Bun's", async () => {
    installRenderLoader();
    const root = mkdtempSync(join(tmpdir(), 'ultimate-reload-'));
    try {
      const path = join(root, 'page.tsx');
      await Bun.write(path, 'export const A = () => <p>one</p>;\nexport const factory = __xh;\n');
      const first = (await import(path)) as { A: () => unknown };
      await Bun.write(path, 'export const A = () => <p>two</p>;\nexport const factory = __xh;\n');
      const second = (await import(`${path}?x-reload=2`)) as { A: () => unknown; factory: unknown };
      expect(first.A()).toEqual(h('p', null, 'one'));
      expect(second.factory).toBe(h);
      expect(second.A()).toEqual(h('p', null, 'two'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the emitted specifier names the same module the package name does', async () => {
    expect(transformTsx('export const A = () => <p />;')).toContain(JSX_FACTORY_SPECIFIER);
    const viaSpecifier = (await import(JSX_FACTORY_SPECIFIER)) as { h: unknown };
    const viaPackageName = (await import('@ultimat3/render')) as { h: unknown };
    expect(viaSpecifier.h).toBe(viaPackageName.h);
  });
});

describe('transformTsx', () => {
  test('compiles JSX to the server factory, not to React.createElement', () => {
    const out = transformTsx('export const A = () => <main class="x">hi</main>;');
    expect(out).toContain('__xh("main"');
    expect(out).not.toContain('React.createElement');
  });

  test('imports the factory it emits, so the module has no free variable', () => {
    expect(transformTsx('export const A = () => <p />;')).toContain(
      `import { h as __xh, Fragment as __xFragment } from ${JSON.stringify(JSX_FACTORY_SPECIFIER)};`,
    );
  });

  test('a fragment compiles to the fragment factory', () => {
    expect(transformTsx('export const A = () => <><i/><b/></>;')).toContain('__xFragment');
  });

  test('the prelude shares line 1, so a reported line number still points at the author', () => {
    const out = transformTsx('const a = 1;\nconst b = 2;\n');
    expect(out.split('\n')[0]).toContain('const a = 1;');
  });

  test('types are stripped — the loader replaces the whole TS pipeline for these files', () => {
    const out = transformTsx('import type { X } from "./x";\nexport const A = (): X => <p />;');
    expect(out).not.toContain('import type');
  });
});

describe('loadStylesheet', () => {
  test('a module stylesheet becomes a default-exported class map', () => {
    const body = loadStylesheet(SITE, '.hero{color:red}');
    expect(body).toMatch(/^export default \{"hero":"hero_[0-9a-f]{8}"\};$/);
  });

  test('the CSS is registered under the surface that owns the file', () => {
    loadStylesheet(SITE, '.hero{color:red}');
    expect(registeredStylesheets()).toHaveLength(1);
    expect(registeredStylesheets()[0]?.surface).toBe('site');
  });

  test('a stylesheet that compiles to nothing registers nothing', () => {
    loadStylesheet(SITE, '// only a comment\n');
    expect(registeredStylesheets()).toHaveLength(0);
  });

  // `x dev`: a stylesheet emptied by an edit kept serving the rules it had before, because an
  // empty compile skipped the registration and left the old entry in place.
  test('a stylesheet emptied by an edit stops serving its old rules', () => {
    loadStylesheet(SITE, '.hero{color:red}');
    const before = stylesheetsRevision();
    loadStylesheet(SITE, '// all rules deleted\n');
    expect(registeredStylesheets()).toHaveLength(0);
    expect(stylesFor('site')).not.toContain('color:red');
    expect(stylesheetsRevision()).toBeGreaterThan(before);
  });
});

describe('stylesFor', () => {
  test('a site page never receives app CSS — axiom 6, in bytes the browser parses', () => {
    loadStylesheet(SITE, '.hero{color:red}');
    loadStylesheet(APP, '.panel{color:blue}');
    expect(stylesFor('site')).toContain('color:red');
    expect(stylesFor('site')).not.toContain('color:blue');
    expect(stylesFor('app')).toContain('color:blue');
    expect(stylesFor('app')).not.toContain('color:red');
  });

  test('a package stylesheet has no surface, so both graphs carry it', () => {
    loadStylesheet(PACKAGE, '.card{color:green}');
    expect(stylesFor('site')).toContain('color:green');
    expect(stylesFor('app')).toContain('color:green');
  });

  test('no stylesheets means no style tag to emit', () => {
    expect(stylesFor('site')).toBe('');
  });

  // Axiom 6, for a PACKAGE's sheet. `@ultimat3/admin`'s screens are served on `app/`, and its
  // stylesheet rode every surface: an app's static `site/` documents carried 4.8 kB for an admin
  // they never render.
  describe('a package that claims its directory for one surface', () => {
    const ADMIN_DIR = '/srv/demo/node_modules/@ultimat3/admin/src';
    const ADMIN_SHEET = `${ADMIN_DIR}/admin.module.scss`;

    test('its sheets are carried by that surface alone — a site document pays nothing', () => {
      claimStylesheets(ADMIN_DIR, 'app');
      loadStylesheet(ADMIN_SHEET, '.shell{color:purple}');
      loadStylesheet(PACKAGE, '.card{color:green}');
      expect(stylesFor('site')).not.toContain('color:purple');
      expect(stylesFor('app')).toContain('color:purple');
      // A package nobody claimed is still what both graphs carry.
      expect(stylesFor('site')).toContain('color:green');
    });

    test('a claim made AFTER the sheet registered moves it, and moves the revision with it', () => {
      const LATE_DIR = '/srv/demo/node_modules/@acme/back-office/src';
      loadStylesheet(`${LATE_DIR}/board.module.scss`, '.board{color:teal}');
      expect(stylesFor('site')).toContain('color:teal');
      const before = stylesheetsRevision();
      claimStylesheets(LATE_DIR, 'app');
      expect(stylesFor('site')).not.toContain('color:teal');
      expect(stylesFor('app')).toContain('color:teal');
      expect(stylesheetsRevision()).toBeGreaterThan(before);
      // Claiming the same directory again changes no answer, so it mints no new stylesheet URL.
      const settled = stylesheetsRevision();
      claimStylesheets(LATE_DIR, 'app');
      expect(stylesheetsRevision()).toBe(settled);
    });

    test('a claim covers its own directory and nothing beside it', () => {
      claimStylesheets(ADMIN_DIR, 'app');
      loadStylesheet(`${ADMIN_DIR}-themes/dark.module.scss`, '.dark{color:navy}');
      expect(stylesFor('site')).toContain('color:navy');
    });

    test('a claimed sheet is still LIBRARY in the cascade: before shared/ and the surface’s own', () => {
      claimStylesheets(ADMIN_DIR, 'app');
      loadStylesheet(APP, '.panel{color:blue}');
      loadStylesheet(ADMIN_SHEET, '.shell{color:purple}');
      const css = stylesFor('app');
      // Present before ordered: a sheet that stopped being carried answers -1, which sorts first.
      expect(css).toContain('color:purple');
      expect(css).toContain('color:blue');
      expect(css.indexOf('color:purple')).toBeLessThan(css.indexOf('color:blue'));
    });

    test('the root being renamed does not undo a claim', () => {
      claimStylesheets(ADMIN_DIR, 'app');
      loadStylesheet(ADMIN_SHEET, '.shell{color:purple}');
      setStylesheetRoot('/srv/demo');
      expect(stylesFor('site')).not.toContain('color:purple');
      setStylesheetRoot(undefined);
    });
  });

  // The bundle is one file made of many compiles, and an encoding claim is legal at byte 0 of a
  // file and nowhere else. Two modules with a non-ASCII `content:` are the smallest case: the
  // second one's BOM sat glued to its first selector, and the browser dropped that whole rule.
  test('two modules with a non-ASCII character join with no BOM between them', () => {
    loadStylesheet(APP, ".dashboard{display:grid}.sep{content:'·'}");
    loadStylesheet(
      '/srv/demo/apps/web/app/fleet/page.module.scss',
      ".fleet{display:grid}.dot{content:'·'}",
    );
    const css = stylesFor('app');
    expect(css).not.toContain('\uFEFF');
    expect(css).not.toContain('@charset');
    expect(occurrences(css, 'display:grid')).toBe(2);
    // Each module's first rule opens on its selector, exactly as the first module's does.
    expect(css).toMatch(/^\.dashboard_[0-9a-f]{8}\{display:grid\}/);
    expect(css).toMatch(/\}\.fleet_[0-9a-f]{8}\{display:grid\}/);
  });

  test("a shared/ stylesheet reaches both surfaces — it is the app's own global layer", () => {
    loadStylesheet(GLOBAL, GLOBAL_CSS);
    expect(stylesFor('site')).toContain('--color-fg:');
    expect(stylesFor('app')).toContain('--color-fg:');
  });

  test('the global layer leads, whichever module happened to load first', () => {
    loadStylesheet(SITE, '.hero{color:red}');
    loadStylesheet(GLOBAL, GLOBAL_CSS);
    const css = stylesFor('site');
    // Present before ordered: a global layer that stopped being emitted makes `indexOf` answer
    // -1, which is less than every real index, so the comparison below would read as satisfied
    // for a document carrying no tokens at all.
    expect(css).toContain('--color-fg:');
    expect(css).toContain(GLOBAL_CSS);
    expect(css.indexOf('--color-fg:')).toBeLessThan(css.indexOf('.hero'));
    expect(css.startsWith(':root')).toBe(true);
  });

  test('the global layer is emitted exactly once, however many modules pull it in', () => {
    loadStylesheet(GLOBAL, GLOBAL_CSS);
    loadStylesheet(SITE, '.hero{color:red}');
    loadStylesheet(APP, '.panel{color:blue}');
    // Every app module importing the same file is the same registry key, so the `:root` block
    // cannot be duplicated — the failure mode a token file `@use`d per module would have.
    loadStylesheet(GLOBAL, GLOBAL_CSS);
    expect(occurrences(stylesFor('site'), '--color-fg:')).toBe(1);
    expect(occurrences(stylesFor('app'), '--color-fg:')).toBe(1);
  });

  test('a module stylesheet is not the global layer, so it never jumps the reset', () => {
    loadStylesheet(GLOBAL, GLOBAL_CSS);
    loadStylesheet(PACKAGE, '.card{color:green}');
    expect(stylesFor('app').startsWith(GLOBAL_CSS)).toBe(true);
  });
});

// The container runs the app from `WORKDIR /app`, so every absolute path a Bun plugin hands the
// loader starts with an `app/` segment. Classified from the absolute path, the site page, the
// global layer and the UI kit all landed on `app`, and every site document went out unstyled.
describe('an app served from /app', () => {
  const ROOT = '/app';
  const SITE_SHEET = '/app/apps/web/site/page.module.scss';
  const APP_SHEET = '/app/apps/web/app/feed/page.module.scss';
  const GLOBAL_SHEET = '/app/apps/web/shared/global.scss';
  const KIT_SHEET = '/app/node_modules/@ultimat3/ui/src/stack.module.scss';

  test('each sheet is classified by where it sits in the app, not by the root it sits under', () => {
    setStylesheetRoot(ROOT);
    loadStylesheet(SITE_SHEET, '.hero{color:red}');
    loadStylesheet(APP_SHEET, '.feed{color:blue}');
    loadStylesheet(GLOBAL_SHEET, GLOBAL_CSS);
    loadStylesheet(KIT_SHEET, '.stack{display:flex}');

    const surfaces = Object.fromEntries(registeredStylesheets().map((s) => [s.file, s.surface]));
    expect(surfaces).toEqual({
      [SITE_SHEET]: 'site',
      [APP_SHEET]: 'app',
      [GLOBAL_SHEET]: 'shared',
      [KIT_SHEET]: null,
    });
    const site = stylesFor('site');
    expect(site).toContain('color:red');
    expect(site).toContain('--color-fg:');
    expect(site).toContain('display:flex');
    expect(site).not.toContain('color:blue');
  });

  // `loadApp('.')` from `/app` names a RELATIVE root, and every path the plugin hands the loader is
  // absolute: compared as written, the root matched nothing and the `/app/` segment won again.
  test('a relative root is resolved against the working directory before it is compared', () => {
    setStylesheetRoot('app');
    const sheet = join(process.cwd(), 'app', 'apps/web/site/page.module.scss');
    loadStylesheet(sheet, '.hero{color:red}');
    expect(registeredStylesheets()[0]?.surface).toBe('site');
  });

  // The order `x build` meets: a sheet can register before `loadApp` names the root, and a
  // classification frozen at registration would keep the answer the wrong root gave.
  test('naming the root reclassifies what registered before it, and moves the revision', () => {
    setStylesheetRoot('/');
    loadStylesheet(SITE_SHEET, '.hero{color:red}');
    expect(stylesFor('site')).toBe('');

    const before = stylesheetsRevision();
    setStylesheetRoot(ROOT);
    expect(stylesFor('site')).toContain('color:red');
    expect(stylesheetsRevision()).toBeGreaterThan(before);

    // Naming the same root again changes no answer, so it mints no new stylesheet URL.
    const settled = stylesheetsRevision();
    setStylesheetRoot(ROOT);
    expect(stylesheetsRevision()).toBe(settled);
  });
});

/**
 * Two pods of one image served two different `/styles/<hash>.css` for one page (notificado.co,
 * 22.3.2), because the surface stylesheet joined sheets in ARRIVAL order and an island build's
 * arrival order is the bundler's race. Island-only sheets are ordered by path.
 */
describe('the surface stylesheet does not depend on the order an island build loaded its sheets', () => {
  const A = '/srv/demo/apps/web/app/a/a.module.scss';
  const B = '/srv/demo/apps/web/app/b/b.module.scss';
  const C = '/srv/demo/apps/web/app/c/c.module.scss';
  const marker = (path: string): string => `mark-${path.split('/').at(-2)}`;
  const build = (order: readonly string[]): string => {
    clearStylesheets();
    setStylesheetRoot('/srv/demo');
    loadStylesheet(GLOBAL, GLOBAL_CSS);
    loadStylesheet(APP, '.page{color:red}');
    for (const path of order) loadStylesheet(path, `.${marker(path)}{color:blue}`, 'island');
    return stylesFor('app');
  };

  test('every arrival order joins to the same bytes', () => {
    const first = build([A, B, C]);
    expect(build([C, A, B])).toBe(first);
    expect(build([B, C, A])).toBe(first);
  });

  test('an island sheet is ordered by path among the surface sheets, not after them', () => {
    const css = build([B, A]);
    expect(css).toContain('page');
    expect(css).toContain('mark-a');
    expect(css).toContain('mark-b');
    // apps/web/app/a < apps/web/app/b < apps/web/app/dashboard
    expect(css.indexOf('mark-a')).toBeLessThan(css.indexOf('mark-b'));
    expect(css.indexOf('mark-b')).toBeLessThan(css.indexOf('page'));
  });

  test('a sheet the server graph loads after an island did is no longer island-only', () => {
    clearStylesheets();
    setStylesheetRoot('/srv/demo');
    loadStylesheet(B, '.b{color:blue}', 'island');
    loadStylesheet(APP, '.page{color:red}');
    loadStylesheet(B, '.b{color:blue}');
    expect(registeredStylesheets().map((sheet) => [sheet.file, sheet.island])).toEqual([
      [APP, false],
      [B, false],
    ]);
  });
});

/**
 * 22.3.4 still minted a different `/styles/<hash>.css` per boot of ONE image (notificado.co). The
 * server's own `.scss` imports register in Bun's `onLoad`, which runs as the loader FETCHES a
 * module's dependencies — in parallel — not as it evaluates them: measured on a real build of the
 * app, three boots registered `@ultimat3/ui`'s Accordion, Alert, AppShell, AsyncRegion, Avatar and
 * BarChart sheets in three orders and minted three URLs. Arrival order is not an order.
 */
describe('the surface stylesheet is the same for any registration order', () => {
  const UI = (name: string): string =>
    `/srv/demo/node_modules/@ultimat3/ui/src/${name}.module.scss`;
  const TOKENS = '/srv/demo/node_modules/@ultimat3/ui/src/tokens.scss';
  const sheets: readonly (readonly [string, string])[] = [
    [UI('Alert'), '.alert{color:red}'],
    [UI('Button'), '.button{color:blue}'],
    [UI('Avatar'), '.avatar{color:green}'],
    [GLOBAL, GLOBAL_CSS],
    [TOKENS, ':root{--ui:1}'],
    [APP, '.page{color:teal}'],
    ['/srv/demo/apps/web/shared/shell.module.scss', '.shell{color:navy}'],
  ];
  const joined = (order: readonly number[]): string => {
    clearStylesheets();
    setStylesheetRoot('/srv/demo');
    for (const i of order) {
      const [path, css] = sheets[i] ?? ['', ''];
      loadStylesheet(path, css);
    }
    return stylesFor('app');
  };

  test('every permutation joins to the same bytes', () => {
    const first = joined([0, 1, 2, 3, 4, 5, 6]);
    expect(joined([6, 5, 4, 3, 2, 1, 0])).toBe(first);
    expect(joined([2, 0, 5, 1, 6, 4, 3])).toBe(first);
  });

  test('library before app: package sheets, then shared/, then the surface — globals first', () => {
    const css = joined([6, 5, 4, 3, 2, 1, 0]);
    const at = (needle: string): number => {
      expect(css).toContain(needle);
      return css.indexOf(needle);
    };
    expect(at('--ui:1')).toBeLessThan(at('--color-fg'));
    expect(at('--color-fg')).toBeLessThan(at('.alert'));
    expect(at('.button')).toBeLessThan(at('.shell'));
    expect(at('.shell')).toBeLessThan(at('.page'));
  });
});

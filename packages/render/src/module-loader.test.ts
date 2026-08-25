import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no native for creating or removing a directory tree, and the only file that can
// prove the prelude resolves is one OUTSIDE this repository — which needs a real temp directory.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os'; // why: same — no Bun native answers the platform temp root.
import { join } from 'node:path'; // why: same — Bun.write and import() both take a joined path.
import { h } from './jsx';
import {
  clearStylesheets,
  installRenderLoader,
  JSX_FACTORY_SPECIFIER,
  loadStylesheet,
  registeredStylesheets,
  stylesFor,
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

  test("a shared/ stylesheet reaches both surfaces — it is the app's own global layer", () => {
    loadStylesheet(GLOBAL, GLOBAL_CSS);
    expect(stylesFor('site')).toContain('--color-fg:');
    expect(stylesFor('app')).toContain('--color-fg:');
  });

  test('the global layer leads, whichever module happened to load first', () => {
    loadStylesheet(SITE, '.hero{color:red}');
    loadStylesheet(GLOBAL, GLOBAL_CSS);
    const css = stylesFor('site');
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

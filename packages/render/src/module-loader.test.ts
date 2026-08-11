import { afterEach, describe, expect, test } from 'bun:test';
import {
  clearStylesheets,
  installRenderLoader,
  loadStylesheet,
  registeredStylesheets,
  stylesFor,
  transformTsx,
} from './module-loader';

const SITE = '/srv/demo/apps/web/site/page.module.scss';
const APP = '/srv/demo/apps/web/app/dashboard/page.module.scss';
const PACKAGE = '/srv/demo/packages/ui/src/card.module.scss';

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

describe('transformTsx', () => {
  test('compiles JSX to the server factory, not to React.createElement', () => {
    const out = transformTsx('export const A = () => <main class="x">hi</main>;');
    expect(out).toContain('__xh("main"');
    expect(out).not.toContain('React.createElement');
  });

  test('imports the factory it emits, so the module has no free variable', () => {
    expect(transformTsx('export const A = () => <p />;')).toContain(
      "import { h as __xh, Fragment as __xFragment } from '@ultimat3/render';",
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
});

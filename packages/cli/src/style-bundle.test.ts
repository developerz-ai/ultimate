// The surface stylesheet table, against the real registry: the property under test is that one
// surface's CSS gets one immutable URL, that the URL moves when — and only when — the CSS moves,
// and that a `site/` sheet never reaches an `app/` document.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: `node:` by necessity — Bun ships no path API, and `rm(…, { force: true })` removes a
// fixture root that may not exist without a branch.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins a directory to a file.
import { join } from 'node:path';
import { clearStylesheets, loadStylesheet } from '@ultimat3/render/server';
import { STYLE_BASE_PATH, styleBundle, styleBundleOf, writeStyles } from './style-bundle';

const SITE = '/srv/demo/apps/web/site/page.module.scss';
const APP = '/srv/demo/apps/web/app/feed/page.module.scss';
const PACKAGE = '/srv/demo/packages/kit/src/kit.scss';
const OUT = join(import.meta.dir, '..', '.style-fixture');

// Both ends: the registry is process-global and every suite in this package that builds an island
// registers into it, so a test that only cleaned up after itself would read another file's CSS.
beforeEach(() => {
  clearStylesheets();
});

afterEach(async () => {
  clearStylesheets();
  await rm(OUT, { recursive: true, force: true });
});

describe('styleBundle', () => {
  test('one content-addressed URL per surface, and a site page never links app CSS', () => {
    loadStylesheet(SITE, '.hero{color:red}');
    loadStylesheet(APP, '.feed{color:blue}');
    const bundle = styleBundle();
    const site = bundle.hrefFor('site') ?? '';
    const app = bundle.hrefFor('app') ?? '';

    expect(site).toMatch(new RegExp(`^${STYLE_BASE_PATH}/[0-9a-f]{8}\\.css$`));
    expect(app).toMatch(new RegExp(`^${STYLE_BASE_PATH}/[0-9a-f]{8}\\.css$`));
    expect(site).not.toBe(app);
    expect(bundle.chunkAt(site)?.css).toContain('color:red');
    expect(bundle.chunkAt(site)?.css).not.toContain('color:blue');
    expect(bundle.chunkAt(app)?.css).toContain('color:blue');
  });

  // The immutable-cache promise, and the reason the registry carries a revision at all: `x dev`
  // re-registers every island's CSS on every `buildIslands`, and a URL that moved on each of those
  // would be a stylesheet re-downloaded on every save under `max-age=31536000`.
  test('the URL is stable while the CSS is, and moves when the CSS does', () => {
    loadStylesheet(SITE, '.hero{color:red}');
    const first = styleBundle().hrefFor('site');
    // The same bytes, registered again — what an island rebuild does.
    loadStylesheet(SITE, '.hero{color:red}');
    expect(styleBundle().hrefFor('site')).toBe(first);

    loadStylesheet(SITE, '.hero{color:green}');
    expect(styleBundle().hrefFor('site')).not.toBe(first);
    expect(styleBundle().chunkAt(styleBundle().hrefFor('site') ?? '')?.css).toContain(
      'color:green',
    );
  });

  test('a package sheet reaches every surface, and `null` answers the shared one', () => {
    loadStylesheet(PACKAGE, '.kit{color:green}');
    const bundle = styleBundle();

    expect(bundle.chunkAt(bundle.hrefFor('site') ?? '')?.css).toContain('color:green');
    expect(bundle.hrefFor(null)).toBe(bundle.hrefFor('shared'));
  });

  // `api/` emits no document, so a stylesheet minted for it is bytes in the export and an entry in
  // the precache manifest that no `<link>` can ever name.
  test('api/ gets no stylesheet, however much CSS the app registers', () => {
    loadStylesheet(PACKAGE, '.kit{color:green}');
    expect(styleBundle().chunks.flatMap((chunk) => chunk.surfaces)).not.toContain('api');
  });

  // An app whose only CSS is its global layer produces the SAME byte string for every surface.
  // Three copies would be three files in the static export and three entries in a precache
  // manifest that has a budget, so identical CSS is one chunk that every surface links.
  test('two surfaces with identical CSS are one file, one URL, one precache entry', () => {
    loadStylesheet(PACKAGE, '.kit{color:green}');
    const bundle = styleBundle();

    expect(bundle.chunks).toHaveLength(1);
    expect(bundle.chunks[0]?.surfaces).toEqual(['app', 'shared', 'site']);
    expect(bundle.hrefFor('site')).toBe(bundle.hrefFor('app'));
  });

  test('an app with no CSS gets an empty table rather than a link to an empty file', () => {
    expect(styleBundle().chunks).toEqual([]);
    expect(styleBundle().hrefFor('site')).toBeUndefined();
  });

  test('writeStyles puts each chunk in the export at the URL the documents carry', async () => {
    const bundle = styleBundleOf([{ surface: 'site', css: '.hero{color:red}' }]);
    await writeStyles(bundle, OUT);
    const url = bundle.chunks[0]?.url ?? '';

    expect(await Bun.file(join(OUT, url.slice(1))).text()).toBe('.hero{color:red}');
  });
});

// One question: does the source list name the exact bytes `dev-render.ts` puts in the tag? A hash
// of anything else — a normalised copy, a per-surface subset, a constant — is a policy that blocks
// the stylesheet it was written to admit, which is what shipped.

import { afterEach, describe, expect, test } from 'bun:test';
import { cspHashSource } from '@ultimat3/http';
import { clearStylesheets, loadStylesheet, stylesFor } from '@ultimat3/render/server';
import { inlineStyleSources } from './style-csp';

const SITE = '/srv/demo/apps/web/site/page.module.scss';
const APP = '/srv/demo/apps/web/app/feed/page.module.scss';

afterEach(() => {
  clearStylesheets();
});

describe('inlineStyleSources', () => {
  test('names the hash of what stylesFor returns, per surface', () => {
    loadStylesheet(SITE, '.hero{color:red}');
    loadStylesheet(APP, '.feed{color:blue}');
    const sources = inlineStyleSources();

    expect(sources).toContain(cspHashSource(stylesFor('site')));
    expect(sources).toContain(cspHashSource(stylesFor('app')));
    // A `site/` document never carries `app/` CSS, so the two are different bodies and each needs
    // its own source — one hash of the union would admit neither document.
    expect(cspHashSource(stylesFor('site'))).not.toBe(cspHashSource(stylesFor('app')));
  });

  test('every source is a quoted sha256, which is what a directive accepts', () => {
    loadStylesheet(SITE, '.hero{color:red}');
    for (const source of inlineStyleSources()) {
      expect(source).toMatch(/^'sha256-[A-Za-z0-9+/]+={0,2}'$/);
    }
  });

  test('an app with no stylesheets contributes nothing rather than a hash of the empty string', () => {
    // `dev-render.ts` emits no `<style>` at all for a surface with no CSS; a hash of '' would be
    // a source admitting an empty inline style nobody writes.
    expect(inlineStyleSources()).toEqual([]);
  });

  test('extras join the surfaces, and a body shared by two surfaces is named once', () => {
    // A package stylesheet has `surface: null`, so `stylesFor` gives every surface the same text.
    loadStylesheet('/srv/demo/packages/kit/src/kit.scss', '.kit{color:green}');
    const sources = inlineStyleSources(['body{margin:0}']);

    expect(sources).toContain(cspHashSource('body{margin:0}'));
    expect(sources).toHaveLength(2);
    expect(new Set(sources).size).toBe(sources.length);
  });

  test('the order is stable, so two boots of one build send the same header', () => {
    loadStylesheet(APP, '.feed{color:blue}');
    loadStylesheet(SITE, '.hero{color:red}');
    expect(inlineStyleSources(['b{}', 'a{}'])).toEqual(inlineStyleSources(['a{}', 'b{}']));
  });
});

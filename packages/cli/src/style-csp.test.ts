// One question: does the source list name the exact bytes a document still carries INLINE — and
// nothing else? A hash of a body no response emits is a rule describing a document nobody serves,
// which is what the app's own surface CSS became when it moved into a file: 157 kB hashed at boot
// to admit a `<style>` block `dev-render.ts` no longer writes.

import { describe, expect, test } from 'bun:test';
import { cspHashSource } from '@ultimat3/http';
import { clearStylesheets, loadStylesheet, stylesFor } from '@ultimat3/render/server';
import { inlineStyleSources } from './style-csp';

const SITE = '/srv/demo/apps/web/site/page.module.scss';

describe('inlineStyleSources', () => {
  test('the app’s own surface CSS is NOT named — it is a file, admitted by `self`', () => {
    clearStylesheets();
    loadStylesheet(SITE, '.hero{color:red}');
    try {
      expect(inlineStyleSources()).toEqual([]);
      expect(inlineStyleSources()).not.toContain(cspHashSource(stylesFor('site')));
    } finally {
      clearStylesheets();
    }
  });

  test('every source is a quoted sha256, which is what a directive accepts', () => {
    for (const source of inlineStyleSources(['body{margin:0}'])) {
      expect(source).toMatch(/^'sha256-[A-Za-z0-9+/]+={0,2}'$/);
    }
  });

  test('a body given twice is named once, and an empty one is never named', () => {
    // A hash of '' would be a source admitting an empty inline style nobody writes.
    expect(inlineStyleSources(['a{}', 'a{}', ''])).toEqual([cspHashSource('a{}')]);
  });

  test('the order is stable, so two boots of one build send the same header', () => {
    expect(inlineStyleSources(['b{}', 'a{}'])).toEqual(inlineStyleSources(['a{}', 'b{}']));
  });
});

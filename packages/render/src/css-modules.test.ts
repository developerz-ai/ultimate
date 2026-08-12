import { describe, expect, test } from 'bun:test';
import { compileStylesheet, isCssModule, isGlobalStylesheet, scopeClasses } from './css-modules';

// A real directory, because a bare `@use` is resolved by Bun against the file that wrote it.
const TOKENS = `${import.meta.dir}/page.module.scss`;

describe('isCssModule', () => {
  test('is decided by the filename, the one spelling', () => {
    expect(isCssModule('a/page.module.scss')).toBe(true);
    expect(isCssModule('a/page.module.css')).toBe(true);
    expect(isCssModule('a/global.scss')).toBe(false);
  });
});

describe('isGlobalStylesheet', () => {
  test('a plain stylesheet is the global layer; a module never is', () => {
    expect(isGlobalStylesheet('apps/web/shared/global.scss')).toBe(true);
    expect(isGlobalStylesheet('apps/web/site/page.module.scss')).toBe(false);
    expect(isGlobalStylesheet('apps/web/site/page.module.css')).toBe(false);
  });
});

describe('scopeClasses', () => {
  test('rewrites every class selector and reports the map', () => {
    const out = scopeClasses('.hero{color:red}.cta:hover{color:blue}', 'abc');
    expect(out.css).toBe('.hero_abc{color:red}.cta_abc:hover{color:blue}');
    expect(out.classes).toEqual({ hero: 'hero_abc', cta: 'cta_abc' });
  });

  test('a decimal is not a class selector', () => {
    expect(scopeClasses('.a{opacity:.5;margin:0.25rem}', 'h').css).toBe(
      '.a_h{opacity:.5;margin:0.25rem}',
    );
  });

  test('a dot inside a string or a url() is left alone', () => {
    const out = scopeClasses(".a{background:url(./b.png);content:'.c'}", 'h');
    expect(out.css).toBe(".a_h{background:url(./b.png);content:'.c'}");
    expect(out.classes).toEqual({ a: 'a_h' });
  });

  test('a bare number run survives the mask, so `flex:1 1 0` is not eaten', () => {
    expect(scopeClasses(".a{flex:1 1 0;content:'x'}", 'h').css).toBe(
      ".a_h{flex:1 1 0;content:'x'}",
    );
  });

  test('a descendant selector scopes both halves', () => {
    expect(scopeClasses('.a .b{color:red}', 'h').css).toBe('.a_h .b_h{color:red}');
  });
});

describe('compileStylesheet', () => {
  test('compiles nesting and reports scoped classes', () => {
    const out = compileStylesheet(TOKENS, '.hero{color:red;&:hover{color:blue}}');
    expect(out.classes['hero']).toMatch(/^hero_[0-9a-f]{8}$/);
    expect(out.css).toContain(':hover');
  });

  test('the scope is a function of the content, so two checkouts agree', () => {
    const a = compileStylesheet(TOKENS, '.hero{color:red}');
    const b = compileStylesheet('/elsewhere/entirely/page.module.scss', '.hero{color:red}');
    expect(a.classes).toEqual(b.classes);
  });

  test('a plain stylesheet keeps its class names', () => {
    const out = compileStylesheet('/srv/demo/apps/web/shared/tokens.scss', '.hero{color:red}');
    expect(out.classes).toEqual({});
    expect(out.css).toBe('.hero{color:red}');
  });

  test('a broken stylesheet is X_PRERENDER_FAILED naming the file, never silent', () => {
    expect(() => compileStylesheet(TOKENS, '.hero{gap: $nope}')).toThrow(/did not compile/);
    expect(() => compileStylesheet(TOKENS, '.hero{gap: $nope}')).toThrow(/page\.module\.scss/);
  });

  test('a bare specifier Bun cannot resolve falls back to Sass, so built-ins still load', () => {
    // `@ultimat3/ui/tokens` is the real bare `@use` an app writes, and it resolves through the
    // exports map — but only from a directory that depends on `@ultimat3/ui`, which tier 4 must
    // not. `sass:math` exercises the same importer and its null branch.
    const out = compileStylesheet(TOKENS, "@use 'sass:math';\n.hero{width:math.div(1,2)*100%}");
    expect(out.css).toContain('50%');
  });
});

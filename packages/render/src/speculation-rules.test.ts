// Speculation rules as text: the pattern a route path becomes, and the one body a route table
// yields — sorted, prefetch-only, and unable to close its own element.
import { describe, expect, test } from 'bun:test';
import { renderHead } from './head';
import { speculationPattern, speculationRulesBody, speculationRulesTag } from './speculation-rules';

describe('speculationPattern', () => {
  test('a plain path is itself; a param stays a named group; a catch-all is a wildcard', () => {
    expect(speculationPattern('/precios')).toBe('/precios');
    expect(speculationPattern('/blog/:slug')).toBe('/blog/:slug');
    expect(speculationPattern('/docs/*path')).toBe('/docs/*');
  });

  test('pattern syntax in a literal segment is escaped, never read as a group', () => {
    expect(speculationPattern('/a+b/(x)')).toBe('/a\\+b/\\(x\\)');
  });

  test('every routed locale is the same pattern: an optional prefix, the root included', () => {
    expect(speculationPattern('/precios', ['en'])).toBe('{/en}?/precios');
    expect(speculationPattern('/', ['en'])).toBe('{/en}?/');
    expect(speculationPattern('/precios', ['en', 'pt-br'])).toBe('{/(en|pt-br)}?/precios');
  });
});

describe('speculationRulesBody', () => {
  test('no candidate page: no rules at all', () => {
    expect(
      speculationRulesBody({ eagerness: 'moderate', include: [], exclude: [] }),
    ).toBeUndefined();
  });

  test('prefetch only — never prerender — and one string for one table, whatever its order', () => {
    const one = speculationRulesBody({
      eagerness: 'moderate',
      include: ['/b', '/a', '/b'],
      exclude: [],
    });
    const other = speculationRulesBody({
      eagerness: 'moderate',
      include: ['/a', '/b'],
      exclude: [],
    });
    expect(one).toBe(other as string);
    expect(JSON.parse(one as string)).toEqual({
      prefetch: [{ where: { href_matches: ['/a', '/b'] }, eagerness: 'moderate' }],
    });
    expect(one).not.toContain('prerender');
  });

  test('exclusions are subtracted from the candidates', () => {
    const body = speculationRulesBody({
      eagerness: 'conservative',
      include: ['/a'],
      exclude: ['/a/private/*'],
    });
    expect(JSON.parse(body as string)).toEqual({
      prefetch: [
        {
          where: { and: [{ href_matches: ['/a'] }, { not: { href_matches: ['/a/private/*'] } }] },
          eagerness: 'conservative',
        },
      ],
    });
  });

  test('a pattern cannot close the element, and the rendered tag carries the body verbatim', () => {
    const body = speculationRulesBody({
      eagerness: 'moderate',
      include: ['/a'],
      exclude: ['/</script><script>alert(1)//'],
    }) as string;
    expect(body).not.toContain('<');
    expect(renderHead([speculationRulesTag(body)])).toBe(
      `<script type="speculationrules">${body}</script>`,
    );
  });
});

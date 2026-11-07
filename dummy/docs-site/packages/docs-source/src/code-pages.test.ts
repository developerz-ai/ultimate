import { expect, test } from 'bun:test';
import { assertCodePages } from './code-pages';
import { readCorpus } from './corpus';
import { FIXTURE_OPTIONS, WIKI } from './corpus-fixture';
import { DocsCodePageMissingError } from './errors';

const corpus = readCorpus(WIKI, FIXTURE_OPTIONS);

test('every declared code with a page passes', () => {
  expect(() => assertCodePages(['X_DB_DRIFT', 'X_A', 'X_B'], corpus)).not.toThrow();
});

test('a declared code with no page is X_DOCS_CODE_PAGE_MISSING, naming it and its explain line', () => {
  try {
    assertCodePages(['X_DB_DRIFT', 'X_GONE'], corpus);
    expect.unreachable('a code with no page passed');
  } catch (error) {
    expect(DocsCodePageMissingError.is(error)).toBe(true);
    expect(error).toMatchObject({ fix: expect.stringContaining('x errors explain X_GONE') });
    expect(String((error as { cause?: unknown }).cause ?? (error as Error).message)).toContain(
      'X_GONE',
    );
  }
});

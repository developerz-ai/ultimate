// When a feature's `entity.ts` makes the next `x g entity --feature` a SIBLING. Only a file that
// readably declares other tables does: the same table spelled any other way — a template literal,
// a constant — read as "another entity", and the rerun wrote a second module for one table
// instead of the conflict it always was.

import { describe, expect, test } from 'bun:test';
import { declaresOnlyOtherEntities } from './generate-sibling';

const file = (declaration: string): string =>
  `import { entity } from '@ultimat3/entity';\n\n${declaration}\n`;

describe('unit · a second entity is a sibling only beside a readably different one', () => {
  test('another table, in either quote, makes the next entity a sibling', () => {
    for (const quote of ["'", '"', '`']) {
      const source = file(`export const blogPost = entity(${quote}blog_posts${quote}, {});`);
      expect(declaresOnlyOtherEntities(source, 'blog-attempt')).toBe(true);
    }
  });

  test('the same table is the conflict, however it is spelled', () => {
    for (const declaration of [
      "export const blogAttempt = entity('blog_attempts', {});",
      'export const blogAttempt = entity(`blog_attempts`, {});',
      "export const attempt = entity(\n  'blog_attempts',\n  {},\n);",
    ]) {
      expect(declaresOnlyOtherEntities(file(declaration), 'blog-attempt')).toBe(false);
    }
  });

  test('a table this cannot read — a constant, an interpolation — is never taken for another', () => {
    for (const declaration of [
      "const TABLE = 'blog_attempts';\nexport const row = entity(TABLE, {});",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture is source text.
      "export const row = entity(`blog_${'attempts'}`, {});",
      "export const blogPost = entity('blog_posts', {});\nexport const other = entity(NAME, {});",
    ]) {
      expect(declaresOnlyOtherEntities(file(declaration), 'blog-attempt')).toBe(false);
    }
  });

  test('the same BINDING over another table is a conflict too: two modules would export it', () => {
    const source = file("export const blogAttempt = entity('attempts_v1', {});");
    expect(declaresOnlyOtherEntities(source, 'blog-attempt')).toBe(false);
  });

  test('a file that declares no entity at all, or names one only in a comment, is no sibling host', () => {
    expect(declaresOnlyOtherEntities('export const x = 1;\n', 'blog-attempt')).toBe(false);
    const prose = "// entity('blog_posts', {}) is what it'd look like\nexport const x = 1;\n";
    expect(declaresOnlyOtherEntities(prose, 'blog-attempt')).toBe(false);
  });
});

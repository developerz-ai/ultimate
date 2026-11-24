// The markdown loader's edges: a file name is read as the file system spells it, and an alias
// list splits only at commas outside quotes.

import { describe, expect, test } from 'bun:test';
// why: Bun has no temporary-directory maker and no recursive remove, only per-file writes.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no temp-directory location of its own.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive; `sep` says whether `\` separates paths here.
import { join, sep } from 'node:path';
import { markdownRecipes, recipeFromMarkdown } from './recipe-markdown';

describe('markdownRecipes: file names', () => {
  // On POSIX `\` is a file-name character, never a separator: rewriting it would open another path.
  test.skipIf(sep === '\\')('a backslash in a file name stays in the name it reads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recipe-markdown-'));
    try {
      await Bun.write(join(dir, 'ref', 'a\\b.md'), '# Odd\n\nIts own file.\n');
      await Bun.write(join(dir, 'ref', 'a', 'b.md'), '# Elsewhere\n\nAnother file.\n');
      const recipes = await markdownRecipes({ dir });
      expect(recipes.map((recipe) => [recipe.section, recipe.name, recipe.title])).toEqual([
        ['ref', 'a\\b', 'Odd'],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('recipeFromMarkdown: aliases', () => {
  const aliasesOf = (line: string) =>
    recipeFromMarkdown('x', `---\naliases: ${line}\n---\nBody.\n`).aliases;

  test('a quoted alias may hold a comma', () => {
    expect(aliasesOf('["billing, refunds", money back]')).toEqual([
      'billing, refunds',
      'money back',
    ]);
    expect(aliasesOf("'a, b', c")).toEqual(['a, b', 'c']);
    expect(aliasesOf('x, "y, z"')).toEqual(['x', 'y, z']);
  });

  test('the plain forms split as before', () => {
    expect(aliasesOf('refund, money back')).toEqual(['refund', 'money back']);
    expect(aliasesOf('[reimburse, "credit note"]')).toEqual(['reimburse', 'credit note']);
  });
});

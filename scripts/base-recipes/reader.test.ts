// The recipe reader: which fences on `Building-Your-Own-Base` are files a reader pastes, and that
// the page still carries every recipe this directory's suites run — a renamed path or heading is a
// red here, never a proof that silently loaded nothing.

import { describe, expect, test } from 'bun:test';
import { RECIPE_PAGE, recipeFiles } from '../lib/base-recipes';
import { repoRoot } from '../lib/run';

const page = [
  '# Page',
  '## A tenant entity',
  '```ts',
  '// apps/web/shared/base/tenant-entity.ts',
  'export const a = 1;',
  '```',
  '## Recipe: billing',
  'prose',
  '```ts',
  '// apps/web/shared/base/billing.ts',
  'export const b = 2;',
  '```',
  '```ts',
  'const usage = b;',
  '```',
  '```json',
  '// apps/web/shared/base/not-ts.ts',
  '```',
  '## Read next',
].join('\n');

describe('recipeFiles', () => {
  test('a ts fence under a Recipe heading, naming an apps/ path, is a file', () => {
    expect(recipeFiles(page)).toEqual([
      {
        recipe: 'billing',
        path: 'apps/web/shared/base/billing.ts',
        line: 10,
        code: '// apps/web/shared/base/billing.ts\nexport const b = 2;',
      },
    ]);
  });

  test('a fence under any other heading is not a recipe, path or not', () => {
    const paths = recipeFiles(page).map((file) => file.path);
    expect(paths).not.toContain('apps/web/shared/base/tenant-entity.ts');
    expect(paths).not.toContain('apps/web/shared/base/not-ts.ts');
  });

  test('the page carries the four recipes the suites run', async () => {
    const text = await Bun.file(`${repoRoot()}/${RECIPE_PAGE}`).text();
    expect(recipeFiles(text).map((file) => file.path)).toEqual([
      'apps/web/shared/base/operator-pin.ts',
      'apps/web/shared/base/billing.ts',
      'apps/web/shared/base/document-pdf.ts',
      'apps/web/shared/base/proxy-pool.ts',
    ]);
  });
});

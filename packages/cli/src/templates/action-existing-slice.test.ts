// `x g action --feature <slice>` into a slice an author WROTE. The failure, measured in a product's
// blog slice (a hand-written `policy.ts`, an `entity.ts` and a `repo.ts`, none from `x g resource`):
// the generator wrote `entity.test.ts`, `repo.test.ts` and `policy.test.ts` for modules it had not
// written, merged six `admin.<slice>s.*` labels into the catalog, and emitted an action importing
// `can<Slice>Write` and `<slice>Tag` from a `policy.ts` that declares neither — so the file did
// not load, and the generator itself crashed on it after everything was on disk.
//
// An action is not a resource scaffold: it needs its own three files and the slice modules it
// IMPORTS, and it never completes a module somebody else owns.

import { describe, expect, test } from 'bun:test';
import { INVOICE_ENTITY } from '../scaffold-fixture';
import { actionFiles } from './action';

const HANDWRITTEN_POLICY = `import { can } from '@ultimat3/policy';

// The slice's own rule: one service actor publishes.
export const canPublishNote = can('blog:publish');
`;
const SCAFFOLD_POLICY = `import { tag } from '@ultimat3/cache';
import { can } from '@ultimat3/policy';
export const blogTag = tag('blog');
export const canBlogWrite = can('blog:write');
`;
const HANDWRITTEN_REPO = 'export const listNotes = (): readonly string[] => [];\n';
const SCAFFOLD_REPO = 'export async function byId(id: string) { return undefined; }\n';

const slice = { surfaceDir: 'apps/web/app', feature: 'blog' } as const;
const pathsOf = (files: ReturnType<typeof actionFiles>): readonly string[] =>
  files.map((file) => file.path);
const sourceOf = (files: ReturnType<typeof actionFiles>, suffix: string): string => {
  const file = files.find((each) => each.path.endsWith(suffix));
  if (file === undefined || typeof file.contents !== 'string')
    return expect.unreachable(`no ${suffix} was emitted`);
  return file.contents;
};

describe('unit · x g action into a hand-written slice refuses what it cannot compile', () => {
  for (const mutator of [false, true]) {
    test(`a policy.ts with no can<Feature>Write is refused before a file is planned (${mutator ? 'mutator' : 'action'})`, () => {
      const refused = (() => {
        try {
          actionFiles('write-article', { ...slice, mutator, slicePolicy: HANDWRITTEN_POLICY });
          return undefined;
        } catch (error) {
          return error as { code: string; cause: string; fix: string };
        }
      })();
      expect(refused?.code).toBe('X_SLICE_POLICY_INCOMPLETE');
      expect(refused?.cause).toContain('apps/web/app/blog/policy.ts');
      expect(refused?.cause).toContain('canBlogWrite');
      expect(refused?.fix).toContain('x g policy blog --dry-run --json');
    });
  }

  test('an action names the tag it invalidates too; a mutator does not need one', () => {
    const noTag =
      "import { can } from '@ultimat3/policy';\nexport const canBlogWrite = can('blog:write');\n";
    expect(() => actionFiles('write-article', { ...slice, slicePolicy: noTag })).toThrow('blogTag');
    expect(() =>
      actionFiles('write-article', { ...slice, mutator: true, slicePolicy: noTag }),
    ).not.toThrow();
  });

  test('a policy.ts that declares both is used as it stands', () => {
    const files = actionFiles('write-article', { ...slice, slicePolicy: SCAFFOLD_POLICY });
    expect(sourceOf(files, 'actions/write-article.ts')).toContain(
      "import { blogTag, canBlogWrite } from '../policy';",
    );
  });
});

describe('unit · x g action writes only what an action needs', () => {
  const existing = {
    ...slice,
    sliceEntity: INVOICE_ENTITY,
    sliceRepo: SCAFFOLD_REPO,
    slicePolicy: SCAFFOLD_POLICY,
  };

  test('a slice that already has its modules gets the action and its two tests — nothing else', () => {
    const paths = pathsOf(actionFiles('write-article', existing));
    expect(paths.filter((path) => !path.includes('/actions/'))).toEqual([
      // The one slice module the action imports that this slice does not have yet.
      'apps/web/app/blog/errors.ts',
    ]);
    expect(paths.filter((path) => path.includes('/actions/')).sort()).toEqual([
      'apps/web/app/blog/actions/write-article.contract.test.ts',
      'apps/web/app/blog/actions/write-article.test.ts',
      'apps/web/app/blog/actions/write-article.ts',
    ]);
  });

  test('never a test for a module it did not write, and never the admin catalog', () => {
    const paths = pathsOf(actionFiles('write-article', existing));
    for (const owned of ['entity.test.ts', 'repo.test.ts', 'policy.test.ts']) {
      expect(paths.some((path) => path.endsWith(owned))).toBe(false);
    }
    expect(paths.some((path) => path.includes('catalogs/'))).toBe(false);
  });

  test('a repo.ts with no byId gets the neutral body: no lookup the slice cannot answer', () => {
    const source = sourceOf(
      actionFiles('write-article', { ...existing, sliceRepo: HANDWRITTEN_REPO }),
      'actions/write-article.ts',
    );
    expect(source).not.toContain("'../repo'");
    expect(source).not.toContain('repo.byId');
    expect(source).toContain('return { id: input.id };');
  });

  test('a slice with nothing yet still gets the policy the action imports, with its test', () => {
    const paths = pathsOf(actionFiles('write-article', slice));
    expect(paths).toContain('apps/web/app/blog/policy.ts');
    expect(paths).toContain('apps/web/app/blog/policy.test.ts');
  });
});

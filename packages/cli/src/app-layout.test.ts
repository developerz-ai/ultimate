// The sibling refusal: `X.ts` beside `X/` is a finding naming the file; the directory form alone,
// a test beside a directory and a file whose directory holds nothing are not.

import { describe, expect, test } from 'bun:test';
import { siblingModuleFindings } from './app-layout';

const files = (...paths: string[]) => paths.map((path) => ({ path, source: '' }));

describe('siblingModuleFindings', () => {
  test('a primitive module beside its directory is refused, a component module beside its folder is not', () => {
    const found = siblingModuleFindings(
      files(
        'apps/web/app/posts/actions.ts',
        'apps/web/app/posts/actions/create-post.ts',
        'apps/web/app/posts/ui.tsx',
        'apps/web/app/posts/ui/card.tsx',
      ),
    );
    expect(found.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_LAYOUT_SIBLING_MODULE', 'apps/web/app/posts/actions.ts'],
    ]);
    expect(found[0]?.cause).toContain('apps/web/app/posts/actions/');
  });

  test('the directory form alone, and a same-named file elsewhere, are fine', () => {
    expect(
      siblingModuleFindings(
        files(
          'apps/web/app/posts/actions/create-post.ts',
          'apps/web/app/posts/actions/delete-post.ts',
          'apps/web/app/posts/page.tsx',
          'apps/web/app/feed/actions.ts',
          'apps/web/app/posts/[id]/page.tsx',
        ),
      ),
    ).toEqual([]);
  });
});

test('every primitive directory is read', () => {
  const paths = ['actions', 'live', 'queries', 'jobs', 'tasks'].flatMap((dir) => [
    `apps/web/app/posts/${dir}.ts`,
    `apps/web/app/posts/${dir}/one.ts`,
  ]);
  expect(siblingModuleFindings(files(...paths))).toHaveLength(5);
});

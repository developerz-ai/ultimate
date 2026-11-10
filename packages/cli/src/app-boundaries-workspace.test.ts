// The surface rules across app workspaces: `@<scope>/<app>/<rest>` is the spelling one app uses to
// reach another (the root tsconfig's one alias), and it must land on the same graph key a relative
// import would — or `site/` reaches a sibling app's `app/` with `boundaries` green.

import { describe, expect, test } from 'bun:test';
import type { SourceFile } from './app-boundaries';
import { checkImportRules, resolveSpecifier } from './app-boundaries';

const file = (path: string, source: string): SourceFile => ({ path, source });

describe('unit · a sibling app reached by its workspace name', () => {
  test('a site page importing another app’s app/ is X_BOUNDARY_SITE_TO_APP', () => {
    const findings = checkImportRules([
      file(
        'apps/marketing/site/about/page.tsx',
        "import { PostForm } from '@mono/web/app/post/post-form.island';\nexport const x = PostForm;",
      ),
      file('apps/web/app/post/post-form.island.tsx', 'export const PostForm = 1;'),
    ]);
    expect(findings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_BOUNDARY_SITE_TO_APP', 'apps/marketing/site/about/page.tsx'],
    ]);
  });

  test('the alias resolves onto a key with the same suffixes a relative import gets', () => {
    const keys = new Set(['apps/web/shared/roles.ts', 'apps/web/api/index.ts']);
    expect(resolveSpecifier('apps/marketing/app/x.ts', '@mono/web/shared/roles', keys)).toBe(
      'apps/web/shared/roles.ts',
    );
    expect(resolveSpecifier('apps/marketing/app/x.ts', '@mono/web/api', keys)).toBe(
      'apps/web/api/index.ts',
    );
  });

  test('a package or a framework specifier that lands on no app file is left as written', () => {
    const keys = new Set(['apps/web/shared/roles.ts']);
    expect(resolveSpecifier('apps/marketing/app/x.ts', '@mono/domain', keys)).toBe('@mono/domain');
    expect(resolveSpecifier('apps/marketing/app/x.ts', '@ultimat3/core', keys)).toBe(
      '@ultimat3/core',
    );
  });
});

// `app/ → api/` is types-only INSIDE one app: its `api/index.ts` imports that app's own `app/`
// slices to register them, so a value edge back is a cycle. A sibling app's registry carries no
// such cycle, and `apps/admin` projecting `apps/web`'s actions is the documented pattern.
describe('unit · a sibling app’s api/ registry, by value', () => {
  const web = file(
    'apps/web/api/index.ts',
    "import { a } from '../app/post/a';\nexport const api = a;",
  );
  const slice = file('apps/web/app/post/a.ts', 'export const a = 1;');

  test('apps/admin/app importing @<scope>/web/api is not X_BOUNDARY_APP_TO_API', () => {
    const findings = checkImportRules([
      file(
        'apps/admin/app/admin/admin.ts',
        "import { api } from '@postly/web/api';\nexport const x = api;",
      ),
      web,
      slice,
    ]);
    expect(findings.map((finding) => finding.code)).toEqual([]);
  });

  test('the same edge inside one app stays refused', () => {
    const findings = checkImportRules([
      file(
        'apps/web/app/admin/admin.ts',
        "import { api } from '../../api';\nexport const x = api;",
      ),
      web,
      slice,
    ]);
    expect(findings.map((finding) => finding.code)).toEqual(['X_BOUNDARY_APP_TO_API']);
  });

  test('a site page reaching a sibling app’s api/ stays refused', () => {
    const findings = checkImportRules([
      file(
        'apps/admin/site/p/page.tsx',
        "import { api } from '@postly/web/api';\nexport const x = api;",
      ),
      web,
      slice,
    ]);
    expect(findings.map((finding) => finding.code)).not.toEqual([]);
  });
});

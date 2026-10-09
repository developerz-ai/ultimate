// The gate's boundary finding carries the edit itself. It said `x fix boundary <file>`, which
// printed another fix and wrote nothing — a fix that was only a pointer to the real one.

import { describe, expect, test } from 'bun:test';
import type { SourceFile } from './app-boundaries';
import { appImportGraph, checkImportRules } from './app-boundaries';
import { appBoundaryFindings, withCutEdits } from './boundary-findings';

const file = (path: string, source: string): SourceFile => ({ path, source });

describe('unit · a boundary finding names the concrete edit', () => {
  test('site/ importing app/: the fix is the import to delete, in the file that holds it', () => {
    const files = [
      file('apps/web/site/pricing/page.tsx', "import { Chart } from '../../app/charts';"),
      file('apps/web/app/charts.ts', 'export const Chart = 1;'),
    ];
    const [finding] = withCutEdits(checkImportRules(files), appImportGraph(files));
    expect(finding?.code).toBe('X_BOUNDARY_SITE_TO_APP');
    expect(finding?.fix).toBe(
      'delete the import of apps/web/app/charts.ts in apps/web/site/pricing/page.tsx',
    );
    expect(finding?.fix).not.toContain('x fix boundary');
  });

  test('a layer finding keeps its own fix — only a surface cut has an edit to hand over', () => {
    const files = [file('apps/web/site/page.tsx', "import { db } from '@acme/db';")];
    const findings = checkImportRules(files);
    expect(withCutEdits(findings, appImportGraph(files))).toEqual(findings);
  });
});

describe('unit · the boundaries step refuses a second layout', () => {
  test('a module beside a directory of its own name is a finding of the step', async () => {
    const files = [
      file('apps/web/app/posts/actions.ts', 'export const legacy = 1;'),
      file('apps/web/app/posts/actions/create-post.ts', 'export const createPost = 1;'),
    ];
    const found = await appBoundaryFindings('/nowhere', files);
    expect(found.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_LAYOUT_SIBLING_MODULE', 'apps/web/app/posts/actions.ts'],
    ]);
  });
});

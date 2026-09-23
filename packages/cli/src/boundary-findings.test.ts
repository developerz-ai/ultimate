// The gate's boundary finding carries the edit itself. It said `x fix boundary <file>`, which
// printed another fix and wrote nothing — a fix that was only a pointer to the real one.

import { describe, expect, test } from 'bun:test';
import type { SourceFile } from './app-boundaries';
import { appImportGraph, checkImportRules } from './app-boundaries';
import { withCutEdits } from './boundary-findings';

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

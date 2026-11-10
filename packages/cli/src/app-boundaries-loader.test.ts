// `defineApi` is an app's one registration path. The `./loader` subpaths of `@ultimat3/action` and
// `@ultimat3/query` are `x`'s module scan's — an app module importing one is a second path, refused.

import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no tmpdir(); the fixture app lives outside the checkout.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import type { SourceFile } from './app-boundaries';
import { BOUNDARY_CODES, checkImportRules } from './app-boundaries';
import { appBoundaryFindings } from './boundary-findings';
import { CLI_BOUNDARY_ERROR_CODES } from './error-codes-boundary';

const file = (path: string, source: string): SourceFile => ({ path, source });

describe('unit · app boundaries · the loader subpaths', () => {
  test('an api module importing @ultimat3/action/loader is refused, with defineApi as the fix', () => {
    const findings = checkImportRules([
      file(
        'apps/web/api/index.ts',
        "import { registerActions } from '@ultimat3/action/loader';\nregisterActions({});",
      ),
    ]);
    expect(findings.map((finding) => finding.code)).toEqual(['X_BOUNDARY_LOADER_IMPORT']);
    expect(findings[0]?.at).toBe('apps/web/api/index.ts');
    expect(findings[0]?.fix).toStartWith('export const api = defineApi({ actions: [');
    expect(findings[0]?.fix).toContain('apps/web/api/index.ts');
  });

  test('a page importing @ultimat3/query/loader is refused, and told to list it as queries', () => {
    const findings = checkImportRules([
      file(
        'apps/web/app/feed/page.tsx',
        "import { registerQuery } from '@ultimat3/query/loader';\nregisterQuery('x', y);",
      ),
    ]);
    expect(findings.map((finding) => finding.code)).toEqual(['X_BOUNDARY_LOADER_IMPORT']);
    expect(findings[0]?.fix).toStartWith('export const api = defineApi({ queries: [');
  });

  test('the barrels and another package named loader are not the rule', () => {
    expect(
      checkImportRules([
        file('apps/web/api/index.ts', "import { defineApi } from '@ultimat3/action';"),
        file('apps/web/shared/load.ts', "import { x } from '@acme/action/loader';"),
      ]),
    ).toEqual([]);
  });

  test("the code is one of the boundary step's, registered and listed", () => {
    expect(BOUNDARY_CODES).toContain('X_BOUNDARY_LOADER_IMPORT');
    expect(CLI_BOUNDARY_ERROR_CODES).toContain('X_BOUNDARY_LOADER_IMPORT');
  });
});

// A test is no app source for any other rule, but it is where an agent reaches for the loader:
// `registerQuery` left the barrel, and `/loader` is the nearest import that compiles again.
describe('unit · app boundaries · the loader rule reads app tests too', () => {
  const root = join(tmpdir(), `x-loader-tests-${process.pid}-${Date.now()}`);
  afterAll(() => rm(root, { recursive: true, force: true }));

  test('an app .test.ts importing a loader is refused; its other imports stay unjudged', async () => {
    const at = 'apps/web/app/feed/live/feed.live.test.ts';
    await Bun.write(
      join(root, at),
      [
        "import { registerQuery } from '@ultimat3/query/loader';",
        "import { handler } from '../../../api/feed';",
        "registerQuery('feed', handler);",
      ].join('\n'),
    );
    const findings = await appBoundaryFindings(root);
    expect(findings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_BOUNDARY_LOADER_IMPORT', at],
    ]);
    expect(findings[0]?.fix).toStartWith('export const api = defineApi({ queries: [');
  });
});

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { driftReachOf, readChangedFacts } from './verify-changed-facts';

const file = (path: string, imports: readonly string[], seed = false, opaque = false) => ({
  path,
  imports,
  seed,
  opaque,
});

describe('unit · the drift closure', () => {
  test('reaches what a seed imports, transitively, and nothing that only imports a seed', () => {
    const reach = driftReachOf([
      file('apps/web/app/post/entity.ts', ['packages/domain/src/index.ts'], true),
      file('packages/domain/src/index.ts', ['packages/domain/src/money.ts']),
      file('packages/domain/src/money.ts', []),
      file('apps/web/app/post/service.ts', ['apps/web/app/post/entity.ts']),
    ]);
    expect(reach).toEqual(
      new Set([
        'apps/web/app/post/entity.ts',
        'packages/domain/src/index.ts',
        'packages/domain/src/money.ts',
      ]),
    );
  });

  test('a computed import inside the closure makes every file a drift input', () => {
    const reach = driftReachOf([
      file('apps/web/app/post/entity.ts', ['apps/web/app/post/dyn.ts'], true),
      file('apps/web/app/post/dyn.ts', [], false, true),
    ]);
    expect(reach).toBe('everything');
  });
});

const root = mkdtempSync(join(tmpdir(), 'verify-changed-facts-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('unit · readChangedFacts over a tree', () => {
  test('seeds on the entity import, not the filename, and lists every TypeScript file', async () => {
    await Bun.write(
      join(root, 'apps/web/app/billing/invoice-table.ts'),
      "import { entity } from '@ultimat3/entity';\nimport { cents } from './cents';\nexport const t = entity;\n",
    );
    await Bun.write(join(root, 'apps/web/app/billing/cents.ts'), 'export const cents = 100;\n');
    await Bun.write(join(root, 'apps/web/site/page.tsx'), 'export const page = 1;\n');
    await Bun.write(join(root, 'packages/db/src/client.ts'), 'export const db = 1;\n');
    const facts = await readChangedFacts(root);
    expect(facts.driftReach).toEqual(
      new Set([
        'apps/web/app/billing/invoice-table.ts',
        'apps/web/app/billing/cents.ts',
        'packages/db/src/client.ts',
      ]),
    );
    expect(facts.known.has('apps/web/site/page.tsx')).toBe(true);
  });
});

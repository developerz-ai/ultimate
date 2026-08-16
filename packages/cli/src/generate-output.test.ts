// What `generate()` EMITS, per primitive and across all ten — the projection alone, with no
// filesystem and no command wiring, so a red line here is a template bug and never a write one.
// Catalog output is `generate-catalogs.test.ts`; writing, containment and the command surface stay
// in `cmd-generate.test.ts` beside the code that does them.

import { describe, expect, test } from 'bun:test';
import { GENERATORS, generate } from './cmd-generate';
import type { GeneratedFile } from './templates';
import { thrownBy } from './thrown-by';

const loaderFor = (path: string): 'ts' | 'tsx' => (path.endsWith('.tsx') ? 'tsx' : 'ts');

/** Parses with Bun's own transpiler: a generator that emits unparseable TS is a broken generator. */
const parses = (file: GeneratedFile): boolean => {
  new Bun.Transpiler({ loader: loaderFor(file.path) }).transformSync(file.contents);
  return true;
};

const typescript = (files: readonly GeneratedFile[]): readonly GeneratedFile[] =>
  files.filter((file) => file.path.endsWith('.ts') || file.path.endsWith('.tsx'));

describe('unit · what x g emits', () => {
  test('every generator emits parseable TypeScript', () => {
    for (const kind of GENERATORS) {
      for (const file of typescript(generate({ kind, name: 'invoice', feature: 'invoice' }))) {
        expect(parses(file)).toBe(true);
      }
    }
  });

  test('every generator emits a test next to its source', () => {
    for (const kind of GENERATORS) {
      const files = generate({ kind, name: 'invoice', feature: 'invoice' });
      const tests = files.filter((file) => file.path.endsWith('.test.ts'));
      expect(tests.length).toBeGreaterThan(0);
      for (const testFile of tests) {
        expect(testFile.contents).toContain('@ultimat3/testing');
        expect(testFile.contents).toContain('expect(');
      }
    }
  });

  test('no generated file contains a TODO placeholder', () => {
    for (const kind of GENERATORS) {
      for (const file of generate({ kind, name: 'invoice', feature: 'invoice' })) {
        expect(file.contents.includes('TODO')).toBe(false);
      }
    }
  });

  test('the action generator writes the action, its test and the feature error type', () => {
    const files = generate({ kind: 'action', name: 'publish-invoice', feature: 'invoice' });
    const paths = files.map((file) => file.path);
    expect(paths).toContain('apps/web/app/invoice/actions/publish-invoice.ts');
    expect(paths).toContain('apps/web/app/invoice/actions/publish-invoice.test.ts');
    expect(paths).toContain('apps/web/app/invoice/errors.ts');
  });

  test('the action test pins the policy denial branch, through the action itself', () => {
    const files = generate({ kind: 'action', name: 'publish-invoice', feature: 'invoice' });
    const testFile = files.find((file) => file.path.endsWith('publish-invoice.test.ts'));
    expect(testFile?.contents).toContain('toRejectInput');
    // `.as()` is the one execution path with the actor swapped, so a denial asserted through it
    // is the denial HTTP, MCP and the job surface would produce.
    expect(testFile?.contents).toContain('.as(outsider,');
    expect(testFile?.contents).toContain("toBeUltimateError('X_FORBIDDEN')");
  });

  test('generated tests drive the fluent surface, never a projection function', () => {
    const files = generate({ kind: 'action', name: 'publish-invoice', feature: 'invoice' });
    const testFile = files.find((file) => file.path.endsWith('publish-invoice.test.ts'));
    expect(testFile?.contents).toContain('.contract()');
    // One authz object across surfaces — the claim the whole DSL rests on.
    expect(testFile?.contents).toContain('.tool().policy');
    expect(testFile?.contents).toContain('.openapi().operationId');
    for (const reached of ['toMcpTool(', 'toOpenApiOperation(', 'contractTestsFor(']) {
      expect(testFile?.contents.includes(reached)).toBe(false);
    }
  });

  test('a primitive imports t from its own package, never from @ultimat3/schema', () => {
    for (const kind of GENERATORS) {
      for (const file of typescript(generate({ kind, name: 'invoice', feature: 'invoice' }))) {
        expect(file.contents.includes("from '@ultimat3/schema'")).toBe(false);
      }
    }
  });

  test('no generated file reaches through .def — the declaration is not app surface', () => {
    for (const kind of GENERATORS) {
      for (const file of typescript(generate({ kind, name: 'invoice', feature: 'invoice' }))) {
        expect(/\.def\b/.test(file.contents)).toBe(false);
      }
    }
  });

  test('x g policy declares its permission set both ways', () => {
    const files = generate({ kind: 'policy', name: 'invoice', feature: 'invoice' });
    const source = files.find((file) => file.path.endsWith('policy.ts'));
    // The augmentation narrows can() at compile time; definePermissions is the same set at run
    // time. One without the other leaves half the typo unguarded.
    expect(source?.contents).toContain("declare module '@ultimat3/policy'");
    expect(source?.contents).toContain('definePermissions([');
    expect(source?.contents).toContain("'invoice:read': true;");
  });

  test('a live query is generated bounded and ordered, and its test says so', () => {
    const files = generate({ kind: 'query', name: 'invoiceList', feature: 'invoice', live: true });
    const source = files.find((file) => file.path.endsWith('invoice-list.ts'));
    expect(source?.path).toBe('apps/web/app/invoice/live/invoice-list.ts');
    expect(source?.contents).toContain('.orderBy(');
    expect(source?.contents).toContain('.limit(');
    const testFile = files.find((file) => file.path.endsWith('invoice-list.test.ts'));
    expect(testFile?.contents).toContain('order by');
  });

  test('a job is generated with a required idempotency key', () => {
    const files = generate({ kind: 'job', name: 'reindex', feature: 'invoice' });
    const source = files.find((file) => file.path.endsWith('reindex.ts'));
    expect(source?.contents).toContain('idempotencyKey:');
    const testFile = files.find((file) => file.path.endsWith('reindex.test.ts'));
    // Pinned through a real driver: the key only matters because the second enqueue dedupes.
    // `input`, not `{ id }` — the emitted job declares `tenant: (input) => input.orgId`, so its
    // payload carries the org the run acts under and the enqueue has to name it.
    expect(testFile?.contents).toContain('.enqueue(input)');
    // The resolver, not the field: `tenant: 'none'` and `tenant: () => 'whatever'` both satisfy
    // `toContain('tenant:')` while stripping the org off every read the generated job makes.
    expect(source?.contents).toContain('tenant: (input) => input.orgId,');
    expect(testFile?.contents).toContain('deduped');
  });

  test('a site route is generated with a 0kb budget and no hydration', () => {
    const files = generate({ kind: 'route', name: 'pricing', surface: 'site' });
    const page = files.find((file) => file.path.endsWith('page.tsx'));
    expect(page?.path).toBe('apps/web/site/pricing/page.tsx');
    expect(page?.contents).toContain("hydrate: 'never'");
    expect(page?.contents).toContain("js: '0kb'");
  });

  test('a resource is a whole slice and writes each shared file exactly once', () => {
    const files = generate({ kind: 'resource', name: 'invoice' });
    const paths = files.map((file) => file.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const expected of [
      'apps/web/app/invoice/entity.ts',
      'apps/web/app/invoice/repo.ts',
      'apps/web/app/invoice/policy.ts',
      'apps/web/app/invoice/service.ts',
      'apps/web/app/invoice/ui.tsx',
      'apps/web/app/invoice/errors.ts',
    ]) {
      expect(paths).toContain(expected);
    }
  });

  test('no generated stylesheet contains a raw colour', () => {
    const files = generate({ kind: 'resource', name: 'invoice' });
    for (const file of files.filter((entry) => entry.path.endsWith('.scss'))) {
      expect(/#[0-9a-fA-F]{3,8}\b/.test(file.contents)).toBe(false);
    }
  });

  test('a resource with --admin also emits the admin override', () => {
    const withoutAdmin = generate({ kind: 'resource', name: 'invoice' });
    expect(withoutAdmin.map((file) => file.path)).not.toContain(
      'apps/web/app/invoice/admin/resource.ts',
    );
    const withAdmin = generate({ kind: 'resource', name: 'invoice', admin: true });
    const paths = withAdmin.map((file) => file.path);
    expect(paths).toContain('apps/web/app/invoice/admin/resource.ts');
    expect(paths).toContain('apps/web/app/invoice/admin/resource.test.ts');
    const source = withAdmin.find((file) => file.path.endsWith('admin/resource.ts'));
    expect(source?.contents).toContain('invoiceAdminResource');
  });

  test('x g resource --surface site is refused, not half-written into the static surface', () => {
    const failure = thrownBy(() =>
      generate({ kind: 'resource', name: 'invoice', surface: 'site' }),
    );
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    // The caller's own name, not `<name>`: a `fix:` is copied and run verbatim, and a `<…>` in a
    // shell is a redirect, not an argument.
    expect(failure.fix).toBe('x g resource invoice && x g route invoice --surface site');
    expect(failure.fix).not.toContain('<');
    // The route generator is where `site` belongs, and it still works.
    expect(generate({ kind: 'route', name: 'pricing', surface: 'site' }).length).toBeGreaterThan(0);
  });

  test('a resource route lands on the surface the slice lives on', () => {
    const paths = generate({ kind: 'resource', name: 'invoice' }).map((file) => file.path);
    expect(paths).toContain('apps/web/app/invoices/page.tsx');
    expect(paths.some((path) => path.startsWith('apps/web/site/'))).toBe(false);
  });
});

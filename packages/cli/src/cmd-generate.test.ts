import { describe, expect, test } from 'bun:test';
import { GENERATORS, generate } from './cmd-generate';
import type { GeneratedFile } from './templates';

const loaderFor = (path: string): 'ts' | 'tsx' => (path.endsWith('.tsx') ? 'tsx' : 'ts');

/** Parses with Bun's own transpiler: a generator that emits unparseable TS is a broken generator. */
const parses = (file: GeneratedFile): boolean => {
  new Bun.Transpiler({ loader: loaderFor(file.path) }).transformSync(file.contents);
  return true;
};

const typescript = (files: readonly GeneratedFile[]): readonly GeneratedFile[] =>
  files.filter((file) => file.path.endsWith('.ts') || file.path.endsWith('.tsx'));

describe('unit · x g', () => {
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

  test('the action test pins the policy denial branch', () => {
    const files = generate({ kind: 'action', name: 'publish-invoice', feature: 'invoice' });
    const testFile = files.find((file) => file.path.endsWith('publish-invoice.test.ts'));
    expect(testFile?.contents).toContain('toDenyPolicy');
    expect(testFile?.contents).toContain('toRejectInput');
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
    expect(testFile?.contents).toContain('toEmitSteps');
  });

  test('a site route is generated with a 0kb budget and no hydration', () => {
    const files = generate({ kind: 'route', name: 'pricing', surface: 'site' });
    const page = files.find((file) => file.path.endsWith('page.tsx'));
    expect(page?.path).toBe('apps/web/site/pricing/page.tsx');
    expect(page?.contents).toContain("hydrate: 'never'");
    expect(page?.contents).toContain("js: '0kb'");
  });

  test('a route ships an i18n catalog entry rather than a hardcoded string', () => {
    const files = generate({ kind: 'route', name: 'pricing', surface: 'site' });
    const catalog = files.find((file) => file.path.endsWith('.json'));
    expect(catalog?.path).toBe('packages/i18n/catalogs/en/pricing.json');
    const page = files.find((file) => file.path.endsWith('page.tsx'));
    expect(page?.contents).toContain("t('app.pricing.title')");
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
});

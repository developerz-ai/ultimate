import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// Bun ships no `Bun.*` equivalent for any of these: `existsSync` proves a write did or did not
// happen, `mkdtemp`/`rm` own a throwaway app root's lifetime, and `join`/`resolve` build the
// host-separator paths — `resolve` because only resolving proves a path stayed inside the root.
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MANIFEST_FILENAME } from '@ultimat3/manifest';
import { resetAppLoad } from './app-load';
import { GENERATORS, generate, generateCommand, writeFiles } from './cmd-generate';
import type { CommandContext } from './command';
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
    expect(testFile?.contents).toContain('.enqueue({ id })');
    expect(testFile?.contents).toContain('deduped');
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

  test('a resource ships the card and form components, and their i18n keys', () => {
    const files = generate({ kind: 'resource', name: 'invoice' });
    const paths = files.map((file) => file.path);
    expect(paths).toContain('apps/web/app/invoice/ui/invoice-card.tsx');
    expect(paths).toContain('apps/web/app/invoice/ui/invoice-form.tsx');
    const catalog = files.find((file) => file.path === 'packages/i18n/catalogs/en/invoice.json');
    expect(catalog?.contents).toContain('app.invoice.empty');
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

  test('a resource takes every configured locale for its catalogs', () => {
    const files = generate({ kind: 'resource', name: 'invoice', locales: ['en', 'es'] });
    const paths = files.map((file) => file.path);
    expect(paths).toContain('packages/i18n/catalogs/en/invoice.json');
    expect(paths).toContain('packages/i18n/catalogs/es/invoice.json');
    expect(paths).toContain('packages/i18n/catalogs/en/invoices.json');
    expect(paths).toContain('packages/i18n/catalogs/es/invoices.json');
  });

  test('a route takes the configured locales too, not just a resource', () => {
    const files = generate({
      kind: 'route',
      name: 'pricing',
      surface: 'site',
      locales: ['en', 'es'],
    });
    const paths = files.map((file) => file.path);
    expect(paths).toContain('packages/i18n/catalogs/en/pricing.json');
    expect(paths).toContain('packages/i18n/catalogs/es/pricing.json');
  });

  test('the catalog carries the admin title key the admin override resolves', () => {
    // Emitted whether or not --admin was passed: an unused key is only reported, a missing one
    // renders ⟦key⟧ and fails the i18n gate the moment someone writes the override by hand.
    for (const admin of [false, true]) {
      const files = generate({ kind: 'resource', name: 'invoice', admin });
      const catalog = files.find((file) => file.path === 'packages/i18n/catalogs/en/invoice.json');
      expect(JSON.parse(catalog?.contents ?? '{}')['admin.invoice.title']).toBe('Invoices');
    }
    const withAdmin = generate({ kind: 'resource', name: 'invoice', admin: true });
    const override = withAdmin.find((file) => file.path.endsWith('admin/resource.ts'));
    expect(override?.contents).toContain("titleKey: 'admin.invoice.title'");
  });

  test('a locale that is really a path never becomes a catalog directory', () => {
    const failure = thrownBy(() =>
      generate({ kind: 'resource', name: 'invoice', locales: ['../../../../tmp'] }),
    );
    expect(failure.code).toBe('X_SCAFFOLD_PATH_ESCAPE');
    expect(failure.fix).toBe('x g resource <name> --locales=en,es');
    // Same guard on the route generator, which owns the other half of the catalogs.
    expect(thrownBy(() => generate({ kind: 'route', name: 'pricing', locales: ['..'] })).code).toBe(
      'X_SCAFFOLD_PATH_ESCAPE',
    );
  });

  test('a locale that is not a BCP-47 tag is refused rather than silently dropped', () => {
    const failure = thrownBy(() =>
      generate({ kind: 'resource', name: 'invoice', locales: ['en_US'] }),
    );
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(failure.cause).toContain('en_US');
  });

  test('locales are canonicalized and deduped once, for every catalog a run emits', () => {
    const files = generate({
      kind: 'resource',
      name: 'invoice',
      locales: [' EN ', 'en', 'zh-Hant'],
    });
    const catalogs = files
      .map((file) => file.path)
      .filter((path) => path.startsWith('packages/i18n/catalogs/'));
    expect(catalogs.toSorted()).toEqual([
      'packages/i18n/catalogs/en/invoice.json',
      'packages/i18n/catalogs/en/invoices.json',
      'packages/i18n/catalogs/zh-hant/invoice.json',
      'packages/i18n/catalogs/zh-hant/invoices.json',
    ]);
  });

  test('x g resource --surface site is refused, not half-written into the static surface', () => {
    const failure = thrownBy(() =>
      generate({ kind: 'resource', name: 'invoice', surface: 'site' }),
    );
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(failure.fix).toBe('x g resource <name> && x g route <name> --surface site');
    // The route generator is where `site` belongs, and it still works.
    expect(generate({ kind: 'route', name: 'pricing', surface: 'site' }).length).toBeGreaterThan(0);
  });

  test('a resource route lands on the surface the slice lives on', () => {
    const paths = generate({ kind: 'resource', name: 'invoice' }).map((file) => file.path);
    expect(paths).toContain('apps/web/app/invoices/page.tsx');
    expect(paths.some((path) => path.startsWith('apps/web/site/'))).toBe(false);
  });
});

describe('unit · x g writes inside the app and nowhere else', () => {
  const withRoot = async (body: (root: string) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), 'x-generate-'));
    try {
      await body(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  test('a generated file lands under the root and is reported by its relative path', async () => {
    await withRoot(async (root) => {
      const report = await writeFiles(
        root,
        [{ path: 'apps/web/app/a.ts', contents: 'export {};' }],
        false,
      );
      expect(report.written).toEqual(['apps/web/app/a.ts']);
      expect(existsSync(join(root, 'apps/web/app/a.ts'))).toBe(true);
    });
  });

  test('a .. segment is refused, and nothing in the set is written', async () => {
    await withRoot(async (root) => {
      const files = [
        { path: 'apps/web/app/first.ts', contents: 'export {};' },
        { path: '../escaped.ts', contents: 'export {};' },
      ];
      const failure = (await writeFiles(root, files, false).catch((error: unknown) => error)) as {
        code?: string;
        cause?: string;
      };
      expect(failure.code).toBe('X_SCAFFOLD_PATH_ESCAPE');
      expect(failure.cause).toContain('../escaped.ts');
      // Proven before the first write, so the file ahead of the offender never landed either.
      expect(existsSync(join(root, 'apps/web/app/first.ts'))).toBe(false);
      expect(existsSync(resolve(root, '../escaped.ts'))).toBe(false);
    });
  });

  test('an absolute path is refused: it would ignore the app root entirely', async () => {
    await withRoot(async (root) => {
      const outside = join(tmpdir(), 'x-generate-absolute-probe.ts');
      const failure = (await writeFiles(
        root,
        [{ path: outside, contents: 'export {};' }],
        false,
      ).catch((error: unknown) => error)) as { code?: string };
      expect(failure.code).toBe('X_SCAFFOLD_PATH_ESCAPE');
      expect(existsSync(outside)).toBe(false);
    });
  });
});

// `x g` refreshes `x.manifest.json` so the table an agent reads after a scaffold is current. That
// only holds if the load was whole: a module that would not import is missing from the registries,
// and persisting the projection anyway replaces the compatibility contract with a subset.
describe('unit · x g keeps the manifest off a partial load', () => {
  // Under `packages/cli/` so the scaffold's `@ultimat3/*` imports resolve through the same tsconfig
  // paths the framework's own sources use; a dot-prefixed name stays out of every workspace glob.
  const ROOT = join(import.meta.dir, '..', '.generate-fixture');
  const BROKEN = 'apps/web/app/broken.ts';

  const contextFor = (): CommandContext => ({
    args: {
      command: 'g',
      subcommand: undefined,
      positionals: ['policy', 'scaffold-probe'],
      flags: new Map(),
      json: false,
      help: false,
      passthrough: [],
    },
    cwd: ROOT,
    runner: async () => ({
      command: ['true'],
      code: 0,
      ok: true,
      stdout: '',
      stderr: '',
      durationMs: 0,
    }),
    env: {},
    bunVersion: '1.3.0',
  });

  beforeAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
    await Bun.write(join(ROOT, 'app.config.ts'), `export const config = { name: 'gen' };\n`);
    await Bun.write(
      join(ROOT, 'package.json'),
      JSON.stringify({ name: 'generate-fixture', version: '1.0.0' }),
    );
    await Bun.write(join(ROOT, BROKEN), `export { nope } from './does-not-exist';\n`);
    resetAppLoad();
  });

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
    resetAppLoad();
  });

  test('the scaffold lands, the manifest does not, and the load failure is the finding', async () => {
    const result = await generateCommand.run(contextFor());
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => finding.at)).toContain(BROKEN);
    expect((result.data as { files?: readonly string[] }).files?.length).toBeGreaterThan(0);
    expect(existsSync(join(ROOT, MANIFEST_FILENAME))).toBe(false);
    // No `+ x.manifest.json` line either: the human render may not claim a write that never was.
    expect(result.lines?.some((line) => line.includes(MANIFEST_FILENAME))).toBe(false);
  });
});

// What `x g` DOES: the writes it makes, the containment it proves before making them, and the
// argv it refuses. The bytes each generator emits are `generate-output.test.ts` and the catalogs
// are `generate-catalogs.test.ts` — this file owns the filesystem and the command surface.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove, so a throwaway app root's lifetime is node:fs's.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path API — nothing native joins, resolves or relativises a path.
import { join, resolve } from 'node:path';
import { MANIFEST_FILENAME } from '@ultimat3/manifest';
import { resetAppLoad } from './app-load';
import { REQUIRED_BUN } from './app-root';
import { GENERATORS, generateCommand, writeFiles } from './cmd-generate';
import type { CommandContext } from './command';
import { exec } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import type { GeneratedFile } from './templates';

/** A real app root, because `x g` resolves one before it reads a single argument. */
const EXAMPLE_APP = join(import.meta.dir, '..', '..', '..', 'examples', 'dummy');

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
      expect(await Bun.file(join(root, 'apps/web/app/a.ts')).exists()).toBe(true);
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
      expect(await Bun.file(join(root, 'apps/web/app/first.ts')).exists()).toBe(false);
      expect(await Bun.file(resolve(root, '../escaped.ts')).exists()).toBe(false);
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
      expect(await Bun.file(outside).exists()).toBe(false);
    });
  });

  test('a conflict names the invocation that would overwrite it, verbatim', async () => {
    await withRoot(async (root) => {
      const file = { path: 'apps/web/app/posts/actions.ts', contents: 'export {};' };
      await Bun.write(join(root, file.path), 'mine');

      const report = await writeFiles(root, [file], false, 'x g action publishPost');

      // `x g --force` was the shipped fix line and it is not a command: `x g` with no generator
      // is X_CLI_UNKNOWN_COMMAND. A `fix:` is copied and run verbatim, and the conflict path has
      // both the kind and the name in hand — the same construction `generate-kinds.ts` uses.
      expect(report.conflicts[0]?.code).toBe('X_GENERATE_CONFLICT');
      expect(report.conflicts[0]?.fix).toContain('x g action publishPost --force');
      expect(report.conflicts[0]?.fix).not.toContain('x g --force');
    });
  });

  test('writeFiles merges a catalog: a human-edited value wins, and missing keys are added', async () => {
    await withRoot(async (root) => {
      const path = 'packages/i18n/catalogs/en.json';
      await Bun.write(
        join(root, path),
        `${JSON.stringify(
          { 'app.invoice.empty': 'Custom empty text', 'app.invoice.stale': 'kept' },
          null,
          2,
        )}\n`,
      );
      const generated: GeneratedFile = {
        path,
        contents: JSON.stringify({
          'app.invoice.empty': 'No invoices yet.',
          'app.invoice.updated': 'Last updated',
        }),
        merge: 'json',
      };
      const report = await writeFiles(root, [generated], false);
      expect(report.conflicts).toEqual([]);
      expect(report.written).toEqual([path]);
      const onDisk = JSON.parse(await Bun.file(join(root, path)).text()) as Record<string, string>;
      // The key both sides emit keeps the human's value, not the generator's...
      expect(onDisk['app.invoice.empty']).toBe('Custom empty text');
      // ...a key only the file on disk had survives untouched...
      expect(onDisk['app.invoice.stale']).toBe('kept');
      // ...and a key only the generator emits is the one thing actually added.
      expect(onDisk['app.invoice.updated']).toBe('Last updated');
    });
  });

  test('writeFiles never rewrites a catalog once every generated key is already on disk', async () => {
    await withRoot(async (root) => {
      const path = 'packages/i18n/catalogs/en.json';
      const contents = `${JSON.stringify({ 'app.invoice.empty': 'No invoices yet.' }, null, 2)}\n`;
      await Bun.write(join(root, path), contents);
      const report = await writeFiles(
        root,
        [{ path, contents: JSON.stringify({ 'app.invoice.empty': 'different' }), merge: 'json' }],
        false,
      );
      // Nothing new to add, so the report says so honestly and the file is untouched byte-for-byte.
      expect(report.written).toEqual([]);
      expect(report.conflicts).toEqual([]);
      expect(await Bun.file(join(root, path)).text()).toBe(contents);
    });
  });

  // The whole set is proven before any of it lands — containment AND conflicts. Writing up to the
  // offender left a half-generated resource on disk: `x g` reported the conflict, exited non-zero,
  // and the next run then conflicted on the files the failed run had already written.
  test('a conflict anywhere in the set means nothing in the set is written', async () => {
    await withRoot(async (root) => {
      await Bun.write(join(root, 'apps/web/app/second.ts'), 'export const existing = 1;');
      const report = await writeFiles(
        root,
        [
          { path: 'apps/web/app/first.ts', contents: 'export {};' },
          { path: 'apps/web/app/second.ts', contents: 'export {};' },
          { path: 'apps/web/app/third.ts', contents: 'export {};' },
        ],
        false,
      );
      expect(report.conflicts).toHaveLength(1);
      expect(report.conflicts[0]?.at).toBe('apps/web/app/second.ts');
      expect(report.written).toEqual([]);
      expect(await Bun.file(join(root, 'apps/web/app/first.ts')).exists()).toBe(false);
      expect(await Bun.file(join(root, 'apps/web/app/third.ts')).exists()).toBe(false);
      expect(await Bun.file(join(root, 'apps/web/app/second.ts')).text()).toBe(
        'export const existing = 1;',
      );
    });
  });

  // Same rule across the two write paths: a catalog merge is a write like any other, so a source
  // conflict must hold it back too — otherwise a refused `x g` still grew the app's catalog.
  test('a source conflict holds back the catalog merge in the same set', async () => {
    await withRoot(async (root) => {
      const catalog = 'packages/i18n/catalogs/en.json';
      await Bun.write(join(root, 'apps/web/app/page.tsx'), 'existing');
      const report = await writeFiles(
        root,
        [
          { path: catalog, contents: JSON.stringify({ 'app.new.key': 'New' }), merge: 'json' },
          { path: 'apps/web/app/page.tsx', contents: 'export {};' },
        ],
        false,
      );
      expect(report.conflicts).toHaveLength(1);
      expect(report.written).toEqual([]);
      expect(await Bun.file(join(root, catalog)).exists()).toBe(false);
    });
  });

  test('a catalog that is not a JSON object is a finding, never a clobber and never a throw', async () => {
    await withRoot(async (root) => {
      const path = 'packages/i18n/catalogs/en.json';
      await Bun.write(join(root, path), 'not json at all');
      const report = await writeFiles(
        root,
        [{ path, contents: JSON.stringify({ 'app.invoice.empty': 'x' }), merge: 'json' }],
        false,
      );
      expect(report.written).toEqual([]);
      expect(report.conflicts).toHaveLength(1);
      expect(report.conflicts[0]?.code).toBe('X_GENERATE_CONFLICT');
      expect(report.conflicts[0]?.at).toBe(path);
      // Not clobbered: the malformed bytes on disk are exactly what they were before the run.
      expect(await Bun.file(join(root, path)).text()).toBe('not json at all');
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
  const COMMITTED = '{"buildId":"already-committed"}\n';

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
    bunVersion: REQUIRED_BUN,
  });

  beforeAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
    await Bun.write(join(ROOT, 'app.config.ts'), `export const config = { name: 'gen' };\n`);
    await Bun.write(
      join(ROOT, 'package.json'),
      JSON.stringify({ name: 'generate-fixture', version: '1.0.0' }),
    );
    await Bun.write(join(ROOT, BROKEN), `export { nope } from './does-not-exist';\n`);
    // Committed, because that is the only shape in which this question exists: `x g` refreshes a
    // manifest the repo already has, so "does a partial load overwrite it?" needs one on disk.
    await Bun.write(join(ROOT, MANIFEST_FILENAME), COMMITTED);
    resetAppLoad();
  });

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
    resetAppLoad();
  });

  test('the scaffold lands, the manifest is untouched, and the load failure is the finding', async () => {
    const result = await generateCommand.run(contextFor());
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => finding.at)).toContain(BROKEN);
    expect((result.data as { files?: readonly string[] }).files?.length).toBeGreaterThan(0);
    expect(await Bun.file(join(ROOT, MANIFEST_FILENAME)).text()).toBe(COMMITTED);
    // No `+ x.manifest.json` line either: the human render may not claim a write that never was.
    expect(result.lines?.some((line) => line.includes(MANIFEST_FILENAME))).toBe(false);
  });
});

// `x g` REFRESHES the committed manifest; it does not introduce one. An app that never ran
// `x manifest` has no committed contract to keep current, and a generator that creates one has
// invented a file the repo now has to keep in sync forever — and it announced a write the count
// beside it did not include, so `x g island` said "wrote 2 file(s)" over three printed lines.
describe('unit · x g refreshes a manifest and never invents one', () => {
  const ROOT = join(import.meta.dir, '..', '.generate-manifest-fixture');

  const contextFor = (name: string): CommandContext => ({
    args: {
      command: 'g',
      subcommand: undefined,
      positionals: ['policy', name],
      flags: new Map(),
      json: false,
      help: false,
      passthrough: [],
    },
    cwd: ROOT,
    runner: exec,
    env: {},
    bunVersion: REQUIRED_BUN,
  });

  beforeAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
    await Bun.write(join(ROOT, 'app.config.ts'), `export const config = { name: 'gen' };\n`);
    await Bun.write(
      join(ROOT, 'package.json'),
      JSON.stringify({ name: 'manifest-fixture', version: '1.0.0' }),
    );
    resetAppLoad();
  });

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
    resetAppLoad();
  });

  test('an app with no committed manifest does not get one, and the count matches the lines', async () => {
    const result = await generateCommand.run(contextFor('uninvited'));
    expect(await Bun.file(join(ROOT, MANIFEST_FILENAME)).exists()).toBe(false);
    expect(result.lines?.some((line) => line.includes(MANIFEST_FILENAME))).toBe(false);
    expect(result.summary).toContain(`wrote ${result.lines?.length} file(s)`);
  });

  test('an app that has one gets it refreshed, printed, counted and carried in --json', async () => {
    await Bun.write(join(ROOT, MANIFEST_FILENAME), '{}\n');
    resetAppLoad();
    const result = await generateCommand.run(contextFor('invited'));
    expect(result.lines?.some((line) => line.includes(MANIFEST_FILENAME))).toBe(true);
    // One list behind all three: the printed lines, the counted total and `data.files`.
    expect(result.summary).toContain(`wrote ${result.lines?.length} file(s)`);
    expect((result.data as { files?: readonly string[] }).files).toContain(MANIFEST_FILENAME);
    expect(await Bun.file(join(ROOT, MANIFEST_FILENAME)).text()).not.toBe('{}\n');
  });
});

describe('unit · the command surface an agent reads', () => {
  const ctxFor = (argv: readonly string[]): CommandContext => ({
    args: parseArgs(argv, SPECS),
    cwd: EXAMPLE_APP,
    runner: exec,
    env: {},
    bunVersion: REQUIRED_BUN,
  });

  // `x g route --json` answered X_CLI_UNKNOWN_COMMAND — for a command form that IS known — with
  // `fix: "x g route <name>"`, which pasted into bash is a redirect, not a command.
  test('a missing <name> is a missing POSITIONAL, with a runnable example', async () => {
    const failure = (await generateCommand.run(ctxFor(['g', 'route'])).then(
      () => undefined,
      (error: unknown) => error,
    )) as { code: string; cause: string; fix: string };
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(failure.code).not.toBe('X_CLI_UNKNOWN_COMMAND');
    expect(failure.cause).toContain('positional');
    expect(failure.fix).toBe('x g route posts');
    expect(failure.fix).not.toContain('<');
  });

  test('every generator has a runnable example name, so no fix can carry a placeholder', async () => {
    for (const kind of GENERATORS) {
      const failure = (await generateCommand.run(ctxFor(['g', kind])).then(
        () => undefined,
        (error: unknown) => error,
      )) as { fix: string };
      expect(failure.fix.startsWith(`x g ${kind} `)).toBe(true);
      expect(failure.fix).not.toContain('<');
    }
  });

  // `--at` reached `island` and stopped there: `admin:page` wrote to a hardcoded
  // `apps/admin/src/pages`, so every app whose admin is somewhere else — the demo's is
  // `apps/admin/app/admin` — moved both files by hand after every run. Asserted through the
  // command, not the template: the passthrough is the half a user touches.
  test('--at reaches admin:page, not only island', async () => {
    const filesFor = async (argv: readonly string[]): Promise<readonly string[]> => {
      const result = await generateCommand.run(ctxFor(argv));
      return (result.data as { files: readonly string[] }).files;
    };

    const adminPage = await filesFor([
      'g',
      'admin:page',
      'ops',
      '--at',
      'apps/admin/app/admin',
      '--dry-run',
    ]);
    expect(adminPage).toContain('apps/admin/app/admin/ops.tsx');
    expect(adminPage).toContain('apps/admin/app/admin/ops.test.ts');
    expect(adminPage.some((file) => file.startsWith('apps/admin/src/pages'))).toBe(false);

    // The affordance it is modelled on still behaves the same way.
    const clientEntry = await filesFor([
      'g',
      'island',
      'currency-picker',
      '--at',
      'apps/web/site/pricing',
      '--dry-run',
    ]);
    expect(clientEntry).toContain('apps/web/site/pricing/currency-picker.island.tsx');
  });

  test('no --at keeps the layout x new scaffolds', async () => {
    const result = await generateCommand.run(ctxFor(['g', 'admin:page', 'ops', '--dry-run']));
    expect((result.data as { files: readonly string[] }).files).toContain(
      'apps/admin/src/pages/ops.tsx',
    );
  });

  // `--dry-run` reported "wrote 4 file(s)" beside `data.dryRun: true`, so an agent that logs or
  // branches on `summary` believed the files had landed.
  test('--dry-run says it wrote nothing', async () => {
    const result = await generateCommand.run(ctxFor(['g', 'route', 'blog', '--dry-run']));
    expect(result.ok).toBe(true);
    expect((result.data as { dryRun?: boolean }).dryRun).toBe(true);
    expect(result.summary).not.toContain('wrote');
    expect(result.summary).toContain('would write');
    expect(result.summary).toContain('nothing written');
  });
});

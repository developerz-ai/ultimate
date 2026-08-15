// What `x g` DOES: the writes it makes, the containment it proves before making them, and the
// argv it refuses. The bytes each generator emits are `generate-output.test.ts` and the catalogs
// are `generate-catalogs.test.ts` — this file owns the filesystem and the command surface.

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
import { GENERATORS, generateCommand, writeFiles } from './cmd-generate';
import type { CommandContext } from './command';
import { exec } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';

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

describe('unit · the command surface an agent reads', () => {
  const ctxFor = (argv: readonly string[]): CommandContext => ({
    args: parseArgs(argv, SPECS),
    cwd: EXAMPLE_APP,
    runner: exec,
    env: {},
    bunVersion: '1.3.0',
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

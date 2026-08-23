// Every file `x g` emits, put through the repo's OWN biome — the same rules the `lint` step of
// `x verify` runs. `x g` hand-wraps its output rather than formatting it, so a generated file is
// formatter-clean by construction and nothing proved the construction was right (#127).
//
// A build error rather than a runtime format, and the numbers are why: `biome check --write
// --stdin-file-path` costs ~239ms per file, and one `x g resource` emits 24 ts/tsx files — 5.7s
// added to a command that is currently instant. Batching to one subprocess is fast enough, but it
// puts a formatter INSIDE `x g`, where a version skew or an unhappy app config turns "write eight
// files" into a failure the author cannot act on. The defect is introduced HERE, when a template
// is edited; catching it here costs one subprocess, once, and nothing at all on a user's machine.

import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GENERATORS, generate } from './cmd-generate';
import { planNewApp } from './cmd-new';
import { exec } from './exec';
import type { GeneratedFile } from './templates';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const BIOME_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'biome');

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/**
 * The repo's own `biome.json`, minus `vcs`. The RULES are the thing under test and they are
 * copied byte for byte; `vcs.useIgnoreFile` is the one key that needs a git checkout to resolve,
 * and biome refuses to start without one — so a sandbox that kept it would fail on the harness
 * rather than on the output. There is nothing in a fresh temp directory to ignore.
 */
interface Sandbox {
  /** Holds the emitted files and NOTHING else. */
  readonly tree: string;
  /** Holds the config, OUTSIDE the tree: biome checks its own `biome.json`, and a copy written
   * beside the output would be the one file this test reports on. */
  readonly configDir: string;
}

async function sandbox(files: readonly GeneratedFile[]): Promise<Sandbox> {
  const base = await mkdtemp(join(tmpdir(), 'x-generate-format-'));
  roots.push(base);
  const tree = join(base, 'tree');
  const configDir = join(base, 'config');
  const config = (await Bun.file(join(REPO_ROOT, 'biome.json')).json()) as Record<string, unknown>;
  delete config['vcs'];
  await Bun.write(join(configDir, 'biome.json'), JSON.stringify(config, null, 2));
  for (const file of files) {
    if (typeof file.contents !== 'string') continue;
    await Bun.write(join(tree, file.path), file.contents);
  }
  return { tree, configDir };
}

interface BiomeRun {
  /** Empty when clean. The whole report otherwise, so a failure names the file and the rule. */
  readonly problems: string;
  /** How many files biome actually READ. `0` is the vacuous pass this number exists to refuse. */
  readonly checked: number;
}

/** Biome over the whole emitted tree in ONE subprocess — 48 files in ~70ms, against 239ms each. */
async function runBiome(files: readonly GeneratedFile[]): Promise<BiomeRun> {
  const { tree, configDir } = await sandbox(files);
  // The repo's OWN biome binary, by path. `bunx biome` resolves against the CWD, which here is a
  // temp directory with no `node_modules` — so it downloaded a fresh copy and answered with the
  // installer's output instead of the checker's. This test is about the version `x verify`'s
  // `lint` step runs; naming the binary is the only way to be sure it is that one.
  const result = await exec([BIOME_BIN, 'check', '--config-path', configDir, '.'], { cwd: tree });
  const output = `${result.stdout}\n${result.stderr}`;
  return {
    problems: result.ok ? '' : output,
    // Read back off biome's own summary line rather than assumed from the write loop: a sandbox
    // biome declined to walk reports `ok` over nothing, and this test would agree with it.
    checked: Number(/Checked (\d+) files?/.exec(output)?.[1] ?? '0'),
  };
}

/**
 * Unique `.ts`/`.tsx` paths in a file set — the floor `checked` has to clear.
 *
 * UNIQUE, because several generators contribute to one path (every kind that writes an i18n key
 * targets the same catalog), so the emitted list holds duplicates and the tree holds one file.
 * TypeScript only, because this is a vacuity guard and not an audit of biome's file-type set:
 * a run that walked fewer files than there are TypeScript files skipped one.
 */
const typescriptPaths = (files: readonly GeneratedFile[]): number =>
  new Set(
    files
      .filter((file) => typeof file.contents === 'string' && /\.tsx?$/.test(file.path))
      .map((file) => file.path),
  ).size;

/**
 * An app scope that sorts AFTER `@ultimat3`, which is the half this file could not see.
 *
 * Both fixtures below were `ledger-demo` and `invoice`, and both sort BEFORE it — so did CI's two
 * scaffold fixtures, `demoapp` and `bareapp`. Every template emitted the app's own import first,
 * which is right for those names and wrong for these: `x new zebra` scaffolded four files biome
 * refuses (`assist/source/organizeImports`) and the app's first `x verify` was red on `lint`.
 * A generated file's import ORDER depends on the app's name, so a fixture is only a fixture with
 * one on each side of `@ultimat3` (`templates/imports.ts`).
 */
const AFTER_ULTIMATE = 'zebra-demo';

test('every file x g emits is already clean under the repo own biome', async () => {
  const emitted = GENERATORS.flatMap((kind) =>
    generate({ kind, name: 'invoice', feature: 'invoice' }),
  );
  // The count is asserted too: an empty list would make the check below vacuously green, which is
  // exactly the shape of "clean by luck" this test exists to replace.
  expect(emitted.length).toBeGreaterThan(50);

  const run = await runBiome(emitted);
  expect(run.problems).toBe('');
  expect(run.checked).toBeGreaterThanOrEqual(typescriptPaths(emitted));
}, 60_000);

test('every file x new writes is clean too — the scaffold is generated code as well', async () => {
  const scaffold = planNewApp({ name: 'ledger-demo', example: true });

  expect(scaffold.length).toBeGreaterThan(50);

  const run = await runBiome(scaffold);
  expect(run.problems).toBe('');
  expect(run.checked).toBeGreaterThanOrEqual(typescriptPaths(scaffold));
}, 60_000);

test('and both are clean for an app whose scope sorts AFTER @ultimat3', async () => {
  // One assertion per surface the order can go wrong on: the scaffold writes the app's `@x/i18n`
  // beside `@ultimat3/render`, and a generator writes whatever `resolveCatalogModule` read off the
  // app's own manifest beside the same package.
  const scaffold = planNewApp({ name: AFTER_ULTIMATE, example: true });
  const generated = GENERATORS.flatMap((kind) =>
    generate({
      kind,
      name: 'invoice',
      feature: 'invoice',
      catalogModule: `@${AFTER_ULTIMATE}/i18n`,
    }),
  );

  expect(scaffold.length).toBeGreaterThan(50);
  expect(generated.length).toBeGreaterThan(50);

  const scaffoldRun = await runBiome(scaffold);
  expect(scaffoldRun.problems).toBe('');
  expect(scaffoldRun.checked).toBeGreaterThanOrEqual(typescriptPaths(scaffold));

  const generatedRun = await runBiome(generated);
  expect(generatedRun.problems).toBe('');
  expect(generatedRun.checked).toBeGreaterThanOrEqual(typescriptPaths(generated));
}, 60_000);

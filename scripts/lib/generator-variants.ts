// Measure what each modelled generator PRINTS — `x new` from its planner, `x g resource` and
// `x g sign-in` by running each on a scratch scaffold — so `generator-counts.ts` checks the docs
// against derived numbers, never restated ones.

// why: a scratch scaffold for `x g` to run in; Bun has no temporary-directory or path API.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch, NEW_SHAPES, planNewApp, writeNewApp } from '@ultimat3/cli';
import { ScriptError } from './script-error';

/** One spelling of one generator, and the file count it really emits. */
export interface GeneratorVariant {
  /** The flags that select it, as a reader writes them. Empty is the default spelling. */
  readonly flags: readonly string[];
  readonly files: number;
  /** Where the count holds, as a finding names it: `the default scaffold, after setup`. */
  readonly shape?: string;
}

export interface GeneratorFacts {
  /** How a finding names it: `x new`, `x g resource`. */
  readonly id: string;
  readonly variants: readonly GeneratorVariant[];
}

/**
 * The two files `bun run setup` leaves that `x g` reads: their presence is what makes a real run
 * re-project them, and count them. The rest of setup (install, migrate, seed) changes no count.
 */
export const SETUP_ARTIFACTS: readonly string[] = ['x.manifest.json', 'openapi.json'];

const DryRun = (value: unknown): { files: number; refreshes: number } | undefined => {
  if (typeof value !== 'object' || value === null || !('data' in value)) return undefined;
  const data: unknown = value.data;
  if (typeof data !== 'object' || data === null || !('files' in data)) return undefined;
  const files: unknown = data.files;
  const refreshes: unknown = 'refreshes' in data ? data.refreshes : [];
  if (!Array.isArray(files) || !Array.isArray(refreshes)) return undefined;
  return { files: files.length, refreshes: refreshes.length };
};

/**
 * What `x g resource` PRINTS, measured by running it: `x g resource widget [--admin] --dry-run
 * --json` in each scaffold shape, holding setup's two artifacts. Tutorial 1 makes the default
 * app and Tutorial 2 generates into it; a `--no-example` app prints more, because the example
 * slice already made two `package.json` edits a bare app still owes. Two numbers per spelling and
 * shape: `data.files` is what a dry run and a real run before setup print, and a real run after
 * setup adds `data.refreshes`, the projections it rewrites.
 *
 * `generate()`'s array was measured here until 2026-11-03, and it is not what the command prints:
 * the command also edits the role map, the API index, the db handle and two `package.json` files,
 * so every page quoting the planner's 33 named a number no run of `x g` has ever shown.
 */
const SHAPES = [
  { example: true, shape: 'the default scaffold' },
  { example: false, shape: 'a --no-example scaffold' },
] as const;

async function resourceVariants(): Promise<readonly GeneratorVariant[]> {
  const variants: GeneratorVariant[] = [];
  for (const one of SHAPES) variants.push(...(await shapeVariants(one.example, one.shape)));
  return variants;
}

async function shapeVariants(
  example: boolean,
  shape: string,
): Promise<readonly GeneratorVariant[]> {
  const dir = await mkdtemp(join(tmpdir(), 'generator-counts-'));
  try {
    await writeNewApp(dir, { name: 'probe', example });
    for (const file of SETUP_ARTIFACTS) await Bun.write(join(dir, file), '{}\n');
    const variants: GeneratorVariant[] = [];
    for (const flags of [[], ['--admin']]) {
      const out: string[] = [];
      const argv = ['g', 'resource', 'widget', ...flags, '--dry-run', '--json'];
      const code = await dispatch({
        argv,
        cwd: dir,
        env: {},
        bunVersion: Bun.version,
        write: (line) => out.push(line),
      });
      const run = code === 0 ? DryRun(JSON.parse(out.join('\n'))) : undefined;
      if (run === undefined) {
        throw new ScriptError({
          code: 'X_DOC_FILE_COUNT_UNSCANNED',
          cause: `x ${argv.join(' ')} in ${shape} exited ${String(code)} without a file list`,
          fix: `bun run scripts/generator-counts.ts --json   # then run x ${argv.join(' ')} in a fresh \`x new probe\` app (and one with --no-example) and fix what it reports`,
        });
      }
      variants.push(
        { flags, files: run.files, shape: `${shape}, before setup` },
        { flags, files: run.files + run.refreshes, shape: `${shape}, after setup` },
      );
    }
    return variants;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * What `x g sign-in` PRINTS, both shapes, in the default scaffold before and after setup — measured
 * by its own dry run, exactly as `x g resource` is. One run per shape, each in a fresh scaffold:
 * an app has one sign-in, so a second run into the same app is a conflict and counts nothing.
 */
async function signInVariants(): Promise<readonly GeneratorVariant[]> {
  const variants: GeneratorVariant[] = [];
  for (const flags of [['--password'], ['--oidc', 'corp-sso']]) {
    const dir = await mkdtemp(join(tmpdir(), 'generator-counts-'));
    try {
      await writeNewApp(dir, { name: 'probe', example: true });
      for (const file of SETUP_ARTIFACTS) await Bun.write(join(dir, file), '{}\n');
      const out: string[] = [];
      const argv = ['g', 'sign-in', ...flags, '--dry-run', '--json'];
      const code = await dispatch({
        argv,
        cwd: dir,
        env: {},
        bunVersion: Bun.version,
        write: (line) => out.push(line),
      });
      const run = code === 0 ? DryRun(JSON.parse(out.join('\n'))) : undefined;
      if (run === undefined) {
        throw new ScriptError({
          code: 'X_DOC_FILE_COUNT_UNSCANNED',
          cause: `x ${argv.join(' ')} in the default scaffold exited ${String(code)} without a file list`,
          fix: `bun run scripts/generator-counts.ts --json   # then run x ${argv.join(' ')} in a fresh \`x new probe\` app and fix what it reports`,
        });
      }
      // The flag that names the shape is what a doc line writes: `--oidc`, never its value.
      const shape = flags.slice(0, 1);
      variants.push(
        { flags: shape, files: run.files, shape: 'the default scaffold, before setup' },
        {
          flags: shape,
          files: run.files + run.refreshes,
          shape: 'the default scaffold, after setup',
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return variants;
}

/**
 * `x g action` is deliberately absent, and the reason is a property of the generator rather than an
 * omission. `writeFiles` SKIPS a slice module that already exists (`cmd-generate.ts`), so an
 * action's count depends on how much of the slice is already there — `wiki/CLI-Reference.md:233`
 * says "exactly its own 3 files" into a finished slice and `wiki/Tutorial-02` says 8 into a bare
 * one, both correct English about different states.
 *
 * `x new` has no such dimension, and its planner IS its count: `cmd-new.ts` writes every planned
 * file and prints that list. `x g resource` creates its own slice, so one scaffold per shape measures it.
 */
export async function generatorFacts(): Promise<readonly GeneratorFacts[]> {
  return [
    {
      id: 'x new',
      variants: [
        { flags: [], files: planNewApp({ name: 'probe', example: true }).length },
        { flags: ['--no-example'], files: planNewApp({ name: 'probe', example: false }).length },
        // One per shape: a prose count "with --shape" holds when it is any shape's own count.
        ...NEW_SHAPES.map((shape) => ({
          flags: ['--shape'],
          files: planNewApp({ name: 'probe', example: true, shape }).length,
          shape: `--shape ${shape}`,
        })),
      ],
    },
    { id: 'x g resource', variants: await resourceVariants() },
    { id: 'x g sign-in', variants: await signInVariants() },
  ];
}

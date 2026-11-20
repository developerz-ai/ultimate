#!/usr/bin/env bun
// The release rehearsal's two rules: what `release.ts --rehearse` leaves out of a real bump, and
// which pull requests rehearse at all. A test that bakes in the current version passes every
// feature PR and reds only the release PR (31.28.0, #1153: three CI rounds); ci.yml's
// `release-rehearsal` job stamps the next minor in its own checkout and runs those suites first.
//
//   bun run scripts/release-rehearse.ts <changed-paths-file> [--json]   is this PR due one?
//   bun run scripts/release-rehearse.ts --suites [--json]                which test files it runs

import { flagBool, parseScriptArgs } from './lib/args';
import { report } from './lib/log';
import { importsStampReader, type SourceFile, stampReaders } from './lib/stamp-readers';

/**
 * The changelog side of a bump, dropped under `--rehearse`: a pull request's `[Unreleased]` may
 * hold nothing yet, and promoting it is the release PR's own act. Everything stamped from the
 * manifests (manifests, chart, `framework.manifest.json`, `bun.lock`, the footer, the API lock)
 * is still written — that is the version a test can bake in.
 */
export const unlessRehearsed = <T>(rehearse: boolean, changelogSide: readonly T[]): readonly T[] =>
  rehearse ? [] : changelogSide;

/** What reads the stamped version: the scripts, `x new`'s templates, the codemods, `x upgrade`. */
export const REHEARSAL_PATHS: readonly RegExp[] = [
  /^scripts\//,
  /^packages\/cli\/src\/(templates\/|codemods\/|upgrade|cmd-upgrade)/,
  /(^|\/)package\.json$/,
];

/**
 * True when any changed (repository-relative) path is one a version stamp can reach: a
 * `REHEARSAL_PATHS` match, or one of `reached` — the stamp readers and the suites that import them.
 */
export const rehearsalDue = (paths: readonly string[], reached: readonly string[] = []): boolean =>
  paths.some((path) => {
    const trimmed = path.trim();
    return (
      REHEARSAL_PATHS.some((pattern) => pattern.test(trimmed)) ||
      reached.some((one) => one === trimmed || one === `./${trimmed}`)
    );
  });

/**
 * Whatever reads the stamped version on the CLI's side: every test file, the stamp is theirs to
 * print. Expanded to FILES — `bun test ./packages/cli/src/upgrade` names neither a file nor a
 * directory, so bun ran none of the 21 `upgrade*` / `cmd-upgrade*` tests and the job was green.
 */
const CLI_STAMP_TESTS = /^packages\/cli\/src\/(templates\/|codemods\/|upgrade|cmd-upgrade)/;

/**
 * A test that can bake in a version says one: the word, or a semver literal (`'31.28.0'` was the
 * whole of the break). The rest of `scripts/` cannot see the bump, and running all of it doubled
 * the job (213 s against 100 s, measured 2026-11-15 on one loaded machine).
 */
const VERSION_SENSITIVE = /version|\b\d+\.\d+\.\d+\b/i;

/**
 * The CLI's stamp-reading test files — under those paths, or importing a module that calls
 * `cliVersion()` / `loadVersion()` (`lib/stamp-readers.ts`) — then every version-sensitive
 * `scripts/` one; `./`, sorted.
 */
export const rehearsalSuites = (
  scriptTests: readonly SourceFile[],
  cliTests: readonly SourceFile[],
  readers: readonly string[] = [],
): readonly string[] => {
  const reading = new Set(readers);
  return [
    ...cliTests
      .filter((file) => CLI_STAMP_TESTS.test(file.path) || importsStampReader(file, reading))
      .map((file) => `./${file.path}`)
      .sort(),
    ...scriptTests
      .filter((file) => VERSION_SENSITIVE.test(file.text))
      .map((file) => `./${file.path}`)
      .sort(),
  ];
};

async function testPaths(pattern: string): Promise<readonly string[]> {
  const paths: string[] = [];
  for await (const path of new Bun.Glob(pattern).scan({ cwd: '.' })) {
    paths.push(path.replaceAll('\\', '/'));
  }
  return paths;
}

const read = (paths: readonly string[]): Promise<readonly SourceFile[]> =>
  Promise.all(paths.map(async (path) => ({ path, text: await Bun.file(path).text() })));

/** The CLI's stamp readers over this checkout, read from the repository root. */
export const stampReadersHere = async (): Promise<readonly string[]> =>
  stampReaders(await read(await testPaths('packages/cli/src/**/*.{ts,tsx}')));

/** `rehearsalSuites` over this checkout, read from the repository root. */
export async function rehearsalSuitesHere(readers?: readonly string[]): Promise<readonly string[]> {
  return rehearsalSuites(
    await read(await testPaths('scripts/**/*.test.ts')),
    await read(await testPaths('packages/cli/src/**/*.test.ts')),
    readers ?? (await stampReadersHere()),
  );
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  if (flagBool(args, 'suites')) {
    const suites = await rehearsalSuitesHere();
    report(
      {
        ok: true,
        script: 'release-rehearse',
        summary: `${suites.length} suite path(s) read the stamped version`,
        findings: [],
        lines: [...suites],
        data: { suites },
      },
      args.json,
    );
  }
  const list = args.positionals[0];
  // No list is a full run, the rule ci.yml's other path filters keep: fail open, never skip blind.
  const paths =
    list === undefined || !(await Bun.file(list).exists())
      ? undefined
      : (await Bun.file(list).text()).split('\n').filter((line) => line.trim().length > 0);
  const readers = paths === undefined ? [] : await stampReadersHere();
  const reached = paths === undefined ? [] : [...readers, ...(await rehearsalSuitesHere(readers))];
  const due = paths === undefined || rehearsalDue(paths, reached);
  report(
    {
      ok: true,
      script: 'release-rehearse',
      summary: due
        ? `rehearse: ${paths === undefined ? 'no changed-path list, a full run' : 'a changed path reads the stamped version'}`
        : `no rehearsal: none of ${paths?.length ?? 0} changed path(s) reads the stamped version`,
      findings: [],
      data: { due },
    },
    args.json,
  );
}

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

/** True when any changed (repository-relative) path is one a version stamp can reach. */
export const rehearsalDue = (paths: readonly string[]): boolean =>
  paths.some((path) => REHEARSAL_PATHS.some((pattern) => pattern.test(path.trim())));

/** Whatever reads the stamped version on the CLI's side: every file, the stamp is theirs to print. */
export const REHEARSAL_CLI_SUITES: readonly string[] = [
  './packages/cli/src/templates',
  './packages/cli/src/codemods',
  './packages/cli/src/upgrade',
  './packages/cli/src/cmd-upgrade',
];

/**
 * A test that can bake in a version says one: the word, or a semver literal (`'31.28.0'` was the
 * whole of the break). The rest of `scripts/` cannot see the bump, and running all of it doubled
 * the job (213 s against 100 s, measured 2026-11-15 on one loaded machine).
 */
const VERSION_SENSITIVE = /version|\b\d+\.\d+\.\d+\b/i;

/** The CLI suites, then every `scripts/` test file whose text is version-sensitive, sorted. */
export const rehearsalSuites = (
  scriptTests: readonly { readonly path: string; readonly text: string }[],
): readonly string[] => [
  ...REHEARSAL_CLI_SUITES,
  ...scriptTests
    .filter((file) => VERSION_SENSITIVE.test(file.text))
    .map((file) => `./${file.path}`)
    .sort(),
];

async function scriptTestFiles(): Promise<readonly { path: string; text: string }[]> {
  const files: { path: string; text: string }[] = [];
  for await (const path of new Bun.Glob('scripts/**/*.test.ts').scan({ cwd: '.' })) {
    const posix = path.replaceAll('\\', '/');
    files.push({ path: posix, text: await Bun.file(posix).text() });
  }
  return files;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  if (flagBool(args, 'suites')) {
    const suites = rehearsalSuites(await scriptTestFiles());
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
  const due = paths === undefined || rehearsalDue(paths);
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

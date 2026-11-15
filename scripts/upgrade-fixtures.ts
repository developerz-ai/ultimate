#!/usr/bin/env bun
// The proof that `x upgrade` needs no hands (plan 101, slice 08): for each past release, its own
// `x new` output, set up and committed, hopped to HEAD by this checkout's `x upgrade` — HEAD packed
// and served as if published — and judged by the gate that hop runs. Every file the hop left to a
// human is a finding.
//
//   bun run scripts/upgrade-fixtures.ts [--versions 31.4.0,31.15.0] [--root <checkout>] [--before]
//     [--verify] [--keep] [--json]

// why: Bun has no recursive remove; a fixture tree is removed once judged unless --keep.
import { rmSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { dirname, join } from 'node:path';
import { flagBool, flagList, flagString, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';
import { strangerEnvAt } from './lib/stranger-env';
import type { FixtureRun } from './upgrade-fixtures-findings';
import { fixtureFindings, fixtureLines } from './upgrade-fixtures-findings';
import { nextMinor } from './upgrade-fixtures-packument';
import { packHead, purgeLoopbackEntries } from './upgrade-fixtures-registry';
import { runFixture, scaffoldHead } from './upgrade-fixtures-run';

const SCRIPT = 'upgrade-fixtures';

/**
 * The releases the plan names: 31.4 (vendored guards), 31.15, 31.20 (the hand-ported scaffold
 * files) and 31.22 — each the first patch of its minor, the scaffold its adopters started from.
 */
export const FIXTURE_VERSIONS: readonly string[] = ['31.4.0', '31.15.0', '31.20.0', '31.22.0'];

const FLAGS = ['versions', 'root', 'before', 'verify', 'keep'];

const badFlag = (cause: string): ScriptError =>
  new ScriptError({
    code: 'X_CLI_BAD_FLAG',
    cause,
    fix: `bun run scripts/upgrade-fixtures.ts --versions ${FIXTURE_VERSIONS.join(',')} --json`,
  });

/** `--versions`, each a plain release; the plan's four when absent. */
export const readVersions = (given: readonly string[]): readonly string[] => {
  if (given.length === 0) return FIXTURE_VERSIONS;
  const bad = given.filter((version) => !/^\d+\.\d+\.\d+$/.test(version));
  if (bad.length > 0)
    throw badFlag(`--versions takes major.minor.patch releases; got ${bad.join(', ')}`);
  return given;
};

/** The version HEAD's packages carry, read off its CLI manifest; undefined when it names none. */
export const headVersionOf = (manifest: unknown): string | undefined =>
  typeof manifest === 'object' &&
  manifest !== null &&
  'version' in manifest &&
  typeof manifest.version === 'string' &&
  /^\d+\.\d+\.\d+$/.test(manifest.version)
    ? manifest.version
    : undefined;

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2), {
    names: FLAGS,
    refuse: (unknown) =>
      badFlag(`unknown flag(s): ${unknown.map((name) => `--${name}`).join(', ')}`),
  });
  // `--root`: another checkout to pack and hop with — `git archive <rev> | tar -x` plus
  // `bun install` baselines a committed revision while this tree is mid-edit.
  const root = flagString(args, 'root') ?? repoRoot();
  const versions = readVersions(flagList(args, 'versions'));
  const keep = flagBool(args, 'keep');
  const cacheDir = join(repoRoot(), 'node_modules', '.cache', 'upgrade-fixtures');
  const cliManifest = join(root, 'packages', 'cli', 'package.json');
  const headVersion = headVersionOf(
    (await Bun.file(cliManifest).exists()) ? await Bun.file(cliManifest).json() : undefined,
  );
  if (headVersion === undefined) {
    report(
      {
        ok: false,
        script: SCRIPT,
        summary: `${root} holds no packages/cli/package.json with a release version to hop to`,
        findings: [
          {
            code: 'X_UPGRADE_FIXTURE_UNBUILT',
            cause: `${cliManifest} is missing or names no major.minor.patch version`,
            fix: 'bun run scripts/upgrade-fixtures.ts --json   # from this checkout, or --root <a checkout>',
            at: cliManifest,
          },
        ],
      },
      args.json,
    );
  }
  // HEAD as the release that will ship it: codemods are registered `since` that version, and a hop
  // to the stamped one would skip them all. `headVersionOf` admitted a release, so this is one too.
  const target = nextMinor(headVersion) ?? headVersion;
  // The fixtures run code this checkout did not write: an allowlisted env, a throwaway home.
  const env = strangerEnvAt(root);
  const { packed, findings: packFindings } = await packHead(root, join(cacheDir, 'pack'), target);
  const runs: FixtureRun[] = [];
  const headScaffold = packFindings.length === 0 ? await scaffoldHead(root, env) : undefined;
  if (packFindings.length === 0) {
    for (const version of versions) {
      const one = await runFixture({
        root,
        version,
        head: target,
        packed,
        cacheDir,
        env,
        before: flagBool(args, 'before'),
        verify: flagBool(args, 'verify'),
        headScaffold,
      });
      runs.push(one);
      if (!keep) rmSync(dirname(one.dir), { recursive: true, force: true });
    }
  }
  const installCache = env['BUN_INSTALL_CACHE_DIR'];
  if (installCache !== undefined) purgeLoopbackEntries(installCache);
  const findings: Finding[] = [...packFindings, ...runs.flatMap(fixtureFindings)];
  const green = runs.filter((one) => fixtureFindings(one).length === 0).length;
  report(
    {
      ok: findings.length === 0 && runs.length === versions.length,
      script: SCRIPT,
      summary: `${String(green)} of ${String(versions.length)} fixture(s) reach ${target} (HEAD, stamped ${headVersion}) with no hand edit`,
      findings,
      lines: runs.flatMap(fixtureLines),
      data: { head: target, stamped: headVersion, kept: keep, fixtures: runs },
    },
    args.json,
  );
}

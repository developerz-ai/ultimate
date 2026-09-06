// The three writes a bump owes beyond the package manifests, driven over a fixture tree: the
// negative case for each has to be a directory this test builds, because the only other way to see
// one fail is to cut a release. v19.3.0 is the run that shipped with all three missing — `--check`
// answered ok on its tree and `verify` refused it 157 seconds later.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove of its own.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and Bun.write take one already joined.
import { join } from 'node:path';
import type { Finding } from './log';
import {
  performReleaseWrites,
  plannedWriteLine,
  RELEASE_WRITES,
  releaseCheckFindings,
  releaseWriteFindings,
} from './release-writes';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';
import { rewriteStamps } from './version-stamp-scan';

// Two of these read the real tree, so they run on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const ROOT = repoRoot();

const footerAt = (version: string): string =>
  `**Ultimate** — v${version} \`As of 2026-09\`. MIT licensed.\n`;

/** `bun.lock`'s own shape, down to the trailing commas: the block reader is a regex over it. */
const lockAt = (version: string): string => `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "fixture",
    },
    "packages/core": {
      "name": "@ultimat3/core",
      "version": "${version}",
    },
    "packages/schema": {
      "name": "@ultimat3/schema",
      "version": "${version}",
      "dependencies": {
        "@ultimat3/core": "${version}",
      },
    },
  },
}
`;

interface Fixture {
  /** What every package.json declares. */
  readonly declared: string;
  /** What `bun.lock` records. */
  readonly locked: string;
  /** The footer's text, or `undefined` for a wiki with no footer at all. */
  readonly footer: string | undefined;
  /** `false` builds a tree with no lockfile, which is the write that cannot be performed. */
  readonly lockfile?: boolean;
}

/**
 * A repo-shaped directory: a root manifest naming its workspaces, two real package directories
 * (`core` and `schema` — the tier table keys on the directory name), a lockfile and a wiki footer.
 * No `framework.manifest.json`, so every fixture starts owing the first of the three writes.
 */
async function fixture(input: Fixture): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'release-writes-'));
  await Bun.write(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'fixture', private: true, workspaces: ['packages/*'] }, null, 2)}\n`,
  );
  await Bun.write(
    join(dir, 'packages/core/package.json'),
    `{\n  "name": "@ultimat3/core",\n  "version": "${input.declared}"\n}\n`,
  );
  await Bun.write(
    join(dir, 'packages/schema/package.json'),
    `{\n  "name": "@ultimat3/schema",\n  "version": "${input.declared}",\n  "dependencies": {\n    "@ultimat3/core": "${input.declared}"\n  }\n}\n`,
  );
  if (input.lockfile !== false) await Bun.write(join(dir, 'bun.lock'), lockAt(input.locked));
  if (input.footer !== undefined) await Bun.write(join(dir, 'wiki/_Footer.md'), input.footer);
  return dir;
}

/**
 * The real `VERSION_STAMP_PINS` table travels with the reader, and it names pages in THIS repo. A
 * fixture tree holds none of them, so every pin reads as `X_VERSION_STAMP_PIN_STALE` there — a
 * finding about this repo's own table, asserted on the real tree at the bottom of this file and
 * noise no fixture can avoid.
 */
const onFixture = (findings: readonly Finding[]): readonly Finding[] =>
  findings.filter((finding) => finding.code !== 'X_VERSION_STAMP_PIN_STALE');

const codesOf = async (dir: string): Promise<readonly string[]> =>
  [...new Set(onFixture(await releaseWriteFindings(dir)).map((finding) => finding.code))].sort();

describe('RELEASE_WRITES', () => {
  test('is the three files, in the order a bump performs them', () => {
    expect(RELEASE_WRITES.map((spec) => spec.kind)).toEqual(['manifest', 'lockfile', 'stamps']);
    for (const spec of RELEASE_WRITES) expect(plannedWriteLine(spec)).toContain(spec.command);
  });

  // A `fix:` naming a command that does not exist is worse than no fix at all: the operator runs
  // it, gets `Script not found`, and reads the whole finding as noise.
  test('every command a refusal names is runnable from the repo root', async () => {
    const manifest = (await Bun.file(join(ROOT, 'package.json')).json()) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    const scripts = manifest.scripts ?? {};
    for (const spec of RELEASE_WRITES) {
      // `bun run <target> [flags]` — a package.json script name, or a path to a script.
      const target = spec.command.split(' ')[2] ?? '';
      const runnable = target.endsWith('.ts')
        ? await Bun.file(join(ROOT, target)).exists()
        : Object.hasOwn(scripts, target);
      expect(runnable).toBe(true);
    }
  });
});

describe('rewriteStamps', () => {
  test('moves the version and leaves the `As of` date it was anchored on', () => {
    const { text, moved } = rewriteStamps(
      { path: 'wiki/_Footer.md', text: footerAt('19.2.0') },
      '19.3.0',
    );
    expect(text).toBe(footerAt('19.3.0'));
    expect(moved).toBe(1);
    // The date is the half a release does not know: it says when the sentence was true.
    expect(text).toContain('`As of 2026-09`');
  });

  test('a version inside a fenced block is an example, never a stamp', () => {
    const page = ['```sh', 'git tag -a v1.0.0 `As of 2026-01`', '```'].join('\n');
    const { text, moved } = rewriteStamps({ path: 'wiki/_Footer.md', text: page }, '19.3.0');
    expect(moved).toBe(0);
    expect(text).toBe(page);
  });

  test('a page already stamping the release moves nothing', () => {
    expect(
      rewriteStamps({ path: 'wiki/_Footer.md', text: footerAt('19.3.0') }, '19.3.0').moved,
    ).toBe(0);
  });
});

describe('releaseWriteFindings', () => {
  test('a generated manifest that no longer describes the tree is a refusal', async () => {
    const dir = await fixture({ declared: '2.0.0', locked: '2.0.0', footer: footerAt('2.0.0') });
    expect(await codesOf(dir)).toEqual(['X_MANIFEST_DRIFT']);
    await rm(dir, { recursive: true, force: true });
  });

  test('a lockfile recording the previous version is a refusal, own version and range alike', async () => {
    const dir = await fixture({ declared: '2.0.0', locked: '1.0.0', footer: footerAt('2.0.0') });
    const findings = await releaseWriteFindings(dir);
    const stale = findings.filter((finding) => finding.code === 'X_LOCKFILE_STALE');
    // Both halves: the workspace's own recorded version, and the @ultimat3/* range beside it.
    // `bun install --frozen-lockfile` accepts either, which is why neither is checked by install.
    //
    // Named on `packages/core`, which declares NO @ultimat3/* dependency: a reader that looked at
    // ranges alone could never mention it, so this assertion cannot be passed by the range half.
    const own = 'bun.lock records packages/core at version 1.0.0';
    expect(stale.some((finding) => finding.cause.includes(own))).toBe(true);
    expect(stale.some((finding) => finding.cause.includes('@ultimat3/core@1.0.0'))).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test('a footer stamping the previous version is a refusal', async () => {
    const dir = await fixture({ declared: '2.0.0', locked: '2.0.0', footer: footerAt('1.0.0') });
    const stamp = (await releaseWriteFindings(dir)).find(
      (finding) => finding.code === 'X_VERSION_STAMP_STALE',
    );
    expect(stamp?.cause).toContain('stamps v1.0.0');
    expect(stamp?.fix).toContain('bun run scripts/version-stamps.ts');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('performReleaseWrites', () => {
  // The whole point, in one assertion: a tree that owed all three writes owes none afterwards, so
  // deleting any one of the three passes reds here.
  test('a tree that owed all three owes none, and then answers --check clean', async () => {
    const dir = await fixture({ declared: '2.0.0', locked: '1.0.0', footer: footerAt('1.0.0') });
    expect(await codesOf(dir)).not.toEqual([]);
    const { writes, findings } = await performReleaseWrites(dir, '2.0.0');
    expect(findings).toEqual([]);
    expect(writes.map((write) => write.kind).sort()).toEqual(['lockfile', 'manifest', 'stamps']);
    expect(writes.every((write) => write.facts > 0)).toBe(true);
    expect(onFixture(await releaseWriteFindings(dir))).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  test('re-running it is a no-op that still reports each file', async () => {
    const dir = await fixture({ declared: '2.0.0', locked: '1.0.0', footer: footerAt('1.0.0') });
    await performReleaseWrites(dir, '2.0.0');
    const { writes } = await performReleaseWrites(dir, '2.0.0');
    expect(writes.every((write) => write.facts === 0)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test('a missing bun.lock is refused with a command that can create one', async () => {
    const dir = await fixture({
      declared: '2.0.0',
      locked: '2.0.0',
      footer: footerAt('2.0.0'),
      lockfile: false,
    });
    const { writes, findings } = await performReleaseWrites(dir, '2.0.0');
    const refusal = findings.find((finding) => finding.code === 'X_LOCKFILE_STALE');
    expect(refusal?.fix).toBe('bun install && bun run lockfile:fix');
    // The other two still ran: a release that stops on the first refusal makes the operator
    // discover the next one on the next attempt.
    expect(writes.map((write) => write.kind).sort()).toEqual(['manifest', 'stamps']);
    await rm(dir, { recursive: true, force: true });
  });

  test('a wiki with no footer is refused rather than silently unstamped', async () => {
    const dir = await fixture({ declared: '2.0.0', locked: '2.0.0', footer: undefined });
    const { findings } = await performReleaseWrites(dir, '2.0.0');
    const refusal = findings.find((finding) => finding.code === 'X_VERSION_STAMP_STALE');
    expect(refusal?.cause).toContain('stamps no version');
    expect(refusal?.fix).toContain('git checkout -- wiki/_Footer.md');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('releaseCheckFindings', () => {
  // What the release workflow's "the repo is stamped at the version this tag claims" step runs.
  // The manifests alone answered `31 packages are stamped at 19.3.0` on a tree the gate refused,
  // so the composition — shape AND the three derived files — is the assertion, not either half.
  test('carries the derived files beside the manifest shape', async () => {
    const dir = await fixture({ declared: '2.0.0', locked: '1.0.0', footer: footerAt('1.0.0') });
    const codes = new Set((await releaseCheckFindings(dir, '2.0.0')).map((one) => one.code));
    // Both halves in one answer: the package-shape reader that WAS the whole of `--check`, and the
    // three derived files it never looked at. A fixture fails the shape rules by construction —
    // no README, no src/index.ts — which is what makes the first assertion worth making.
    expect(codes.has('X_PACKAGE_SHAPE')).toBe(true);
    expect(codes.has('X_MANIFEST_DRIFT')).toBe(true);
    expect(codes.has('X_LOCKFILE_STALE')).toBe(true);
    expect(codes.has('X_VERSION_STAMP_STALE')).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test('the three go quiet once the writes have been made, and skew does not', async () => {
    const dir = await fixture({ declared: '2.0.0', locked: '2.0.0', footer: footerAt('2.0.0') });
    await performReleaseWrites(dir, '2.0.0');
    const atThree = (await releaseCheckFindings(dir, '3.0.0')).map((one) => one.code);
    const atTwo = (await releaseCheckFindings(dir, '2.0.0')).map((one) => one.code);
    expect(atThree).toContain('X_RELEASE_VERSION_SKEW');
    expect(atTwo).not.toContain('X_RELEASE_VERSION_SKEW');
    expect(atTwo).not.toContain('X_MANIFEST_DRIFT');
    expect(atTwo).not.toContain('X_LOCKFILE_STALE');
    expect(atTwo).not.toContain('X_VERSION_STAMP_STALE');
    await rm(dir, { recursive: true, force: true });
  });
});

// The tree this commit is in. `--check <version>` runs this same reader in the release workflow,
// before anything reaches npm, so a red here is a release that would fail at the gate.
test('this repo owes none of the three writes', async () => {
  expect(await releaseWriteFindings(ROOT)).toEqual([]);
});

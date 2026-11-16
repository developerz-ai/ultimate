// The failure cases first: a stamp naming a version this tree does not ship, a second page
// stamping one at all, and a workspace out of lockstep. Then the vacuity guard — a footer that
// stamps nothing would otherwise let this rule compare the shipped version against no sentence.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: `node:fs/promises`'s `mkdtemp` + `node:os`'s `tmpdir` — Bun ships no temp-directory API;
// `node:path`'s `join` — no Bun path joiner. No `mkdir`: `Bun.write()` creates the parents.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS } from './lib/run';
import { readStamps, STAMP_PAGE, skipStampPath } from './lib/version-stamp-scan';
import { checkVersionStamps, readLockedDeps, versionGapFindingFor } from './version-stamps';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const footer = (text: string) => ({ path: STAMP_PAGE, text });
const lockstep = { '@ultimat3/core': '1.2.0', '@ultimat3/cli': '1.2.0' };
const stamped = '**Ultimate** — v1.2.0 `As of 2026-08`. Stable API, semver from here.';

describe('the stamp must name the version this tree ships', () => {
  test('a stale stamp is the finding, and the fix names the string to write', () => {
    const gaps = checkVersionStamps({
      files: [footer('**Ultimate** — v1.1.0 `As of 2026-08`. Stable API.')],
      versions: lockstep,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.kind).toBe('stale');
    const finding = versionGapFindingFor(gaps[0] as never, '1.2.0');
    expect(finding.code).toBe('X_VERSION_STAMP_STALE');
    expect(finding.fix).toContain('v1.2.0');
  });

  test('the current version holds', () => {
    expect(checkVersionStamps({ files: [footer(stamped)], versions: lockstep })).toEqual([]);
  });
});

describe('one stamp, and it is the footer', () => {
  test('a second page stamping a version is the finding, even at the right version', () => {
    const gaps = checkVersionStamps({
      files: [
        footer(stamped),
        { path: 'wiki/Realtime.md', text: 'v1.2.0 `As of 2026-08`. Stable.' },
      ],
      versions: lockstep,
    });
    expect(gaps.map((gap) => gap.kind)).toEqual(['duplicate']);
    expect(versionGapFindingFor(gaps[0] as never, '1.2.0').code).toBe('X_VERSION_STAMP_DUPLICATE');
  });
});

describe('a version without an `As of` beside it is an example, not a stamp', () => {
  test('a shell example is not read', () => {
    // `PUBLISHING.md` writes `git tag v1.1.0` in a release walkthrough. It is the command's shape,
    // not a claim about this build, and reading it as one would fail a correct page.
    expect(readStamps({ path: 'PUBLISHING.md', text: '```\ngit tag v1.1.0\n```' })).toEqual([]);
    expect(
      readStamps({ path: 'PUBLISHING.md', text: 'the tag said `v1.10.1` and the manifests 1.2.0' }),
    ).toEqual([]);
  });

  test("another product's version is not this repo's", () => {
    // `docs/idea/17-scale-ladder.md` names Yugabyte's v2025.2.3.
    expect(
      readStamps({ path: 'docs/idea/17-scale-ladder.md', text: "v2025.2.3's release notes" }),
    ).toEqual([]);
  });

  test('the stamp form the repo actually writes IS read', () => {
    expect(readStamps(footer(stamped))[0]?.version).toBe('1.2.0');
    expect(readStamps(footer('**v1.2.0 `As of 2026-08`. Semver applies.**'))[0]?.version).toBe(
      '1.2.0',
    );
  });

  test('CHANGELOG.md names every past version by design, and docs/plans are dated records', () => {
    expect(skipStampPath('CHANGELOG.md')).toBe(true);
    expect(skipStampPath('docs/changelog/1.0.0.md')).toBe(true);
    expect(skipStampPath('docs/plans/2026/08/16/101/13-docs-drift.md')).toBe(true);
    expect(skipStampPath('wiki/_Footer.md')).toBe(false);
  });
});

describe('versioning is in lockstep, and nothing compared the manifests', () => {
  test('two versions across the workspaces is the finding, and it names the odd ones', () => {
    const gaps = checkVersionStamps({
      files: [footer(stamped)],
      versions: { '@ultimat3/core': '1.2.0', '@ultimat3/flags': '1.1.0' },
    });
    const kinds = gaps.map((gap) => gap.kind);
    expect(kinds).toContain('lockstep');
    const finding = versionGapFindingFor(gaps[0] as never, '1.1.0');
    expect(finding.code).toBe('X_VERSION_LOCKSTEP_BROKEN');
    expect(finding.cause).toContain('@ultimat3/core@1.2.0');
  });
});

describe('the rule cannot quietly stop being one', () => {
  test('a footer that stamps nothing is a failure, never a pass', () => {
    const gaps = checkVersionStamps({
      files: [footer('**Ultimate** — MIT licensed.')],
      versions: lockstep,
    });
    expect(gaps[0]?.kind).toBe('vacuous');
    expect(versionGapFindingFor(gaps[0] as never, '1.2.0').code).toBe('X_VERSION_STAMP_UNSCANNED');
  });

  test('no file read at all is a failure too', () => {
    expect(checkVersionStamps({ files: [], versions: lockstep })[0]?.kind).toBe('vacuous');
  });

  test('no workspace version at all is a failure too', () => {
    expect(checkVersionStamps({ files: [footer(stamped)], versions: {} })[0]?.kind).toBe('vacuous');
  });
});

describe('lockstep is a claim about dependencies and about the lockfile', () => {
  test('a package depending on an older sibling breaks lockstep', () => {
    // `@ultimat3/admin@3.0.0` depending on `@ultimat3/core@1.2.0` is the mixed-version install
    // CHANGELOG.md calls a combination nobody tested — and nothing checked it until now.
    const gaps = checkVersionStamps({
      files: [footer(stamped)],
      versions: lockstep,
      internalDeps: { 'packages/admin': { '@ultimat3/core': '0.9.0' } },
    });
    expect(gaps.map((gap) => gap.kind)).toEqual(['dependency']);
    expect(gaps[0]?.at).toBe('packages/admin/package.json');
  });

  test('a range that matches the shipped version is silent', () => {
    expect(
      checkVersionStamps({
        files: [footer(stamped)],
        versions: lockstep,
        internalDeps: { 'packages/admin': { '@ultimat3/core': '1.2.0' } },
      }),
    ).toEqual([]);
  });

  test('a lockfile recording a range its package.json does not is a finding', () => {
    // The drift that was actually on disk: 90 entries at 1.2.0 and 2.0.0 against manifests that
    // all said 3.0.0. `bun install --frozen-lockfile` accepted every one of them, because a
    // workspace edge resolves by name and the recorded range is never read back.
    const gaps = checkVersionStamps({
      files: [footer(stamped)],
      versions: lockstep,
      internalDeps: { 'packages/admin': { '@ultimat3/core': '1.2.0' } },
      lockedDeps: { 'packages/admin': { '@ultimat3/core': '2.0.0' } },
    });
    expect(gaps.map((gap) => gap.kind)).toEqual(['lockfile']);
    expect(gaps[0]?.at).toBe('bun.lock');
  });

  test('a DECLARED edge the lockfile block does not record is a finding — action → entity', () => {
    // DX ledger #13: adding a workspace dependency left `bun.lock`'s block without the edge, and
    // this rule walked LOCKED edges only, so the missing one was read as nothing to compare.
    const gaps = checkVersionStamps({
      files: [footer(stamped)],
      versions: lockstep,
      internalDeps: { 'packages/action': { '@ultimat3/entity': '1.2.0' } },
      lockedDeps: { 'packages/action': {} },
    });
    expect(gaps.map((gap) => gap.kind)).toEqual(['lockfile']);
    expect(gaps[0]?.detail).toContain('@ultimat3/entity');
  });

  test('a workspace the lockfile has no block for at all is a finding too', () => {
    const gaps = checkVersionStamps({
      files: [footer(stamped)],
      versions: lockstep,
      internalDeps: { 'packages/newcomer': { '@ultimat3/core': '1.2.0' } },
      lockedDeps: { 'packages/action': {} },
    });
    expect(gaps.map((gap) => gap.kind)).toEqual(['lockfile']);
  });

  test('no lockfile read at all judges no declared edge — a root with no bun.lock', () => {
    expect(
      checkVersionStamps({
        files: [footer(stamped)],
        versions: lockstep,
        internalDeps: { 'packages/action': { '@ultimat3/entity': '1.2.0' } },
      }),
    ).toEqual([]);
  });

  test('a lock block with no @ultimat3 edge is still read as a block', async () => {
    // Dropping it read as "no block at all", so an edge newly declared by `packages/core` would be
    // reported as a missing BLOCK, and `lockfile:fix` has no block to add it to.
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-locked-deps-'));
    try {
      await Bun.write(
        join(dir, 'bun.lock'),
        '{\n  "workspaces": {\n    "packages/core": {\n      "name": "@ultimat3/core",\n    },\n  },\n}\n',
      );
      expect(await readLockedDeps(dir)).toEqual({ 'packages/core': {} });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a lockfile edge no package.json declares is not judged', () => {
    // A stale edge is `bun install`'s to remove; this rule only compares what both files carry.
    expect(
      checkVersionStamps({
        files: [footer(stamped)],
        versions: lockstep,
        internalDeps: { 'packages/admin': {} },
        lockedDeps: { 'packages/admin': { '@ultimat3/gone': '1.2.0' } },
      }),
    ).toEqual([]);
  });
});

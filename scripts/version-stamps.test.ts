// The failure cases first: a stamp naming a version this tree does not ship, a second page
// stamping one at all, and a workspace out of lockstep. Then the vacuity guard — a footer that
// stamps nothing would otherwise let this rule compare the shipped version against no sentence.

import { describe, expect, test } from 'bun:test';
import { repoRoot } from './lib/run';
import {
  checkVersionStamps,
  readStampPages,
  readStamps,
  STAMP_PAGE,
  skipStampPath,
  versionGapFindingFor,
  versionStampFindings,
} from './version-stamps';

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
      internalDeps: { admin: { '@ultimat3/core': '0.9.0' } },
    });
    expect(gaps.map((gap) => gap.kind)).toEqual(['dependency']);
    expect(gaps[0]?.at).toBe('packages/admin/package.json');
  });

  test('a range that matches the shipped version is silent', () => {
    expect(
      checkVersionStamps({
        files: [footer(stamped)],
        versions: lockstep,
        internalDeps: { admin: { '@ultimat3/core': '1.2.0' } },
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
      internalDeps: { admin: { '@ultimat3/core': '1.2.0' } },
      lockedDeps: { admin: { '@ultimat3/core': '2.0.0' } },
    });
    expect(gaps.map((gap) => gap.kind)).toEqual(['lockfile']);
    expect(gaps[0]?.at).toBe('bun.lock');
  });

  test('a lockfile edge no package.json declares is not judged', () => {
    // A stale edge is `bun install`'s to remove; this rule only compares what both files carry.
    expect(
      checkVersionStamps({
        files: [footer(stamped)],
        versions: lockstep,
        internalDeps: { admin: {} },
        lockedDeps: { admin: { '@ultimat3/gone': '1.2.0' } },
      }),
    ).toEqual([]);
  });
});

describe('against this repo', () => {
  test('the footer is on disk and this rule reads it', async () => {
    const pages = await readStampPages(repoRoot());
    expect(pages.some((page) => page.path === STAMP_PAGE)).toBe(true);
  });

  test('the tree is in lockstep and the footer is current', async () => {
    expect(await versionStampFindings(repoRoot())).toEqual([]);
  });
});

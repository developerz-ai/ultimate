// The failure cases first: a stamp naming a version this tree does not ship, a second page
// stamping one at all, and a workspace out of lockstep. Then the vacuity guard — a footer that
// stamps nothing would otherwise let this rule compare the shipped version against no sentence.

import { describe, expect, test } from 'bun:test';
// `node:fs/promises`'s `mkdtemp` + `node:os`'s `tmpdir` — Bun ships no temp-directory API;
// `node:path`'s `join` — no Bun path joiner. No `mkdir`: `Bun.write()` creates the parents.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './lib/run';
import { readRootManifest, workspaceManifests } from './lib/workspaces';
import {
  checkVersionStamps,
  compareVersions,
  readInternalDeps,
  readLockedDeps,
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

describe('a root that is not a repo', () => {
  /**
   * This rule runs as a HostCheck inside `x verify`, which turns a THROW into an internal failure
   * and hands the operator a stack trace where a finding belonged. Three `verify.test.ts` cases
   * drive it against a temp directory holding one wiki page and no root manifest at all.
   */
  const withoutRoot = async (run: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-version-stamps-'));
    try {
      await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  test('is a finding, never an ENOENT — the dependency scan cannot throw at a caller', async () => {
    await withoutRoot(async (dir) => {
      const findings = await versionStampFindings(dir);
      expect(findings.map((finding) => finding.code)).toContain('X_VERSION_STAMP_UNSCANNED');
      expect(findings.some((finding) => finding.at === 'package.json')).toBe(true);
    });
  });

  test('and the scan answers no dependencies rather than refusing to answer', async () => {
    await withoutRoot(async (dir) => {
      expect(await readInternalDeps(dir)).toEqual({});
    });
  });

  test('a root manifest that IS readable produces no such finding', async () => {
    await withoutRoot(async (dir) => {
      await Bun.write(join(dir, 'package.json'), '{ "workspaces": ["packages/*"] }\n');
      const findings = await versionStampFindings(dir);
      expect(findings.some((finding) => finding.at === 'package.json')).toBe(false);
    });
  });

  /**
   * A repo whose manifest is BROKEN is not a directory that is not a repo, and the two used to
   * share one `catch`. The fix line for the second one — `run this from the repository root` —
   * names the directory the operator is already standing in, which is the one thing the error
   * contract refuses: a fix that cannot be run.
   */
  test('a manifest that exists and does not parse names the JSON, not the working directory', async () => {
    await withoutRoot(async (dir) => {
      await Bun.write(join(dir, 'package.json'), '{ "workspaces": ["packages/*"], }\n');
      expect(await readRootManifest(dir)).toMatchObject({ kind: 'unparsable' });
      const finding = (await versionStampFindings(dir)).find((one) => one.at === 'package.json');
      if (finding === undefined) return expect.unreachable('a broken root manifest is a finding');
      expect(finding.cause).toContain('cannot be read as a workspace manifest');
      expect(finding.fix).toContain("Bun.file('package.json').json()");
      expect(finding.fix).not.toContain('git rev-parse');
    });
  });

  test('and an ABSENT one still says what it always said', async () => {
    await withoutRoot(async (dir) => {
      expect(await readRootManifest(dir)).toEqual({ kind: 'absent' });
      const finding = (await versionStampFindings(dir)).find((one) => one.at === 'package.json');
      expect(finding?.fix).toContain('cd "$(git rev-parse --show-toplevel)"');
    });
  });

  /**
   * Both fix lines RUN as pasted. A line opening with prose — `repair package.json so it parses —
   * …` — stops a shell at `repair`, so the validation command behind it is never reached by the
   * operator who pasted it, which is axiom 4 stated and not kept.
   */
  test('each root-manifest fix opens with a command a shell can run', async () => {
    await withoutRoot(async (dir) => {
      const absent = (await versionStampFindings(dir)).find((one) => one.at === 'package.json');
      await Bun.write(join(dir, 'package.json'), '{ "workspaces": ["packages/*"], }\n');
      const broken = (await versionStampFindings(dir)).find((one) => one.at === 'package.json');
      for (const fix of [absent?.fix ?? '', broken?.fix ?? '']) {
        expect(['bun', 'bunx', 'cd', 'x']).toContain(fix.split(' ')[0] ?? '');
      }
    });
  });

  /**
   * JSON that PARSES is not JSON of the right shape, and the cast that used to stand here made
   * every other shape read as an array of globs. The string form npm accepts left
   * `workspaceManifests` iterating the string's characters — a scan of `a/package.json`,
   * `p/package.json`, … reported as a clean tree — and yarn's object form is not iterable at all,
   * so it threw a `TypeError` out of a `HostCheck` where a finding belonged.
   */
  test.each([
    ['a string', '{ "workspaces": "apps/*" }\n'],
    ['an object', '{ "workspaces": { "packages": ["packages/*"] } }\n'],
    ['numbers', '{ "workspaces": ["packages/*", 7] }\n'],
    ['not an object at all', '["packages/*"]\n'],
  ])('a root manifest whose workspaces is %s is unparsable, never scanned', async (_what, text) => {
    await withoutRoot(async (dir) => {
      await Bun.write(join(dir, 'package.json'), text);
      expect(await readRootManifest(dir)).toMatchObject({ kind: 'unparsable' });
      expect(await workspaceManifests(dir)).toEqual([]);
      const finding = (await versionStampFindings(dir)).find((one) => one.at === 'package.json');
      expect(finding?.cause).toContain('cannot be read as a workspace manifest');
    });
  });

  /** The two shapes that ARE readable: an array of globs, and a manifest declaring none. */
  test('an array of globs reads, and a manifest with no workspaces key reads as none', async () => {
    await withoutRoot(async (dir) => {
      await Bun.write(join(dir, 'package.json'), '{ "workspaces": ["packages/*"] }\n');
      expect(await readRootManifest(dir)).toEqual({ kind: 'read', patterns: ['packages/*'] });
      await Bun.write(join(dir, 'package.json'), '{ "name": "solo" }\n');
      expect(await readRootManifest(dir)).toEqual({ kind: 'read', patterns: [] });
    });
  });
});

describe('which version this tree ships', () => {
  test('is decided in SEMVER order — a string compare inverts at the first two-digit major', () => {
    // `'10.0.0' < '9.0.0'` lexicographically, so `.sort()[0]` answers 10.0.0 as the lowest and
    // every workspace on 9.x then reads as the one out of lockstep.
    expect(['9.0.0', '10.0.0'].sort(compareVersions)).toEqual(['9.0.0', '10.0.0']);
    expect(compareVersions('10.0.0', '9.0.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2.10', '1.2.9')).toBeGreaterThan(0);
    expect(compareVersions('7.0.0', '7.0.0')).toBe(0);
  });

  test('and the shipped version is the lowest one, which is what names the odd workspaces', () => {
    const gaps = checkVersionStamps({
      files: [footer('v9.0.0 `As of 2026-08`.')],
      versions: { '@ultimat3/core': '9.0.0', '@ultimat3/cli': '10.0.0' },
    });
    // Under a string compare the shipped version was 10.0.0 and `core@9.0.0` was the odd one.
    expect(gaps.find((gap) => gap.kind === 'lockstep')?.detail).toBe(
      '9.0.0 everywhere except @ultimat3/cli@10.0.0',
    );
    expect(gaps.some((gap) => gap.kind === 'stale')).toBe(false);
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

  test('and the scan reaches the APP workspaces, which share this lockfile', async () => {
    // The reason the green above is worth anything: a `packages/*` glob judged 8 of 48 blocks, and
    // 53 of the 72 stale ranges found on 2026-08-22 sat in a workspace it could not see.
    const declared = await readInternalDeps(repoRoot());
    expect(Object.keys(declared)).toContain('examples/dummy/apps/web');
    expect(Object.keys(declared)).toContain('dummy/social-media-clone');
    expect(declared['packages/i18n']?.['@ultimat3/core']).toBeDefined();
  });

  test('and the lockfile reader reads the same blocks, `i18n` among them', async () => {
    const locked = await readLockedDeps(repoRoot());
    expect(Object.keys(locked)).toContain('examples/dummy/apps/web');
    // `[a-z-]+` read `@ultimat3/i18n` as no dependency at all — eight ranges, invisible.
    expect(locked['packages/http']?.['@ultimat3/i18n']).toBeDefined();
  });
});

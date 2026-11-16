// The version-stamp rule off the happy path: a root that is not a repo, which version a tree
// ships, a stamp's exact shape, a page naming a version for another reason, and this repo itself.
// Split from version-stamps.test.ts, which keeps the failure cases and the lockstep claim.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: `node:fs/promises`'s `mkdtemp` + `node:os`'s `tmpdir` — Bun ships no temp-directory API;
// `node:path`'s `join` — no Bun path joiner. No `mkdir`: `Bun.write()` creates the parents.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { readStampPages, readStamps, STAMP_PAGE } from './lib/version-stamp-scan';
import { readRootManifest, workspaceManifests } from './lib/workspaces';
import {
  checkVersionStamps,
  compareVersions,
  readInternalDeps,
  readLockedDeps,
  versionGapFindingFor,
  versionStampFindings,
} from './version-stamps';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const footer = (text: string) => ({ path: STAMP_PAGE, text });
const lockstep = { '@ultimat3/core': '1.2.0', '@ultimat3/cli': '1.2.0' };
const stamped = '**Ultimate** — v1.2.0 `As of 2026-08`. Stable API, semver from here.';

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

describe('the shape of a stamp, which one missing character used to defeat', () => {
  // Fixtures, never the live pages: `CLAUDE.md` and `AGENTS.md` are rewritten every release, and a
  // rule proven against their current text is a rule proven against nothing next month.
  const seen = (text: string): readonly string[] =>
    readStamps({ path: 'wiki/Whatever.md', text }).map((stamp) => stamp.version);

  test('no `v`, and prose between the number and the date — the AGENTS.md line', () => {
    expect(seen('All 30 publish to npm at **3.0.0** in lockstep, `As of 2026-08-19`.')).toEqual([
      '3.0.0',
    ]);
  });

  test('no `v`, a comma in the gap — the root CLAUDE.md Status line', () => {
    expect(seen('**Status:** 7.0.0, released, `As of 2026-08-21`.')).toEqual(['7.0.0']);
  });

  test('the `v` form still reads, which is what the footer writes', () => {
    expect(seen('**Ultimate** — v9.0.0 `As of 2026-08`. Stable API.')).toEqual(['9.0.0']);
  });

  test('a version with no date beside it is not a stamp', () => {
    expect(seen('git tag -a v1.1.0 -m "release"')).toEqual([]);
    expect(seen('Yugabyte v2025.2.3 is the closest comparable.')).toEqual([]);
  });

  test('a four-part or suffixed version is not a semver stamp of this tree', () => {
    expect(seen('node 20.11.1.2 `As of 2026-08`')).toEqual([]);
    expect(seen('image ultimate:1.2.3-rc1 `As of 2026-08`')).toEqual([]);
  });

  test('a gap longer than the cap joins two unrelated claims and is refused', () => {
    const far = `v1.2.0 ${'x'.repeat(60)} \`As of 2026-08\``;
    expect(seen(far)).toEqual([]);
  });

  test('a backtick in the gap ends the claim', () => {
    expect(seen('1.2.0 and `npm view @ultimat3/core version` `As of 2026-08`')).toEqual([]);
  });
});

describe('a page that names a version for a reason that is not a stamp', () => {
  test('is excused only by a pin naming the page AND the version', () => {
    const files = [
      footer(stamped),
      { path: 'docs/idea/16-app-targets.md', text: 'Tauri 2.x (2.10.1, `As of 2026-08`)' },
    ];
    expect(checkVersionStamps({ files, versions: lockstep })).toHaveLength(1);
    expect(
      checkVersionStamps({
        files,
        versions: lockstep,
        stampPins: {
          'docs/idea/16-app-targets.md@2.10.1': "Tauri's version, not this framework's",
        },
      }),
    ).toEqual([]);
  });

  test('a pin on the page does not excuse a DIFFERENT version on it', () => {
    const gaps = checkVersionStamps({
      files: [
        footer(stamped),
        {
          path: 'docs/idea/16-app-targets.md',
          text: '**Status:** 1.2.0, released, `As of 2026-08`',
        },
      ],
      versions: lockstep,
      stampPins: { 'docs/idea/16-app-targets.md@2.10.1': "Tauri's version" },
    });
    expect(gaps.map((gap) => gap.kind).sort()).toEqual(['duplicate', 'pin-stale']);
  });

  test('a pin whose sentence is gone is a finding with an executable fix', () => {
    const gaps = checkVersionStamps({
      files: [footer(stamped)],
      versions: lockstep,
      stampPins: { 'wiki/Gone.md@4.0.0': 'the page said it once' },
    });
    expect(gaps).toHaveLength(1);
    const finding = versionGapFindingFor(gaps[0] as never, '1.2.0');
    expect(finding.code).toBe('X_VERSION_STAMP_PIN_STALE');
    expect(finding.fix).toBe('bun run scripts/version-stamps.ts --unpin wiki/Gone.md@4.0.0');
  });

  test('a non-wiki page gets a fix it can follow — the footer renders under wiki/ only', () => {
    const gaps = checkVersionStamps({
      files: [
        footer(stamped),
        { path: 'AGENTS.md', text: 'at **3.0.0** in lockstep, `As of 2026-08`' },
      ],
      versions: lockstep,
    });
    const finding = versionGapFindingFor(gaps[0] as never, '1.2.0');
    expect(finding.fix).not.toContain('reaches that page through');
    expect(finding.fix).toContain("'AGENTS.md@3.0.0'");
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

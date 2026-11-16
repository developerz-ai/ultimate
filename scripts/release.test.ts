// The release script writes the artefacts nobody can un-publish, so its three text rewrites are
// pinned here: the manifest's own version, the sibling pins that make a lockstep release
// installable, and the date a release is stamped with. Where a new section lands is
// `lib/release-changelog.test.ts`'s.

import { describe, expect, test } from 'bun:test';
import { parseChangelog } from './lib/changelog-sections';
import { distTagFor } from './lib/dist-tag';
import { releaseDate } from './lib/release-changelog';
import {
  askIssueArgs,
  askLookupFailedLine,
  BUMPS,
  bumpWindowFindings,
  laneFindings,
  laneOf,
  maintenanceMajor,
  nextVersion,
  parseAskIssues,
  RELEASE_FLAGS,
  readReleaseVersion,
  releaseInvocation,
  releaseNextLine,
  repinFrameworkDeps,
  setOwnVersion,
  unknownReleaseFlags,
} from './release';

const MANIFEST = `{
  "name": "@ultimat3/jobs",
  "version": "0.0.1",
  "private": false,
  "dependencies": {
    "@ultimat3/core": "0.0.1",
    "@ultimat3/entity": "0.0.1"
  }
}
`;

describe('nextVersion', () => {
  test('0.0.1 majors to 1.0.0', () => {
    expect(nextVersion('0.0.1', 'major')).toBe('1.0.0');
  });

  test('minor and patch move the right field', () => {
    expect(nextVersion('1.2.3', 'minor')).toBe('1.3.0');
    expect(nextVersion('1.2.3', 'patch')).toBe('1.2.4');
  });

  test('a prerelease suffix is dropped, not carried forward', () => {
    expect(nextVersion('1.0.0-rc.1', 'patch')).toBe('1.0.1');
  });
});

describe('setOwnVersion', () => {
  test('rewrites the manifest version and nothing below it', () => {
    const out = setOwnVersion(MANIFEST, '1.0.0');
    expect(out).toContain('"version": "1.0.0"');
    // The dependency pins are a separate rewrite — this one must not reach them.
    expect(out).toContain('"@ultimat3/core": "0.0.1"');
  });

  test('preserves key order and the trailing newline', () => {
    const out = setOwnVersion(MANIFEST, '1.0.0');
    expect(out.split('\n')[1]).toBe('  "name": "@ultimat3/jobs",');
    expect(out.endsWith('}\n')).toBe(true);
  });
});

describe('repinFrameworkDeps', () => {
  test('moves every exact @ultimat3 pin to the release version', () => {
    const out = repinFrameworkDeps(MANIFEST, '1.0.0');
    expect(out).toContain('"@ultimat3/core": "1.0.0"');
    expect(out).toContain('"@ultimat3/entity": "1.0.0"');
  });

  // This is the bug the function exists for: a release that bumped only each package's own
  // version published @ultimat3/jobs@1.0.0 depending on @ultimat3/core@0.0.1 — a version that is
  // not on the registry, so every install of the new release fails.
  test('leaves the manifest version to setOwnVersion', () => {
    expect(repinFrameworkDeps(MANIFEST, '1.0.0')).toContain('"version": "0.0.1"');
  });

  // Caught mid-release: a `[a-z-]+` class skipped `@ultimat3/i18n`, so four manifests published
  // 1.0.0 still pinning i18n at 0.0.1. Every package name with a digit in it is this test.
  test('a package name with digits is repinned like any other', () => {
    const raw = '{ "@ultimat3/i18n": "0.0.1" }';
    expect(repinFrameworkDeps(raw, '1.0.0')).toBe('{ "@ultimat3/i18n": "1.0.0" }');
  });

  test('a caret range or a tag is somebody intent, not skew', () => {
    const ranges = '{"dependencies":{"@ultimat3/core":"^1.0.0","@ultimat3/ui":"next"}}';
    expect(repinFrameworkDeps(ranges, '2.0.0')).toBe(ranges);
  });

  test('a third-party dependency at the same version is untouched', () => {
    const raw = '{ "@ultimat3/core": "0.0.1", "solid-js": "0.0.1" }';
    expect(repinFrameworkDeps(raw, '1.0.0')).toBe(
      '{ "@ultimat3/core": "1.0.0", "solid-js": "0.0.1" }',
    );
  });
});

describe('releaseDate', () => {
  // No date without an explicit IANA zone, this script included: a release cut at 23:00 local must
  // not be dated a day away from the tag it is committed with.
  test('is ISO-8601 in UTC', () => {
    expect(releaseDate(new Date('2026-08-20T23:30:00-05:00'))).toBe('2026-08-21');
  });
});

describe('unit · the version to publish is decided, never guessed', () => {
  // `--bump` was cast to the union with no check: `majr` fell through both branches of
  // `nextVersion` and shipped a breaking change as 1.2.1 across 29 manifests, exit code 0.
  test('a typo in --bump is refused instead of silently producing a patch', () => {
    const result = readReleaseVersion({ explicit: undefined, bump: 'majr', current: '1.2.0' });
    expect(nextVersion('1.2.0', 'majr' as never)).toBe('1.2.1');
    expect('findings' in result && result.findings[0]?.code).toBe('X_CLI_BAD_FLAG');
    expect('findings' in result && result.findings[0]?.cause).toContain('patch, minor, major');
  });

  test('--version is checked against semver, so "1.2" never reaches a package.json', () => {
    const result = readReleaseVersion({ explicit: '1.2', bump: undefined, current: '1.2.0' });
    expect('findings' in result && result.findings[0]?.cause).toContain('semver');
    expect(readReleaseVersion({ explicit: '1.3.0', bump: undefined, current: '1.2.0' })).toEqual({
      version: '1.3.0',
    });
  });

  test('every declared bump resolves, and the default is patch', () => {
    for (const bump of BUMPS) {
      expect(readReleaseVersion({ explicit: undefined, bump, current: '1.2.0' })).toEqual({
        version: nextVersion('1.2.0', bump),
      });
    }
  });

  // This assertion used to read `toEqual({ version: '1.2.1' })` — it pinned the implicit patch
  // default as if it were a feature. It is the reason `bun run scripts/release.ts --help` rewrote
  // 47 manifests and the helm chart: no `--help` exists, the parser shrugged, and "no explicit, no
  // bump" meant "release a patch". A release is the most expensive thing here to undo.
  test('neither --version nor --bump is a refusal, never a patch bump', () => {
    const result = readReleaseVersion({ explicit: undefined, bump: undefined, current: '1.2.0' });
    expect('findings' in result).toBe(true);
    const findings = 'findings' in result ? result.findings : [];
    expect(findings[0]?.code).toBe('X_RELEASE_VERSION_UNSTATED');
    expect(findings[0]?.cause).toContain('1.2.0');
    expect(findings[0]?.fix).toStartWith('bun run scripts/release.ts');
  });

  test('a flag this script does not declare is refused before anything is decided', () => {
    expect(unknownReleaseFlags(['help'])).toEqual(['help']);
    expect(unknownReleaseFlags(['bump', 'json', 'dry-run'])).toEqual([]);
    // Sorted, so the refusal reads the same however the shell ordered them.
    expect(unknownReleaseFlags(['zebra', 'check', 'apple'])).toEqual(['apple', 'zebra']);
  });

  // Through the function, not against the constant: comparing a `string[]` to the readonly literal
  // tuple narrows `toContain`'s parameter to the union and stops compiling, and asserting the
  // constant against itself would prove nothing anyway. Every invocation PUBLISHING.md prints.
  test('every flag the docs tell a reader to pass is accepted', () => {
    expect(
      unknownReleaseFlags(['version', 'bump', 'check', 'dry-run', 'json', 'security', 'rehearse']),
    ).toEqual([]);
    expect(RELEASE_FLAGS.length).toBe(7);
  });

  test('the fix line is a command a shell can run verbatim', () => {
    const result = readReleaseVersion({ explicit: undefined, bump: 'majr', current: '1.2.0' });
    const fix = 'findings' in result ? (result.findings[0]?.fix ?? '') : '';
    expect(fix).toStartWith('bun run scripts/release.ts');
    expect(fix).not.toContain('<');
  });
});

describe('unit · a release only moves forward, and is asked for one way', () => {
  const refusal = (result: ReturnType<typeof readReleaseVersion>) =>
    'findings' in result ? result.findings : [];

  test('--version at the current version is refused, naming both', () => {
    const [finding] = refusal(
      readReleaseVersion({ explicit: '1.2.0', bump: undefined, current: '1.2.0' }),
    );
    expect(finding?.code).toBe('X_RELEASE_VERSION_INVALID');
    expect(finding?.cause).toContain('1.2.0');
    expect(finding?.fix).toStartWith('bun run scripts/release.ts --bump ');
  });

  test('--version below the current one is refused in semver order, not string order', () => {
    const [finding] = refusal(
      readReleaseVersion({ explicit: '9.9.9', bump: undefined, current: '10.0.0' }),
    );
    expect(finding?.code).toBe('X_RELEASE_VERSION_INVALID');
    expect(finding?.cause).toContain('9.9.9');
    expect(finding?.cause).toContain('10.0.0');
    expect(readReleaseVersion({ explicit: '10.0.0', bump: undefined, current: '9.9.9' })).toEqual({
      version: '10.0.0',
    });
  });

  test('a prerelease promoted to its release moves forward', () => {
    expect(
      readReleaseVersion({ explicit: '2.0.0', bump: undefined, current: '2.0.0-rc.1' }),
    ).toEqual({ version: '2.0.0' });
  });

  // `--bump` was read only when `--version` was absent, so `--version 1.3.0 --bump major` released
  // 1.3.0 and said nothing about the major somebody asked for.
  test('--version and --bump together is refused rather than one silently winning', () => {
    const [finding, ...rest] = refusal(
      readReleaseVersion({ explicit: '1.3.0', bump: 'major', current: '1.2.0' }),
    );
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_RELEASE_VERSION_INVALID');
    expect(finding?.cause).toContain('--version 1.3.0');
    expect(finding?.cause).toContain('--bump major');
  });

  // It said `or --version <current>`, which is now the refusal above.
  test('the unstated fix no longer suggests re-releasing the current version', () => {
    const [finding] = refusal(
      readReleaseVersion({ explicit: undefined, bump: undefined, current: '1.2.0' }),
    );
    expect(finding?.fix).not.toContain('--version 1.2.0');
  });
});

describe('unit · the commands a release prints are the safe form', () => {
  // Merging the release PR is the release: release-tag.yml tags it. A hand tag the next line
  // printed was the step that went wrong — lightweight, unpushed, or cut before the bump.
  test('the next line opens the release PR and never tells anyone to tag by hand', () => {
    const line = releaseNextLine('1.3.0');
    expect(line).toContain('open the `chore: release 1.3.0` PR');
    expect(line).toContain('merging it is the release (release-tag.yml)');
    expect(line).not.toMatch(/git tag|gh release create/);
  });

  test('the rerun names only validated flags, in the form the script parses', () => {
    expect(
      releaseInvocation({ explicit: undefined, bump: 'minor', dryRun: false, json: true }),
    ).toBe('bun run scripts/release.ts --bump minor --json');
    expect(
      releaseInvocation({ explicit: '1.3.0', bump: undefined, dryRun: true, json: false }),
    ).toBe('bun run scripts/release.ts --version 1.3.0 --dry-run');
  });

  // A dirty-tree refusal's fix used to drop `--security`, so its rerun asked for the major the
  // window refuses without the advisory that excused it.
  test('the rerun carries --security, already held to an advisory id', () => {
    expect(
      releaseInvocation({
        explicit: undefined,
        bump: 'major',
        dryRun: true,
        json: true,
        security: 'GHSA-2c8m-p4fq-w9xr',
      }),
    ).toBe(
      'bun run scripts/release.ts --bump major --security GHSA-2c8m-p4fq-w9xr --dry-run --json',
    );
  });

  test('an id that is no advisory is refused on any bump, before it can reach a fix line', () => {
    const findings = bumpWindowFindings({
      version: '31.0.0',
      changelog: parseChangelog('# Changelog\n\n## 30.0.0 - 2026-01-01\n\n- x\n'),
      today: '2026-11-03',
      security: 'x; rm -rf /',
    });
    expect(findings.map((one) => one.code)).toEqual(['X_CLI_BAD_FLAG']);
  });
});

describe('unit · the ask a release closes', () => {
  // The dedupe query, verbatim from `.dz/briefs/release-due.md`: open issues, title search only.
  test('the gh lookup is the release-due query over number,title rows', () => {
    const args = askIssueArgs('27.11.0');
    expect(args[args.indexOf('--state') + 1]).toBe('open');
    expect(args[args.indexOf('--search') + 1]).toBe('Release 27.11.0 in:title');
    expect(args[args.indexOf('--json') + 1]).toBe('number,title');
  });

  test('an open ask for this version puts `Fixes #<n>` in the next line and closes the ask', () => {
    const line = releaseNextLine('27.11.0', 'Fixes #813');
    expect(line).toContain('Fixes #813');
    expect(line).toContain('closes the ask');
    // The close is still the merge through release-tag.yml, never a hand step.
    expect(line).not.toMatch(/git tag|gh release create/);
  });

  test('with no ask confirmed, the next line promises no close', () => {
    expect(releaseNextLine('27.11.0', undefined)).not.toContain('closes the ask');
    expect(releaseNextLine('27.11.0')).not.toMatch(/Fixes #\d/);
  });

  test('a failed lookup degrades to one printed line that names no issue', () => {
    const line = askLookupFailedLine('27.11.0');
    expect(line.startsWith('  ask')).toBe(true);
    expect(line).toContain('lookup failed');
    expect(line).not.toMatch(/Fixes #\d/);
  });

  test('gh rows in, issues out; malformed rows drop, garbage is no ask', () => {
    expect(parseAskIssues('[{"number":813,"title":"Release 27.11.0"}]')).toEqual([
      { number: 813, title: 'Release 27.11.0' },
    ]);
    expect(parseAskIssues('[{"number":813,"title":"Release 27.11.0"},{"oops":true}]')).toEqual([
      { number: 813, title: 'Release 27.11.0' },
    ]);
    // A string number is not the row gh promised.
    expect(parseAskIssues('[{"number":"813","title":"Release 27.11.0"}]')).toEqual([]);
  });

  test('anything but the rows is no ask — the lookup is best effort', () => {
    expect(parseAskIssues('gh: (NotFound) …')).toEqual([]);
    expect(parseAskIssues('')).toEqual([]);
    expect(parseAskIssues('{"number":813,"title":"Release 27.11.0"}')).toEqual([]);
    expect(parseAskIssues('[{}]')).toEqual([]);
  });
});

describe('unit · maint · a release/<major>.x branch ships patches of its major, under maint-<major>', () => {
  const lane = (branch: string, current: string, bump: 'patch' | 'minor' | 'major') => {
    const resolved = readReleaseVersion({ explicit: undefined, bump, current });
    if ('findings' in resolved) return expect.unreachable('a declared bump always resolves');
    return {
      version: resolved.version,
      findings: laneFindings({ branch, current, version: resolved.version }),
    };
  };

  test('maint: a patch from release/30.x is the next 30.x patch and tags under maint-30, never latest', () => {
    const { version, findings } = lane('release/30.x', '30.9.0', 'patch');
    expect(version).toBe('30.9.1');
    expect(findings).toEqual([]);
    // What release.yml's `check` job asks once 31 is npm's latest: the patch earns maint-30.
    const tag = distTagFor(version, '31.30.0');
    expect(tag).toEqual({ tag: 'maint-30' });
    expect(tag).not.toEqual({ tag: 'latest' });
  });

  test('maint: --bump minor and --bump major on release/30.x are refused before a manifest moves', () => {
    for (const bump of ['minor', 'major'] as const) {
      const { findings } = lane('release/30.x', '30.9.0', bump);
      expect(findings.map((finding) => finding.code)).toEqual(['X_RELEASE_LANE_PATCH_ONLY']);
      expect(findings[0]?.cause).toContain('release/30.x');
      expect(findings[0]?.fix.startsWith('bun run scripts/release.ts --bump patch')).toBe(true);
    }
  });

  test('maint: --version is held to the same rule — a patch of the line, nothing wider', () => {
    const at = (version: string) =>
      laneFindings({ branch: 'release/30.x', current: '30.9.0', version }).map((f) => f.code);
    expect(at('30.9.3')).toEqual([]);
    expect(at('30.10.0')).toEqual(['X_RELEASE_LANE_PATCH_ONLY']);
    expect(at('30.10.1')).toEqual(['X_RELEASE_LANE_PATCH_ONLY']);
  });

  test('maint: a tree that is not at the branch major is refused, whatever the bump', () => {
    // release/30.x checked out over a 31 tree: the patch would be 31.30.1, published off the line.
    const { findings } = lane('release/30.x', '31.30.0', 'patch');
    expect(findings.map((finding) => finding.code)).toEqual(['X_RELEASE_LANE_PATCH_ONLY']);
  });

  test('maint: main, a bump branch and a detached HEAD are no lane: every bump stands', () => {
    for (const branch of [undefined, '', 'main', 'chore/release-31.31.0', 'release/31.31.0']) {
      expect(laneFindings({ branch, current: '31.30.0', version: '32.0.0' })).toEqual([]);
    }
  });

  test('maint: the major is read from release/<major>.x and nothing looser', () => {
    expect(maintenanceMajor('release/30.x')).toBe(30);
    expect(maintenanceMajor('release/7.x')).toBe(7);
    expect(maintenanceMajor('release/30.1.x')).toBeUndefined();
    expect(maintenanceMajor('release/x')).toBeUndefined();
    expect(maintenanceMajor('main')).toBeUndefined();
    expect(maintenanceMajor(undefined)).toBeUndefined();
  });
});

describe('unit · maint · the lane a bump branch belongs to', () => {
  test('maint: the checked-out line, else the line its upstream tracks, else none', () => {
    expect(laneOf('release/30.x', undefined)).toBe('release/30.x');
    // `git switch -c chore/release-30.9.1 origin/release/30.x` tracks the line it was cut from.
    expect(laneOf('chore/release-30.9.1', 'origin/release/30.x')).toBe('release/30.x');
    expect(laneOf('chore/release-31.31.0', 'origin/main')).toBeUndefined();
    expect(laneOf('chore/release-31.31.0', undefined)).toBeUndefined();
    expect(laneOf(undefined, 'origin/release/30.x')).toBe('release/30.x');
  });
});

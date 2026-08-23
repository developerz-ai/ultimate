// The release script writes the artefacts nobody can un-publish, so its three text rewrites are
// pinned here: the manifest's own version, the sibling pins that make a lockstep release
// installable, and where a new section lands in a newest-first changelog.

import { describe, expect, test } from 'bun:test';
import { checkChangelog } from './changelog-check';
import {
  BUMPS,
  commitBlock,
  nextVersion,
  promoteUnreleased,
  RELEASE_FLAGS,
  readReleaseVersion,
  releaseDate,
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

describe('promoteUnreleased', () => {
  const changelog = [
    '# Changelog',
    '',
    'Preamble.',
    '',
    '## [Unreleased]',
    '',
    '### Changed',
    '',
    '- **BREAKING — a thing moved.** Do the edit.',
    '',
    '## 1.0.0 - 2026-08-10',
    '',
    '- first',
    '',
  ].join('\n');

  const promote = (text: string, version = '2.0.0', subjects: readonly string[] = []): string => {
    const result = promoteUnreleased({ changelog: text, version, date: '2026-08-20', subjects });
    return 'changelog' in result ? result.changelog : '';
  };

  // The whole issue, in one assertion: the migration ends up IN the version's own section, and
  // there is exactly one heading for that version — not a generated one above a hand-written one.
  test('the [Unreleased] body becomes the version section, migration and all', () => {
    const out = promote(changelog);
    const headings = out.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toEqual(['## [Unreleased]', '## 2.0.0 - 2026-08-20', '## 1.0.0 - 2026-08-10']);
    const section = out.slice(out.indexOf('## 2.0.0'), out.indexOf('## 1.0.0'));
    expect(section).toContain('- **BREAKING — a thing moved.** Do the edit.');
  });

  test('a fresh, empty [Unreleased] is opened above it', () => {
    const out = promote(changelog);
    const head = out.slice(out.indexOf('## [Unreleased]'), out.indexOf('## 2.0.0'));
    expect(head).toBe('## [Unreleased]\n\nNothing yet.\n\n');
    expect(head).not.toContain('BREAKING');
  });

  // A second release is a second promotion, and the placeholder must not accumulate down the file.
  test('the placeholder is never carried into a release section', () => {
    const next = promote(changelog).replace('Nothing yet.', '- **BREAKING — the next one.** Edit.');
    const twice = promote(next, '2.0.1');
    expect(twice.split('Nothing yet.').length - 1).toBe(1);
    expect(twice.indexOf('Nothing yet.')).toBeLessThan(twice.indexOf('## 2.0.1'));
  });

  test('commit subjects land INSIDE the section, under a heading nothing hand-written uses', () => {
    const out = promote(changelog, '2.0.0', ['fix(cli): a thing', 'docs: another']);
    const section = out.slice(out.indexOf('## 2.0.0'), out.indexOf('## 1.0.0'));
    expect(section).toContain('### Commits\n\n- fix(cli): a thing\n- docs: another\n');
    // Verbatim: a subject is provenance, and rewriting it is how it stops matching `git log`.
    expect(section).not.toContain('### Fixed');
  });

  test('the promoted file passes the changelog gate rules, tagged', () => {
    // The heading as well as the row: `changelog-check` asserts both, because a row pointing at a
    // section that does not exist is what let `1.x → 2.0.0` promise a walkthrough for six releases.
    const upgrading = [
      '| From → to | Breaking entries | Read |',
      '|---|---|---|',
      '| 1.x → 2.0.0 | **1** | the `2.0.0` section, in order |',
      '',
      '## 1.x → 2.0.0, entry by entry',
      '',
      '- the one entry',
    ].join('\n');
    expect(
      checkChangelog({ changelog: promote(changelog), upgrading, taggedVersion: '2.0.0' }),
    ).toEqual([]);
    // And the file it was promoted FROM does not, which is what the promotion is for.
    expect(
      checkChangelog({ changelog, upgrading, taggedVersion: '2.0.0' }).map((gap) => gap.kind),
    ).toContain('unreleased-breaking');
  });

  test('no [Unreleased] heading is a refusal, never a guess', () => {
    const result = promoteUnreleased({
      changelog: '# Changelog\n\n## 1.0.0\n\n- first\n',
      version: '2.0.0',
      date: '2026-08-20',
      subjects: [],
    });
    expect('findings' in result && result.findings[0]?.code).toBe('X_RELEASE_UNRELEASED_MISSING');
  });

  test('nothing to say is a refusal too, so no release ships an empty section', () => {
    const result = promoteUnreleased({
      changelog: '# Changelog\n\n## [Unreleased]\n\nNothing yet.\n\n## 1.0.0\n\n- first\n',
      version: '1.0.1',
      date: '2026-08-20',
      subjects: [],
    });
    expect('findings' in result && result.findings[0]?.code).toBe(
      'X_DOC_CHANGELOG_SECTION_INVALID',
    );
  });

  // 93443aeb is a human writing a version's section by hand after a botched release, which is the
  // shape this refuses: the section for `version` is already on the page, so promotion would put a
  // SECOND one above it — the two-headings-per-version defect the promotion rewrite was for, one
  // step further along. Refused here, so it happens before the 47 manifests move.
  test('a version the changelog already holds is a refusal, not a second section', () => {
    const held = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '- **BREAKING — a thing moved.** Do the edit.',
      '',
      '## 6.0.0 - 2026-08-19',
      '',
      '- released by hand',
      '',
    ].join('\n');
    const result = promoteUnreleased({
      changelog: held,
      version: '6.0.0',
      date: '2026-08-20',
      subjects: ['fix(cli): a thing'],
    });
    expect('findings' in result && result.findings[0]?.code).toBe(
      'X_DOC_CHANGELOG_SECTION_INVALID',
    );
    expect('changelog' in result).toBe(false);
  });

  // The refusal is about the TARGET version only — an unrelated section on the page is not one.
  test('a different version already on the page still promotes', () => {
    const out = promote(changelog, '2.0.0');
    expect(out.split('\n').filter((line) => line.startsWith('## 2.0.0')).length).toBe(1);
  });

  test('an empty subject list adds no heading at all', () => {
    expect(commitBlock([])).toEqual([]);
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
    expect(unknownReleaseFlags(['version', 'bump', 'check', 'dry-run', 'json'])).toEqual([]);
    expect(RELEASE_FLAGS.length).toBe(5);
  });

  test('the fix line is a command a shell can run verbatim', () => {
    const result = readReleaseVersion({ explicit: undefined, bump: 'majr', current: '1.2.0' });
    const fix = 'findings' in result ? (result.findings[0]?.fix ?? '') : '';
    expect(fix).toStartWith('bun run scripts/release.ts');
    expect(fix).not.toContain('<');
  });
});

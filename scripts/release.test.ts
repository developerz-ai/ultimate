// The release script writes the artefacts nobody can un-publish, so its three text rewrites are
// pinned here: the manifest's own version, the sibling pins that make a lockstep release
// installable, and where a new section lands in a newest-first changelog.

import { describe, expect, test } from 'bun:test';
import {
  BUMPS,
  changelogEntry,
  insertRelease,
  nextVersion,
  RELEASE_FLAGS,
  readReleaseVersion,
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

describe('insertRelease', () => {
  const changelog = ['# Changelog', '', '## [Unreleased]', '', '### Added', '', '- a thing', ''];

  test('lands under [Unreleased] and above every previous version', () => {
    const once = insertRelease(
      `${changelog.join('\n')}\n## 1.0.0\n\n- first\n`,
      '## 1.1.0\n\n- next\n',
    );
    const headings = once.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toEqual(['## [Unreleased]', '## 1.1.0', '## 1.0.0']);
  });

  // Appending was the old behaviour: correct for the first release, and wrong for every one after,
  // because the file then read oldest-first from its third entry on.
  test('a second release does not sort below the first', () => {
    const first = insertRelease(`${changelog.join('\n')}\n`, '## 1.0.0\n\n- first\n');
    const second = insertRelease(first, '## 1.0.1\n\n- fix\n');
    expect(second.indexOf('## 1.0.1')).toBeLessThan(second.indexOf('## 1.0.0'));
  });

  test('appends when the file has no version heading yet', () => {
    expect(insertRelease('# Changelog\n', '## 1.0.0\n')).toBe('# Changelog\n\n## 1.0.0\n');
  });
});

describe('changelogEntry', () => {
  test('groups conventional subjects under Keep a Changelog headings', () => {
    const entry = changelogEntry('1.0.0', ['feat(cli): x verify', 'fix(http): 401 on anonymous']);
    expect(entry).toContain('## 1.0.0');
    expect(entry).toContain('### Added\n\n- x verify');
    expect(entry).toContain('### Fixed\n\n- 401 on anonymous');
  });

  test('an unconventional subject still lands somewhere, verbatim', () => {
    expect(changelogEntry('1.0.0', ['tidy up'])).toContain('### Changed\n\n- tidy up');
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

  test('every flag the docs tell a reader to pass is declared', () => {
    for (const flag of ['version', 'bump', 'check', 'dry-run', 'json']) {
      expect(RELEASE_FLAGS).toContain(flag);
    }
  });

  test('the fix line is a command a shell can run verbatim', () => {
    const result = readReleaseVersion({ explicit: undefined, bump: 'majr', current: '1.2.0' });
    const fix = 'findings' in result ? (result.findings[0]?.fix ?? '') : '';
    expect(fix).toStartWith('bun run scripts/release.ts');
    expect(fix).not.toContain('<');
  });
});

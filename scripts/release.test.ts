// The release script writes the artefacts nobody can un-publish, so its three text rewrites are
// pinned here: the manifest's own version, the sibling pins that make a lockstep release
// installable, and where a new section lands in a newest-first changelog.

import { describe, expect, test } from 'bun:test';
import {
  changelogEntry,
  insertRelease,
  nextVersion,
  repinFrameworkDeps,
  setOwnVersion,
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

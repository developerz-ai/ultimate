// The versions a release-tag walk may ask about: released bare semver only, newest first.

import { describe, expect, test } from 'bun:test';
import { parseChangelog } from './changelog-sections';
import { releasedVersions } from './release-tag-walk';

describe('releasedVersions', () => {
  test('skips [Unreleased] and non-semver headings, keeps the file`s order', () => {
    const changelog = parseChangelog(
      '## [Unreleased]\n\nx\n\n## Releases\n\nx\n\n## 31.4 notes\n\nx\n\n## 31.4.1 - 2026-11-12\n\nx\n\n## [31.4.0] - 2026-11-11\n\nx\n',
    );
    expect(releasedVersions(changelog)).toEqual(['31.4.1', '31.4.0']);
  });
});

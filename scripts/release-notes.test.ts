// The notes `release-tag.yml` puts on a GitHub Release: exactly one version's CHANGELOG.md
// section, never its neighbour's, and a refusal — not an empty Release — when there is none.

import { describe, expect, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot, run } from './lib/run';
import { notesFindings, sectionBody, UNRELEASED_VERSION } from './release-notes';

const CHANGELOG = [
  '# Changelog',
  '',
  'Preamble that belongs to no release.',
  '',
  '## [Unreleased]',
  '',
  'Nothing yet.',
  '',
  '## 1.2.0 - 2026-10-01',
  '',
  '### Added',
  '',
  '- a thing',
  '',
  '### Commits',
  '',
  '- feat: a thing (#2)',
  '',
  '## 1.1.0 - 2026-09-01',
  '',
  '### Fixed',
  '',
  '- an older thing',
  '',
].join('\n');

describe('unit · release-notes · one section, and only that one', () => {
  test('a released section is its body, without its heading or the next section', () => {
    expect(sectionBody(CHANGELOG, '1.2.0')).toBe(
      '### Added\n\n- a thing\n\n### Commits\n\n- feat: a thing (#2)',
    );
    expect(sectionBody(CHANGELOG, '1.1.0')).toBe('### Fixed\n\n- an older thing');
  });

  test('[Unreleased] with only its placeholder is empty, never "Nothing yet."', () => {
    expect(sectionBody(CHANGELOG, UNRELEASED_VERSION)).toBe('');
    const filled = CHANGELOG.replace('Nothing yet.', '### Fixed\n\n- pending');
    expect(sectionBody(filled, UNRELEASED_VERSION)).toBe('### Fixed\n\n- pending');
  });

  test('a version the page does not hold is undefined, not the nearest section', () => {
    expect(sectionBody(CHANGELOG, '1.3.0')).toBeUndefined();
    expect(sectionBody(CHANGELOG, '1.2')).toBeUndefined();
  });
});

describe('unit · release-notes · refusals', () => {
  test('no section, or an empty one, refuses with a coded finding', () => {
    const emptied = CHANGELOG.replace('### Fixed\n\n- an older thing', '');
    for (const [changelog, version] of [
      [CHANGELOG, '9.9.9'],
      [emptied, '1.1.0'],
    ] as const) {
      const missing = notesFindings(changelog, version);
      expect('findings' in missing && missing.findings[0]?.code).toBe(
        'X_DOC_CHANGELOG_SECTION_INVALID',
      );
    }
  });

  test('a version that is not semver is refused before the page is read', () => {
    for (const version of [undefined, 'v1.2.0', '1.2', '1.2.0; rm -rf /']) {
      const refused = notesFindings(CHANGELOG, version);
      expect('findings' in refused && refused.findings[0]?.code).toBe('X_CLI_BAD_FLAG');
    }
  });

  test('a real section reads back as notes', () => {
    expect(notesFindings(CHANGELOG, '1.2.0')).toEqual({
      notes: sectionBody(CHANGELOG, '1.2.0') ?? '',
    });
  });
});

describe('unit · release-notes · the CLI', () => {
  // The workflow reads `.data.notes` off `--json`; the envelope is the contract it relies on.
  test(
    '--json carries the newest released section of the real CHANGELOG.md',
    async () => {
      const changelog = await Bun.file(`${repoRoot()}/CHANGELOG.md`).text();
      const newest = /^## (\d+\.\d+\.\d+)/m.exec(changelog)?.[1] ?? '';
      const out = await run(
        ['bun', 'run', 'scripts/release-notes.ts', '--version', newest, '--json'],
        { cwd: repoRoot() },
      );
      expect(out.ok).toBe(true);
      const parsed = JSON.parse(out.output) as { ok: boolean; data: { notes: string } };
      expect(parsed.data.notes).toBe(sectionBody(changelog, newest) ?? '');
      expect(parsed.data.notes.length).toBeGreaterThan(0);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});

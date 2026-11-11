// The notes `release-tag.yml` puts on a GitHub Release: exactly one version's changelog section
// (`docs/changelog/X.Y.Z.md`), never its neighbour's, and a refusal — not an empty Release — when there is none.

import { describe, expect, test } from 'bun:test';
import { parseChangelog } from './lib/changelog-sections';
import { loadChangelog } from './lib/changelog-store';
import { REPO_SCAN_TIMEOUT_MS, repoRoot, run } from './lib/run';
import { highlightNotes, notesFindings, sectionBody, UNRELEASED_VERSION } from './release-notes';

const TEXT = [
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
const CHANGELOG = parseChangelog(TEXT);

describe('unit · release-notes · one section, and only that one', () => {
  test('a released section is its body, without its heading or the next section', () => {
    expect(sectionBody(CHANGELOG, '1.2.0')).toBe(
      '### Added\n\n- a thing\n\n### Commits\n\n- feat: a thing (#2)',
    );
    expect(sectionBody(CHANGELOG, '1.1.0')).toBe('### Fixed\n\n- an older thing');
  });

  test('[Unreleased] with only its placeholder is empty, never "Nothing yet."', () => {
    expect(sectionBody(CHANGELOG, UNRELEASED_VERSION)).toBe('');
    const filled = parseChangelog(TEXT.replace('Nothing yet.', '### Fixed\n\n- pending'));
    expect(sectionBody(filled, UNRELEASED_VERSION)).toBe('### Fixed\n\n- pending');
  });

  test('a version the page does not hold is undefined, not the nearest section', () => {
    expect(sectionBody(CHANGELOG, '1.3.0')).toBeUndefined();
    expect(sectionBody(CHANGELOG, '1.2')).toBeUndefined();
  });
});

describe('unit · release-notes · refusals', () => {
  test('no section, or an empty one, refuses with a coded finding', () => {
    const emptied = parseChangelog(TEXT.replace('### Fixed\n\n- an older thing', ''));
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
    '--json carries the newest released section of the real changelog, short when it has Highlights',
    async () => {
      const changelog = await loadChangelog(repoRoot());
      const newest = changelog.find((one) => one.released)?.version ?? '';
      expect(newest).toMatch(/^\d+\.\d+\.\d+$/);
      const out = await run(
        ['bun', 'run', 'scripts/release-notes.ts', '--version', newest, '--json'],
        { cwd: repoRoot() },
      );
      expect(out.ok).toBe(true);
      const parsed = JSON.parse(out.output) as { ok: boolean; data: { notes: string } };
      // A section with Highlights ships the short body; one without, its raw body.
      expect(parsed.data.notes).toBe(
        highlightNotes(changelog, newest) ?? sectionBody(changelog, newest) ?? '',
      );
      expect(parsed.data.notes.length).toBeGreaterThan(0);
    },
    REPO_SCAN_TIMEOUT_MS,
  );

  // The workflow pipes `--json` into jq under `pipefail`: a missing section must be one coded JSON
  // document and exit 1 — never a crash after the refusal, which jq would read as no notes at all.
  test(
    'a version with no section exits 1 with one coded JSON document',
    async () => {
      const out = await run(
        ['bun', 'run', 'scripts/release-notes.ts', '--version', '0.0.0-absent', '--json'],
        { cwd: repoRoot() },
      );
      expect(out.code).toBe(1);
      const parsed = JSON.parse(out.output) as { ok: boolean; findings: { code: string }[] };
      expect(parsed.ok).toBe(false);
      expect(parsed.findings.map((finding) => finding.code)).toEqual([
        'X_DOC_CHANGELOG_SECTION_INVALID',
      ]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});

// wiki/Stability.md: from 30.0.0 a Release body is the Highlights and where to read the rest,
// so it reads in under 30 seconds. The full section stays in docs/changelog/, linked at the tag.
describe('unit · release-notes · a highlighted section is a short Release body', () => {
  const highlightedText = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    'Nothing yet.',
    '',
    '## 30.0.0 - 2026-11-10',
    '',
    '### Highlights',
    '',
    '- one major for the whole plan',
    '- a stability promise',
    '',
    '### Changed',
    '',
    '- **BREAKING — (#1) a long entry nobody reads in a Release body.**',
    '',
    '## 29.4.0 - 2026-10-31',
    '',
    '- older',
  ].join('\n');
  const highlighted = parseChangelog(highlightedText);

  test('a major opens with its Highlights, then its Upgrading anchor and the full section', () => {
    const read = notesFindings(highlighted, '30.0.0');
    const notes = 'notes' in read ? read.notes : '';
    expect(notes).toStartWith(
      '### Highlights\n\n- one major for the whole plan\n- a stability promise',
    );
    expect(notes).toContain(
      'https://github.com/developerz-ai/ultimate/wiki/Upgrading#29x--3000-entry-by-entry',
    );
    expect(notes).toContain(
      'https://github.com/developerz-ai/ultimate/blob/v30.0.0/docs/changelog/30.0.0.md',
    );
    expect(notes).not.toContain('a long entry nobody reads');
  });

  test('a minor names no Upgrading walkthrough: it has nothing to migrate', () => {
    const minor = parseChangelog(
      highlightedText.replace('## 30.0.0 - 2026-11-10', '## 30.1.0 - 2026-11-17'),
    );
    const read = notesFindings(minor, '30.1.0');
    const notes = 'notes' in read ? read.notes : '';
    expect(notes).toStartWith('### Highlights');
    expect(notes).not.toContain('wiki/Upgrading');
  });
});

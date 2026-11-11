// CHANGELOG.md as an index: the row each release gets is quoted from its file, a release section
// left in the index moves out byte for byte, and every way the two drift apart is a finding.

import { describe, expect, test } from 'bun:test';
import {
  indexFindings,
  moveReleasedSections,
  releaseTable,
  summaryOf,
  withReleaseTable,
} from './changelog-index';
import { parseChangelog } from './changelog-sections';
import { assembleChangelog, type ChangelogFile, readChangelogFiles } from './changelog-store';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';

const section = (text: string) =>
  parseChangelog(text, 'docs/changelog/1.0.0.md')[0] ?? expect.unreachable();
const HEAD = '# Changelog\n\nIntro.\n\n## [Unreleased]\n\nNothing yet.\n\n';
const OLDER = '## Older releases\n\nIn git history.\n';
const V2 =
  '## 2.0.0 - 2026-08-20\n\n### Highlights\n\n- Big | news.\n- More.\n\n### Changed\n\n- x\n';
const V1 =
  '## 1.0.0 - 2026-08-10\n\n### Fixed\n\n- y\n\n### Added\n\n- z\n\n### Fixed\n\n- w\n\n### Commits\n\n- c\n';

/** An index written the old way: every release inline, as CHANGELOG.md was before 31.3.0. */
const INLINE = `${HEAD}${V2}\n${V1}\n${OLDER}`;

describe('unit · changelog-index · the summary is quoted, never written', () => {
  test('the first Highlights bullet, its pipe escaped for the table', () => {
    expect(summaryOf(section(V2))).toBe('Big \\| news.');
  });

  test('else the `###` kinds in page order, once each, the commit list left out', () => {
    expect(summaryOf(section(V1))).toBe('Fixed · Added');
    expect(summaryOf(section('## 1.0.0 - 2026-08-10\n\n- a bare bullet\n'))).toBe('—');
  });

  test('one row per release, newest first, linking its file', () => {
    const files = moveReleasedSections(INLINE, []).moved;
    expect(releaseTable(assembleChangelog(HEAD, files))).toEqual([
      '| Version | Date | Summary |',
      '|---|---|---|',
      '| [2.0.0](docs/changelog/2.0.0.md) | 2026-08-20 | Big \\| news. |',
      '| [1.0.0](docs/changelog/1.0.0.md) | 2026-08-10 | Fixed · Added |',
    ]);
  });
});

describe('unit · changelog-index · moving a release out of the index', () => {
  test('byte for byte: the files joined are the sections they came from', () => {
    const { index, moved, findings } = moveReleasedSections(INLINE, []);
    expect(findings).toEqual([]);
    expect(moved.map((file) => file.path)).toEqual([
      'docs/changelog/2.0.0.md',
      'docs/changelog/1.0.0.md',
    ]);
    expect(`${moved.map((file) => file.text).join('\n')}\n`).toBe(`${V2}\n${V1}\n`);
    expect(index).toBe(`${HEAD}${OLDER}`);
  });

  test('the table lands above Older releases, and rewriting it again changes nothing', () => {
    const { index, moved } = moveReleasedSections(INLINE, []);
    const written = withReleaseTable(index, assembleChangelog(index, moved));
    const headings = written.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toEqual(['## [Unreleased]', '## Releases', '## Older releases']);
    expect(withReleaseTable(written, assembleChangelog(written, moved))).toBe(written);
    expect(indexFindings(written, moved)).toEqual([]);
  });

  test('a version that already has its file is refused, never overwritten', () => {
    const held: ChangelogFile = { path: 'docs/changelog/2.0.0.md', text: V2 };
    const { moved, findings } = moveReleasedSections(INLINE, [held]);
    expect(moved.map((file) => file.path)).toEqual(['docs/changelog/1.0.0.md']);
    expect(findings.map((one) => [one.code, one.at])).toEqual([
      ['X_DOC_CHANGELOG_SECTION_INVALID', 'CHANGELOG.md:9'],
    ]);
  });
});

describe('unit · changelog-index · the findings', () => {
  const { index, moved } = moveReleasedSections(INLINE, []);
  const good = withReleaseTable(index, assembleChangelog(index, moved));
  const codes = (text: string, files: readonly ChangelogFile[]) =>
    indexFindings(text, files).map((one) => `${one.code} ${one.at}`);

  test('a release section written into the index is refused, naming its line', () => {
    const stray = good.replace('## Releases', '## 3.0.0 - 2026-09-01\n\n- new\n\n## Releases');
    expect(codes(stray, moved)).toContain('X_DOC_CHANGELOG_SECTION_INVALID CHANGELOG.md:9');
  });

  test('a file whose heading is not its name, or holds two sections, is refused', () => {
    const misnamed = [
      { path: 'docs/changelog/2.0.1.md', text: V2 },
      moved[1] ?? expect.unreachable(),
    ];
    expect(codes(good, misnamed)).toContain(
      'X_DOC_CHANGELOG_SECTION_INVALID docs/changelog/2.0.1.md:1',
    );
    const doubled = [{ path: 'docs/changelog/2.0.0.md', text: `${V2}\n${V1}` }];
    expect(codes(good, doubled)).toContain(
      'X_DOC_CHANGELOG_SECTION_INVALID docs/changelog/2.0.0.md:1',
    );
    expect(codes(good, [...moved, { path: 'docs/changelog/notes.md', text: V1 }])).toContain(
      'X_DOC_CHANGELOG_SECTION_INVALID docs/changelog/notes.md:1',
    );
  });

  test('a table row missing, stale or hand-edited is refused, and the fix rewrites it', () => {
    const stale = good.replace('Fixed · Added', 'Fixed');
    const [finding] = indexFindings(stale, moved);
    expect(finding?.at).toBe('CHANGELOG.md');
    expect(finding?.fix).toStartWith('bun run scripts/changelog-index.ts --write');
    expect(
      codes(good, [...moved, { path: 'docs/changelog/3.0.0.md', text: '## 3.0.0 - x\n\n- y\n' }]),
    ).toEqual(['X_DOC_CHANGELOG_SECTION_INVALID CHANGELOG.md']);
  });

  // Every rule downstream passes on an empty list: reading none is the failure, not a clean bill.
  test('no release file at all is refused, never read as a quiet changelog', () => {
    expect(codes(HEAD, [])).toEqual(['X_DOC_CHANGELOG_SECTION_INVALID docs/changelog/']);
  });
});

describe('the committed CHANGELOG.md and docs/changelog/', () => {
  test(
    'agree: no release in the index, one release per file, the table derived',
    async () => {
      const { index, files } = await readChangelogFiles(repoRoot());
      expect(files.length).toBeGreaterThan(100);
      expect(indexFindings(index, files)).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});

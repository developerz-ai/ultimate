// The two changelog rules wiki/Stability.md adds: from 30.0.0 every release section opens with
// `### Highlights` (at most five bullets), and once v31 has shipped a `BREAKING —` entry may not
// reach `main` while the major window is closed. Fixtures only; the real file is pinned last.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  breakingOnMainFindings,
  highlightFindings,
  releaseHighlights,
  targetBranch,
} from './changelog-highlights';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';

// Reads the real CHANGELOG.md, so the repo-scan guard holds it to the repo-scan backstop.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const log = (unreleased: string, ...sections: readonly string[]): string =>
  ['# Changelog', '', '## [Unreleased]', '', unreleased, '', ...sections].join('\n');
const HIGHLIGHTED =
  '## 30.0.0 - 2026-11-10\n\n### Highlights\n\n- one\n- two\n\n### Added\n\n- x\n';
// The window opens at v31 (wiki/Stability.md, the 2026-11-09 ruling): v30 starts no clock.
const V31 = '## 31.0.0 - 2026-11-10\n\n### Highlights\n\n- one\n\n### Removed\n\n- x\n';

describe('unit · changelog-highlights · every release from 30.0.0 opens with Highlights', () => {
  test('a highlighted section passes; a section below 30 is exempt; [Unreleased] is exempt', () => {
    expect(
      highlightFindings(log('### Added\n\n- y', HIGHLIGHTED, '## 29.4.0 - 2026-10-31\n\n- z\n')),
    ).toEqual([]);
  });

  test('a 30.x section without Highlights is refused, naming its line', () => {
    const [finding, ...rest] = highlightFindings(
      log('', '## 30.1.0 - 2026-11-20\n\n### Added\n\n- x\n'),
    );
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_CHANGELOG_HIGHLIGHTS_MISSING');
    expect(finding?.at).toBe('CHANGELOG.md:7');
  });

  test('Highlights that are not the first subsection, empty, or over five bullets are refused', () => {
    const late = '## 30.1.0 - 2026-11-20\n\n### Added\n\n- x\n\n### Highlights\n\n- y\n';
    const empty = '## 30.1.0 - 2026-11-20\n\n### Highlights\n\n### Added\n\n- x\n';
    const six = `## 30.1.0 - 2026-11-20\n\n### Highlights\n\n${'- a\n'.repeat(6)}`;
    for (const section of [late, empty, six]) {
      expect(highlightFindings(log('', section)).map((one) => one.code)).toEqual([
        'X_CHANGELOG_HIGHLIGHTS_MISSING',
      ]);
    }
  });

  test('the highlights a Release body carries are the bullets, verbatim', () => {
    expect(releaseHighlights(log('', HIGHLIGHTED), '30.0.0')).toEqual(['- one', '- two']);
    expect(releaseHighlights(log('', '## 29.4.0 - 2026-10-31\n\n- z\n'), '29.4.0')).toBeUndefined();
  });
});

describe('unit · changelog-highlights · a break never reaches main inside the window', () => {
  const breaking = '### Changed\n\n- **BREAKING — (#1) a thing goes.** detail';

  test('a PR to main with a BREAKING entry, after v31, inside the window, is refused', () => {
    const findings = breakingOnMainFindings({
      changelog: log(breaking, V31, HIGHLIGHTED),
      target: 'main',
      today: '2026-11-20',
    });
    expect(findings.map((one) => one.code)).toEqual(['X_BREAKING_ON_MAIN']);
    expect(findings[0]?.fix).toStartWith('git rebase --onto next main');
  });

  test('a break reaches main while the newest major is v30: v31 is where the breaks land', () => {
    expect(
      breakingOnMainFindings({
        changelog: log(breaking, HIGHLIGHTED),
        target: 'main',
        today: '2026-11-20',
      }),
    ).toEqual([]);
  });

  test('the same entry passes on next, before v31, once the window opens, or with an advisory', () => {
    const changelog = log(breaking, V31, HIGHLIGHTED);
    expect(breakingOnMainFindings({ changelog, target: 'next', today: '2026-11-20' })).toEqual([]);
    expect(breakingOnMainFindings({ changelog, target: undefined, today: '2026-11-20' })).toEqual(
      [],
    );
    expect(breakingOnMainFindings({ changelog, target: 'main', today: '2027-02-08' })).toEqual([]);
    expect(
      breakingOnMainFindings({
        changelog: log(breaking, '## 29.4.0 - 2026-10-31\n\n- z\n'),
        target: 'main',
        today: '2026-11-20',
      }),
    ).toEqual([]);
    expect(
      breakingOnMainFindings({
        changelog: log(`> **Security exception:** \`CVE-2026-1234\` — why\n\n${breaking}`, V31),
        target: 'main',
        today: '2026-11-20',
      }),
    ).toEqual([]);
  });

  test('the target is the PR base, else the pushed branch, else unknown', () => {
    expect(targetBranch({ GITHUB_BASE_REF: 'main', GITHUB_REF_NAME: '9/merge' })).toBe('main');
    expect(
      targetBranch({ GITHUB_BASE_REF: '', GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'next' }),
    ).toBe('next');
    expect(targetBranch({})).toBeUndefined();
  });
});

describe('the committed CHANGELOG.md', () => {
  test('every section from 30.0.0 carries its Highlights', async () => {
    const changelog = await Bun.file(`${repoRoot()}/CHANGELOG.md`).text();
    expect(highlightFindings(changelog)).toEqual([]);
  });
});

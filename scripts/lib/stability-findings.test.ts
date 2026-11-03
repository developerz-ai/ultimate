// The gate's half of wiki/Stability.md, as one host rule: a released major inside the window with
// no recorded advisory reds the gate on its own bump PR, beside the Highlights and main rules.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';
import {
  stabilityChangelogFindings,
  stabilityFindings,
  stabilityPageFindings,
  todayUtc,
  withNextWindowLine,
} from './stability-findings';

// Reads the real CHANGELOG.md, so the repo-scan guard holds it to the repo-scan backstop.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const log = (...sections: readonly string[]): string =>
  ['# Changelog', '', '## [Unreleased]', '', 'Nothing yet.', '', ...sections].join('\n');
const section = (heading: string): string => `## ${heading}\n\n### Highlights\n\n- one\n`;

describe('unit · stability-findings · the changelog rules, together', () => {
  test('a 31.0.0 section ten days after 30.0.0 is refused by the gate, not only by the bump', () => {
    const changelog = log(section('31.0.0 - 2026-11-20'), section('30.0.0 - 2026-11-10'));
    expect(stabilityChangelogFindings(changelog, {}, '2027-06-01').map((one) => one.code)).toEqual([
      'X_RELEASE_MAJOR_WINDOW',
    ]);
  });

  test('a released `## 31.1.0` opening the 31 line inside the window reds the gate too', () => {
    const changelog = log(section('31.1.0 - 2026-11-10'), section('30.0.0 - 2026-11-05'));
    expect(stabilityChangelogFindings(changelog, {}, '2027-06-01').map((one) => one.code)).toEqual([
      'X_RELEASE_MAJOR_WINDOW',
    ]);
  });

  test('each rule contributes: highlights, breaking on main', () => {
    const changelog = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '- **BREAKING — (#1) a thing goes.**',
      '',
      '## 30.1.0 - 2026-11-12\n\n- no highlights\n',
      section('30.0.0 - 2026-11-10'),
    ].join('\n');
    expect(
      stabilityChangelogFindings(changelog, { GITHUB_BASE_REF: 'main' }, '2026-11-20').map(
        (one) => one.code,
      ),
    ).toEqual(['X_CHANGELOG_HIGHLIGHTS_MISSING', 'X_BREAKING_ON_MAIN']);
  });
});

describe('unit · stability-findings · wiki/Stability.md states the next window', () => {
  const page = (line: string) => `# Stability\n\n**Next major window:** ${line}\n`;
  const after30 = log(section('30.0.0 - 2026-11-10'));
  const before30 = log('## 29.4.0 - 2026-10-31\n\n- z\n');

  test('after v30 the line names the date, derived from the 30.0.0 heading', () => {
    expect(stabilityPageFindings(page('opens on `2027-02-08`.'), after30)).toEqual([]);
    const [stale] = stabilityPageFindings(page('90 days after v30.'), after30);
    expect(stale?.code).toBe('X_DOC_RELEASE_FACT_STALE');
    expect(stale?.fix).toContain('`2027-02-08`');
  });

  test('before v30 the line names no date at all', () => {
    expect(stabilityPageFindings(page('90 days after v30.'), before30)).toEqual([]);
    expect(stabilityPageFindings(page('opens on `2027-02-08`.'), before30)).toHaveLength(1);
  });

  test('the bump writes the line the rule derives, so its own release PR is green', () => {
    const written = withNextWindowLine(page('90 days after v30.'), after30);
    expect(written).toContain('**Next major window:** opens on `2027-02-08`');
    expect(stabilityPageFindings(written, after30)).toEqual([]);
    expect(withNextWindowLine(written, after30)).toBe(written);
    expect(stabilityPageFindings(withNextWindowLine(page('x'), before30), before30)).toEqual([]);
  });

  test('a page with no such line is refused, never read as current', () => {
    expect(stabilityPageFindings('# Stability\n', after30).map((one) => one.code)).toEqual([
      'X_DOC_RELEASE_FACT_STALE',
    ]);
  });
});

// The changelog rules only: the deprecation rule reads a release tag, which after v30 can mean
// asking origin, and a unit suite never reaches the network. `deprecation-window.test.ts` owns it.
describe('the committed CHANGELOG.md and wiki/Stability.md', () => {
  test('hold every stability rule, wherever this branch is headed', async () => {
    const changelog = await Bun.file(`${repoRoot()}/CHANGELOG.md`).text();
    const page = await Bun.file(`${repoRoot()}/wiki/Stability.md`).text();
    expect([
      ...stabilityChangelogFindings(changelog, {}, '2026-11-03'),
      ...stabilityPageFindings(page, changelog),
    ]).toEqual([]);
  });

  test('the host rule is the changelog and page rules plus the deprecation window', async () => {
    const seen: string[] = [];
    const findings = await stabilityFindings(repoRoot(), {
      env: {},
      deprecations: async (root) => {
        seen.push(root);
        return [];
      },
    });
    expect({ findings, seen }).toEqual({ findings: [], seen: [repoRoot()] });
  });
});

describe('unit · stability-findings · today', () => {
  test('is the UTC calendar date, whatever the machine zone', () => {
    expect(todayUtc(new Date(Date.UTC(2026, 10, 3, 23, 59)))).toBe('2026-11-03');
  });
});

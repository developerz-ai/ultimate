// The gate's half of wiki/Stability.md, as one host rule: a released major inside the window with
// no recorded advisory reds the gate on its own bump PR, beside the Highlights and main rules.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { type Changelog, parseChangelog } from './changelog-sections';
import { loadChangelog } from './changelog-store';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';
import {
  stabilityChangelogFindings,
  stabilityFindings,
  stabilityPageFindings,
  todayUtc,
  withNextWindowLine,
} from './stability-findings';

// Reads the real changelog, so the repo-scan guard holds it to the repo-scan backstop.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const log = (...sections: readonly string[]): Changelog =>
  parseChangelog(
    ['# Changelog', '', '## [Unreleased]', '', 'Nothing yet.', '', ...sections].join('\n'),
  );
const section = (heading: string): string => `## ${heading}\n\n### Highlights\n\n- one\n`;

describe('unit · stability-findings · the changelog rules, together', () => {
  test('a 32.0.0 section ten days after 31.0.0 is refused by the gate, not only by the bump', () => {
    const changelog = log(section('32.0.0 - 2026-11-20'), section('31.0.0 - 2026-11-10'));
    expect(stabilityChangelogFindings(changelog, {}, '2027-06-01').map((one) => one.code)).toEqual([
      'X_RELEASE_MAJOR_WINDOW',
    ]);
  });

  test('a released `## 32.1.0` opening the 32 line inside the window reds the gate too', () => {
    const changelog = log(section('32.1.0 - 2026-11-10'), section('31.0.0 - 2026-11-05'));
    expect(stabilityChangelogFindings(changelog, {}, '2027-06-01').map((one) => one.code)).toEqual([
      'X_RELEASE_MAJOR_WINDOW',
    ]);
  });

  test('each rule contributes: highlights, breaking on main', () => {
    const changelog = parseChangelog(
      [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        '- **BREAKING — (#1) a thing goes.**',
        '',
        '## 31.1.0 - 2026-11-12\n\n- no highlights\n',
        section('31.0.0 - 2026-11-10'),
      ].join('\n'),
    );
    expect(
      stabilityChangelogFindings(changelog, { GITHUB_BASE_REF: 'main' }, '2026-11-20').map(
        (one) => one.code,
      ),
    ).toEqual(['X_CHANGELOG_HIGHLIGHTS_MISSING', 'X_BREAKING_ON_MAIN']);
  });
});

describe('unit · stability-findings · wiki/Stability.md states the next window', () => {
  const page = (line: string) => `# Stability\n\n**Next major window:** ${line}\n`;
  const after31 = log(section('31.0.0 - 2026-11-10'));
  // v30 opens no window (the 2026-11-09 ruling): the page names no date until v31 ships.
  const before31 = log(section('30.0.0 - 2026-11-07'));

  test('after v31 the line names the date, derived from the 31.0.0 heading', () => {
    expect(stabilityPageFindings(page('opens on `2027-02-08`.'), after31)).toEqual([]);
    const [stale] = stabilityPageFindings(page('90 days after v31.'), after31);
    expect(stale?.code).toBe('X_DOC_RELEASE_FACT_STALE');
    expect(stale?.fix).toContain('`2027-02-08`');
  });

  test('before v31 the line names no date at all', () => {
    expect(stabilityPageFindings(page('90 days after v31.'), before31)).toEqual([]);
    expect(stabilityPageFindings(page('opens on `2027-02-08`.'), before31)).toHaveLength(1);
  });

  test('the bump writes the line the rule derives, so its own release PR is green', () => {
    const written = withNextWindowLine(page('90 days after v31.'), after31);
    expect(written).toContain('**Next major window:** opens on `2027-02-08`');
    expect(stabilityPageFindings(written, after31)).toEqual([]);
    expect(withNextWindowLine(written, after31)).toBe(written);
    expect(stabilityPageFindings(withNextWindowLine(page('x'), before31), before31)).toEqual([]);
  });

  test('a page with no such line is refused, never read as current', () => {
    expect(stabilityPageFindings('# Stability\n', after31).map((one) => one.code)).toEqual([
      'X_DOC_RELEASE_FACT_STALE',
    ]);
  });
});

// The changelog rules only: the deprecation rule reads a release tag, which after v31 can mean
// asking origin, and a unit suite never reaches the network. `deprecation-window.test.ts` owns it.
describe('the committed changelog and wiki/Stability.md', () => {
  test('hold every stability rule, wherever this branch is headed', async () => {
    const changelog = await loadChangelog(repoRoot());
    const page = await Bun.file(`${repoRoot()}/wiki/Stability.md`).text();
    // Every rule here passes on an empty list: read none and the gate is green over nothing.
    expect(changelog.filter((one) => one.released).length).toBeGreaterThan(100);
    expect(changelog.filter((one) => one.body.startsWith('### Highlights')).length).toBeGreaterThan(
      10,
    );
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

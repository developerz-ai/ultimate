// The retired-workaround rule, against fixtures that break exactly one thing — then against the
// changelog this repository ships.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { SUPERSEDED_WORKAROUNDS } from '../packages/cli/src/superseded';
import { parseChangelog } from './changelog-check';
import {
  RETIRES_MARKER,
  WORKAROUND_UNTABLED,
  workaroundFinding,
  workaroundGaps,
} from './changelog-check-workarounds';
import { loadChangelog } from './lib/changelog-store';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const ROWS = [{ id: 'ssr-until-hole', shippedIn: '30.0.0' }];

const changelog = (line: string, heading = '30.0.0 - 2026-11-03') =>
  parseChangelog(`# Changelog\n\n## ${heading}\n\n### Added\n\n${line}\n`, 'docs/changelog/x.md');

describe('unit · a release note that retires a workaround', () => {
  test('a line naming a tabled row at the version that shipped it passes', () => {
    const notes = changelog('- `<Hole>`: retires the workaround `ssr-until-hole`.');
    expect(workaroundGaps(notes, ROWS)).toEqual([]);
  });

  test('a line naming an id the table does not hold is a gap', () => {
    const gaps = workaroundGaps(changelog('- x: retires the workaround `dev-no-tls`.'), ROWS);
    expect(gaps).toEqual([
      { kind: 'untabled', at: 'docs/changelog/x.md:7', id: 'dev-no-tls', version: '30.0.0' },
    ]);
  });

  test('the marker with no backticked id is a gap: the rule cannot find a row for nothing', () => {
    const gaps = workaroundGaps(changelog('- x: Retires the workaround of pinning ssr.'), ROWS);
    expect(gaps.map((gap) => gap.kind)).toEqual(['unnamed']);
  });

  test('a row whose shippedIn is not the section that retires it is a gap', () => {
    const notes = changelog('- retires the workaround `ssr-until-hole`', '31.0.0 - 2026-11-10');
    expect(workaroundGaps(notes, ROWS).map((gap) => gap.kind)).toEqual(['version']);
  });

  test('[Unreleased] has no version yet: the row need only exist', () => {
    const notes = changelog('- retires the workaround `ssr-until-hole`', '[Unreleased]');
    expect(workaroundGaps(notes, ROWS)).toEqual([]);
  });

  test('a line without the marker is never read', () => {
    expect(workaroundGaps(changelog('- a workaround `dev-no-tls` is gone'), ROWS)).toEqual([]);
  });

  test('each gap is the code, at its line, with a pasteable row as the fix', () => {
    const [gap] = workaroundGaps(changelog(`- ${RETIRES_MARKER} \`dev-no-tls\``), ROWS);
    if (gap === undefined) return expect.unreachable('the untabled id is a gap');
    const finding = workaroundFinding(gap);
    expect(finding.code).toBe(WORKAROUND_UNTABLED);
    expect(finding.at).toBe('docs/changelog/x.md:7');
    expect(finding.fix).toStartWith("{ id: 'dev-no-tls'");
    expect(finding.fix).toContain('packages/cli/src/superseded.ts');
  });
});

describe('unit · the shipped changelog', () => {
  test('every retired workaround it names is a row of the table', async () => {
    const gaps = workaroundGaps(await loadChangelog(repoRoot()), SUPERSEDED_WORKAROUNDS);
    expect(gaps).toEqual([]);
  });
});

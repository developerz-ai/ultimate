// The major window as `scripts/release.ts` applies it (wiki/Stability.md): a bump refused or let
// through by the dated changelog headings, and a major line that opens only at X.0.0. Split
// from `release.test.ts` at the size ceiling.

import { describe, expect, test } from 'bun:test';
import { parseChangelog } from './lib/changelog-sections';
import { bumpWindowFindings, readReleaseVersion } from './release';

// wiki/Stability.md: from v31, one major per 90 days (the 2026-11-09 ruling moved it from v30). The dates are the CHANGELOG.md headings the
// bump writes, so every case is a fixture, never the clock.
describe('unit · a major waits for its window', () => {
  const log = (...headings: readonly string[]) =>
    parseChangelog(
      [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        '- next',
        '',
        ...headings.map((h) => `## ${h}\n\n- x\n`),
      ].join('\n'),
    );
  const codes = (
    version: string,
    changelog: ReturnType<typeof log>,
    today: string,
    security?: string,
  ) => bumpWindowFindings({ version, changelog, today, security }).map((finding) => finding.code);

  test('v31 passes inside 90 days of v30: the clock starts there', () => {
    expect(
      codes('31.0.0', log('30.1.0 - 2026-11-20', '30.0.0 - 2026-11-07'), '2026-11-30'),
    ).toEqual([]);
  });

  test('v32 ten days after v31 refuses', () => {
    expect(codes('32.0.0', log('31.0.0 - 2026-11-30'), '2026-12-10')).toEqual([
      'X_RELEASE_MAJOR_WINDOW',
    ]);
  });

  test('with --security <advisory> it passes', () => {
    expect(
      codes('32.0.0', log('31.0.0 - 2026-11-30'), '2026-12-10', 'GHSA-2c8m-p4fq-w9xr'),
    ).toEqual([]);
  });

  test('90 days after v31 passes', () => {
    expect(codes('32.0.0', log('31.0.0 - 2026-11-30'), '2027-02-28')).toEqual([]);
  });

  test('--security on a bump that is not a major is refused by name', () => {
    expect(codes('31.1.0', log('31.0.0 - 2026-11-30'), '2026-12-10', 'CVE-2026-1234')).toEqual([
      'X_CLI_BAD_FLAG',
    ]);
  });
});

// Audit finding: `--version 31.1.0` from 30.x opened a major line at a minor, past the window rule.
describe('unit · a new major line opens at X.0.0', () => {
  test('--version that opens a major at anything but the next X.0.0 is refused', () => {
    for (const explicit of ['31.1.0', '31.0.1', '32.0.0']) {
      const result = readReleaseVersion({ explicit, bump: undefined, current: '30.2.0' });
      const codes = 'findings' in result ? result.findings.map((one) => one.code) : [];
      expect({ explicit, codes }).toEqual({
        explicit,
        codes: ['X_RELEASE_VERSION_INVALID'],
      });
    }
    expect(readReleaseVersion({ explicit: '31.0.0', bump: undefined, current: '30.2.0' })).toEqual({
      version: '31.0.0',
    });
  });
});

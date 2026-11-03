// The major window as `scripts/release.ts` applies it (wiki/Stability.md): a bump refused or let
// through by the dated CHANGELOG.md headings, and a major line that opens only at X.0.0. Split
// from `release.test.ts` at the size ceiling.

import { describe, expect, test } from 'bun:test';
import { bumpWindowFindings, readReleaseVersion } from './release';

// wiki/Stability.md: from v30, one major per 90 days. The dates are the CHANGELOG.md headings the
// bump writes, so every case is a fixture, never the clock.
describe('unit · a major waits for its window', () => {
  const log = (...headings: readonly string[]): string =>
    [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '- next',
      '',
      ...headings.map((h) => `## ${h}\n\n- x\n`),
    ].join('\n');
  const codes = (version: string, changelog: string, today: string, security?: string) =>
    bumpWindowFindings({ version, changelog, today, security }).map((finding) => finding.code);

  test('v30 passes: the clock starts there', () => {
    expect(
      codes('30.0.0', log('29.4.0 - 2026-10-31', '29.0.0 - 2026-10-25'), '2026-11-04'),
    ).toEqual([]);
  });

  test('v31 ten days after v30 refuses', () => {
    expect(codes('31.0.0', log('30.0.0 - 2026-11-10'), '2026-11-20')).toEqual([
      'X_RELEASE_MAJOR_WINDOW',
    ]);
  });

  test('with --security <advisory> it passes', () => {
    expect(
      codes('31.0.0', log('30.0.0 - 2026-11-10'), '2026-11-20', 'GHSA-2c8m-p4fq-w9xr'),
    ).toEqual([]);
  });

  test('91 days after v30 passes', () => {
    expect(codes('31.0.0', log('30.0.0 - 2026-11-10'), '2027-02-09')).toEqual([]);
  });

  test('--security on a bump that is not a major is refused by name', () => {
    expect(codes('30.1.0', log('30.0.0 - 2026-11-10'), '2026-11-20', 'CVE-2026-1234')).toEqual([
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

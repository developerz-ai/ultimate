// The major window, against fixture changelogs: v30 opens the clock and is never refused, a major
// inside 90 days of the previous one is, a recorded advisory lets one through, and the date a
// window opens on is derived from the dated section heading, never kept by hand.

import { describe, expect, test } from 'bun:test';
import {
  addDays,
  majorWindowFindings,
  nextMajorWindow,
  recordedException,
  refuseOutsideWindow,
  securityLines,
  withSecurityException,
} from './major-window';

const changelog = (...sections: readonly string[]): string =>
  ['# Changelog', '', '## [Unreleased]', '', 'Nothing yet.', '', ...sections].join('\n');
const V30 = '## 30.0.0 - 2026-11-10\n\n### Highlights\n\n- one major\n';
const V29 = '## 29.0.0 - 2026-10-25\n\n- a floor\n';

describe('unit · major-window · the 90-day rule', () => {
  test('v30 passes even ten days after v29: the clock starts there', () => {
    expect(
      majorWindowFindings({ version: '30.0.0', changelog: changelog(V29), today: '2026-11-04' }),
    ).toEqual([]);
  });

  test('v31 ten days after v30 is refused, naming the date the window opens', () => {
    const [finding, ...rest] = majorWindowFindings({
      version: '31.0.0',
      changelog: changelog(V30, V29),
      today: '2026-11-20',
    });
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_RELEASE_MAJOR_WINDOW');
    expect(finding?.cause).toContain('10 day(s) after 30.0.0');
    expect(finding?.cause).toContain('2027-02-08');
    expect(finding?.fix).toStartWith('bun run scripts/release.ts --bump major --security ');
  });

  test('a valid advisory id lets a major through inside the window', () => {
    expect(
      majorWindowFindings({
        version: '31.0.0',
        changelog: changelog(V30),
        today: '2026-11-20',
        security: 'GHSA-2c8m-p4fq-w9xr',
      }),
    ).toEqual([]);
  });

  test('an id that is no advisory is refused, not recorded', () => {
    const findings = majorWindowFindings({
      version: '31.0.0',
      changelog: changelog(V30),
      today: '2026-11-20',
      security: 'urgent',
    });
    expect(findings.map((finding) => finding.code)).toEqual(['X_RELEASE_MAJOR_WINDOW']);
    expect(findings[0]?.cause).toContain('is not a GitHub advisory or CVE id');
  });

  test('90 days opens the window, 91 is past it, 89 is not', () => {
    const at = (today: string) =>
      majorWindowFindings({ version: '31.0.0', changelog: changelog(V30), today }).length;
    expect(at(addDays('2026-11-10', 89))).toBe(1);
    expect(at(addDays('2026-11-10', 90))).toBe(0);
    expect(at(addDays('2026-11-10', 91))).toBe(0);
  });

  test('minors, patches and prereleases are never windowed', () => {
    for (const version of ['30.1.0', '30.0.1', '31.0.0-next.1']) {
      expect(
        majorWindowFindings({ version, changelog: changelog(V30), today: '2026-11-11' }),
      ).toEqual([]);
    }
  });

  test('a major above 30 with no dated major below it is refused, never assumed open', () => {
    const findings = majorWindowFindings({
      version: '31.0.0',
      changelog: changelog('## 30.0.0\n\n- undated\n'),
      today: '2027-06-01',
    });
    expect(findings.map((finding) => finding.code)).toEqual(['X_RELEASE_MAJOR_WINDOW']);
  });

  test('a released section is judged by its own date and its own recorded advisory', () => {
    const v31 = '## 31.0.0 - 2026-11-20\n\n### Highlights\n\n- fast\n';
    expect(
      majorWindowFindings({
        version: '31.0.0',
        changelog: changelog(v31, V30),
        today: '2027-09-01',
      }),
    ).toHaveLength(1);
    const excused = withSecurityException(changelog(v31, V30), '31.0.0', 'CVE-2026-12345');
    expect(recordedException(excused, '31.0.0')).toBe('CVE-2026-12345');
    expect(
      majorWindowFindings({ version: '31.0.0', changelog: excused, today: '2027-09-01' }),
    ).toEqual([]);
  });
});

describe('unit · major-window · when the next window opens', () => {
  test('the newest major from 30 on, plus 90 days', () => {
    expect(nextMajorWindow(changelog(V30, V29))).toEqual({
      after: '30.0.0',
      on: '2026-11-10',
      opensOn: '2027-02-08',
    });
  });

  test('no window before v30 ships', () => {
    expect(nextMajorWindow(changelog(V29))).toBeUndefined();
  });

  test('the recorded line sits under the heading, once, and never in another section', () => {
    const once = withSecurityException(changelog(V30, V29), '30.0.0', 'CVE-2026-1');
    expect(withSecurityException(once, '30.0.0', 'CVE-2026-1')).toBe(once);
    expect(recordedException(once, '29.0.0')).toBeUndefined();
    expect(once).toContain('Security exception');
    expect(once).toContain('### Highlights');
    expect(once).toContain('## 30.0.0');
    expect(once.indexOf('Security exception')).toBeGreaterThan(once.indexOf('## 30.0.0'));
    expect(once.indexOf('Security exception')).toBeLessThan(once.indexOf('### Highlights'));
  });
});

describe('unit · major-window · what the bump prints', () => {
  test('no finding is no refusal: the bump carries on', () => {
    expect(refuseOutsideWindow([], { version: '30.0.0', current: '29.4.0' }, true)).toBeUndefined();
  });

  test('a --security bump says where the advisory went and what the commit owes', () => {
    expect(securityLines('31.0.0', undefined)).toEqual([]);
    expect(securityLines('31.0.0', 'CVE-2026-1234')).toEqual([
      '  security  CVE-2026-1234 recorded under "## 31.0.0"; the commit body carries "Security-Exception: CVE-2026-1234"',
    ]);
    expect(withSecurityException('# Changelog\n', '31.0.0', undefined)).toBe('# Changelog\n');
  });
});

// Audit finding: a major line opened at anything but X.0.0 (`--version 31.1.0` cut from 30.x)
// bypassed the window, because only an exact X.0.0 was read as a major.
describe('unit · major-window · a major is the first release of a new major line', () => {
  const V30_5 = '## 30.0.0 - 2026-11-05\n\n### Highlights\n\n- one\n';

  test('31.1.0 and 31.0.1 opening the 31 line inside the window are refused', () => {
    for (const version of ['31.1.0', '31.0.1']) {
      expect(
        majorWindowFindings({ version, changelog: changelog(V30_5), today: '2026-11-10' }).map(
          (one) => one.code,
        ),
      ).toEqual(['X_RELEASE_MAJOR_WINDOW']);
    }
  });

  test('a released `## 31.1.0` opening its line is judged by its own date', () => {
    const v31 = '## 31.1.0 - 2026-11-10\n\n### Highlights\n\n- fast\n';
    expect(
      majorWindowFindings({
        version: '31.1.0',
        changelog: changelog(v31, V30_5),
        today: '2027-09-01',
      }),
    ).toHaveLength(1);
  });

  test('a later release in an open line is a minor, never windowed', () => {
    const v31 = '## 31.0.0 - 2027-02-03\n\n### Highlights\n\n- ok\n';
    expect(
      majorWindowFindings({
        version: '31.1.0',
        changelog: changelog(v31, V30_5),
        today: '2027-02-04',
      }),
    ).toEqual([]);
  });

  test('the next window counts from the first release of the newest line', () => {
    const v30_1 = '## 30.1.0 - 2026-11-20\n\n### Highlights\n\n- minor\n';
    expect(nextMajorWindow(changelog(v30_1, V30_5))?.after).toBe('30.0.0');
  });
});

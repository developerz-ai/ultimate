// The maintenance windows, against fixture changelogs: each major from v30 is maintained for six
// calendar months from the day its successor's X.0.0 shipped, read off the dated section headings,
// never kept by hand — v30's closes on 2027-05-10 because 31.0.0 is dated 2026-11-10.

import { describe, expect, test } from 'bun:test';
import { type Changelog, parseChangelog } from './changelog-sections';
import {
  addMonths,
  cutBranchCommand,
  distTagCommand,
  lastTagOfMajor,
  MAINT_FROM_MAJOR,
  maintWindows,
  newestOfMajor,
  windowOpen,
} from './release-maint';

const changelog = (...sections: readonly string[]): Changelog =>
  parseChangelog(['# Changelog', '', '## [Unreleased]', '', ...sections].join('\n'));
const V31_1 = '## 31.1.0 - 2026-11-12\n\n- more\n';
const V31 = '## 31.0.0 - 2026-11-10\n\n- the opener\n';
const V30_9 = '## 30.9.0 - 2026-11-09\n\n- last of 30\n';
const V30 = '## 30.0.0 - 2026-11-07\n\n- a floor\n';
const V29 = '## 29.0.0 - 2026-10-01\n\n- before the promise\n';

describe('unit · release-maint · addMonths', () => {
  test('calendar months in UTC, the day clamped to the month end', () => {
    expect(addMonths('2026-11-10', 6)).toBe('2027-05-10');
    expect(addMonths('2026-08-31', 6)).toBe('2027-02-28');
    expect(addMonths('2027-08-31', 6)).toBe('2028-02-29');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
  });
});

describe('unit · release-maint · maintWindows', () => {
  test('30 is maintained from 31.0.0 until six months after it: 2027-05-10, derived', () => {
    expect(maintWindows(changelog(V31_1, V31, V30_9, V30, V29))).toEqual([
      {
        major: 30,
        branch: 'release/30.x',
        distTag: 'maint-30',
        successor: '31.0.0',
        opensOn: '2026-11-10',
        closesOn: '2027-05-10',
      },
    ]);
  });

  test('the date moves with the heading: no date is kept by hand', () => {
    const moved = '## 31.0.0 - 2026-12-01\n\n- the opener\n';
    expect(maintWindows(changelog(moved, V30))[0]?.closesOn).toBe('2027-06-01');
  });

  test('a major before v30 was never promised a window, and the current major has none yet', () => {
    expect(MAINT_FROM_MAJOR).toBe(30);
    expect(maintWindows(changelog(V30, V29))).toEqual([]);
  });

  test('a successor that opened at X.1.0 opens the window the same as X.0.0 would', () => {
    expect(maintWindows(changelog(V31_1, V30_9))[0]).toMatchObject({
      major: 30,
      successor: '31.1.0',
      opensOn: '2026-11-12',
    });
  });

  test('every major past 30 gets its own window, newest first', () => {
    const v32 = '## 32.0.0 - 2027-02-10\n\n- next\n';
    expect(maintWindows(changelog(v32, V31, V30)).map((window) => window.major)).toEqual([31, 30]);
  });
});

describe('unit · release-maint · windowOpen', () => {
  const [window] = maintWindows(changelog(V31, V30));
  test('open from the successor date through the closing date, inclusive; closed after', () => {
    if (window === undefined) return expect.unreachable('the fixture opens a window');
    expect(windowOpen(window, '2026-11-09')).toBe(false);
    expect(windowOpen(window, '2026-11-10')).toBe(true);
    expect(windowOpen(window, '2027-05-10')).toBe(true);
    expect(windowOpen(window, '2027-05-11')).toBe(false);
  });
});

describe('unit · release-maint · what the lane is cut from', () => {
  test('newestOfMajor is semver order over one major, prereleases out', () => {
    expect(newestOfMajor(['30.9.0', '30.10.0', '30.2.1', '31.0.0', '30.11.0-rc.1'], 30)).toBe(
      '30.10.0',
    );
    expect(newestOfMajor(['30.9.0', '30.9.2', '30.9.10'], 30)).toBe('30.9.10');
    expect(newestOfMajor(['31.0.0'], 30)).toBeUndefined();
  });

  test('lastTagOfMajor names the commit an annotated tag peels to, never the tag object', () => {
    const lsRemote = [
      'aaa\trefs/tags/v30.8.0',
      'bbb\trefs/tags/v30.9.0',
      'ccc\trefs/tags/v30.9.0^{}',
      'ddd\trefs/tags/v31.0.0',
      'eee\trefs/tags/v31.0.0^{}',
    ].join('\n');
    expect(lastTagOfMajor(lsRemote, 30)).toEqual({ tag: 'v30.9.0', version: '30.9.0', sha: 'ccc' });
    expect(lastTagOfMajor(lsRemote, 29)).toBeUndefined();
    // Whatever order the lines come in, the peeled commit wins over the tag object.
    expect(lastTagOfMajor('ccc\trefs/tags/v30.9.0^{}\nbbb\trefs/tags/v30.9.0', 30)?.sha).toBe(
      'ccc',
    );
    // A lightweight tag has no peeled line: its own object is the commit.
    expect(lastTagOfMajor('fff\trefs/tags/v30.1.0', 30)?.sha).toBe('fff');
  });

  test('the two writes: a branch through the API at the commit, a dist-tag at a held version', () => {
    const [window] = maintWindows(changelog(V31, V30));
    if (window === undefined) return expect.unreachable('the fixture opens a window');
    expect(cutBranchCommand(window, 'ccc').join(' ')).toBe(
      'gh api repos/{owner}/{repo}/git/refs -f ref=refs/heads/release/30.x -f sha=ccc',
    );
    expect(distTagCommand('@ultimat3/core', '30.9.0', 'maint-30').join(' ')).toBe(
      'npm dist-tag add @ultimat3/core@30.9.0 maint-30',
    );
  });
});

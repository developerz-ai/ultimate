// The release subjects, one per reader: a commit subject — or release PR title —
// `RELEASE_SUBJECT`, an ask title `ASK_SUBJECT` and the pending-major issue title
// `MAJOR_ISSUE_SUBJECT`. A release is a whole version in every form, and a subject that only
// starts like one is not, nor one that reads as another's. `askTwin` and `prTwin` are those
// dedupes over open rows: exactly one title wins, and the whole {number,title} row comes back.

import { describe, expect, test } from 'bun:test';
import {
  ASK_SUBJECT,
  askIssueArgs,
  askPrArgs,
  askTwin,
  MAJOR_ISSUE_SUBJECT,
  majorIssueArgs,
  majorIssueTitle,
  openMajorIssue,
  openReleaseBump,
  parsePrIssues,
  prTwin,
  RELEASE_SUBJECT,
} from './release-subject';

describe('unit · release-subject', () => {
  test('both forms this repo has committed releases under match', () => {
    for (const subject of [
      'chore: release 27.10.1 (#770)',
      'chore(release): release 1.0.0',
      'release: 6.0.0',
      'release: 6.0.0 (#12)',
    ]) {
      expect({ subject, release: RELEASE_SUBJECT.test(subject) }).toEqual({
        subject,
        release: true,
      });
    }
  });

  test('a subject that is not a whole version is not a release', () => {
    for (const subject of [
      'release: 6blah',
      'release: 6.0.0-rc.1',
      'release: 6.0.0.1',
      'chore: release 27.10.1-beta (#9)',
      'release: 6',
      'release: 6.0',
      'chore: release notes wording',
      'chore: release 27.10',
      'fix(release): the release script',
      'docs: release: 6.0.0',
    ]) {
      expect({ subject, release: RELEASE_SUBJECT.test(subject) }).toEqual({
        subject,
        release: false,
      });
    }
  });

  test('the ask title the release-due brief files matches', () => {
    for (const title of ['Release 27.10.1', 'Release 1.0.0', 'Release 0.0.1', 'Release 6.0.0 ']) {
      expect({ title, ask: ASK_SUBJECT.test(title) }).toEqual({ title, ask: true });
    }
  });

  test('a failed-publish issue the dedupe would mistake for an open ask is not one', () => {
    for (const title of [
      'Release failed: 27.10.1',
      'Release 27.10.1 failed to publish',
      'Release 27.10.1 (#1)',
      'release 27.10.1',
      'Release 27.10.1-beta',
      'Release 27.10.1.1',
      'Release 27.10',
      'Release: 27.10.1',
      'Release X.Y.Z',
    ]) {
      expect({ title, ask: ASK_SUBJECT.test(title) }).toEqual({ title, ask: false });
    }
  });

  test('neither matcher accepts the other reader’s subject', () => {
    for (const subject of [
      'chore: release 27.10.1 (#770)',
      'chore(release): release 1.0.0',
      'release: 6.0.0',
    ]) {
      expect({ subject, ask: ASK_SUBJECT.test(subject) }).toEqual({ subject, ask: false });
    }
    for (const title of ['Release 27.10.1', 'Release 1.0.0']) {
      expect({ title, release: RELEASE_SUBJECT.test(title) }).toEqual({ title, release: false });
    }
  });
});

describe('unit · release-subject · askTwin', () => {
  test('the open issue titled exactly `Release <version>` is the twin, number and all', () => {
    expect(askTwin([{ number: 813, title: 'Release 27.10.1' }], '27.10.1')).toEqual({
      number: 813,
      title: 'Release 27.10.1',
    });
  });

  test('every failed-publish title is no twin', () => {
    for (const title of [
      'Release 27.10.1 failed to publish',
      'Release 27.10.1-beta',
      'Release 27.10',
      'Release 27.10.1 (#1)',
      'release 27.10.1',
    ]) {
      expect(askTwin([{ number: 813, title }], '27.10.1')).toBeUndefined();
    }
  });

  test('an ask for a different version is not a twin, even one that starts with it', () => {
    // `Release 27.10.10` starts with `27.10.1` and is still a different release.
    expect(askTwin([{ number: 814, title: 'Release 27.10.10' }], '27.10.1')).toBeUndefined();
    expect(askTwin([{ number: 815, title: 'Release 1.0.0' }], '27.10.1')).toBeUndefined();
  });

  test('no open issues, no twin', () => {
    expect(askTwin([], '27.10.1')).toBeUndefined();
  });
});

describe('unit · release-subject · the ask query', () => {
  test("the query is the brief's open-issue list, over number,title rows", () => {
    const args = askIssueArgs('27.10.1');
    expect(args[args.indexOf('--state') + 1]).toBe('open');
    expect(args[args.indexOf('--search') + 1]).toBe('Release 27.10.1 in:title');
    expect(args[args.indexOf('--json') + 1]).toBe('number,title');
  });

  // The two open-issue subjects have their OWN searches: one list could not serve both, because
  // the pending-major search never returns an ask title and the ask search never returns one.
  test('the ask query is not the pending-major one: the two subjects stay disjoint', () => {
    expect(askIssueArgs('28.0.0').includes('Major release pending: 28.0.0 in:title')).toBe(false);
  });
});

describe('unit · release-subject · the pending-major issue', () => {
  test('the title the brief files is exactly `Major release pending: <version>`', () => {
    expect(majorIssueTitle('28.0.0')).toBe('Major release pending: 28.0.0');
    expect(majorIssueTitle('1.0.0')).toBe('Major release pending: 1.0.0');
  });

  test('the matcher accepts that title and nothing near it', () => {
    for (const title of ['Major release pending: 28.0.0', 'Major release pending: 1.0.0 ']) {
      expect({ title, major: MAJOR_ISSUE_SUBJECT.test(title) }).toEqual({ title, major: true });
    }
    for (const title of [
      // No version at all.
      'Major release pending',
      'Major release pending:',
      // Trailing prose: the version is the whole title.
      'Major release pending: 28.0.0 (dup)',
      'Major release pending: 28.0.0 for a maintainer',
      // Another subject entirely.
      'Release 28.0.0',
      'Major release pending 28.0.0',
      'major release pending: 28.0.0',
    ]) {
      expect({ title, major: MAJOR_ISSUE_SUBJECT.test(title) }).toEqual({ title, major: false });
    }
  });

  test("the query is the brief's open-issue list, over number,title rows", () => {
    const args = majorIssueArgs('28.0.0');
    expect(args[args.indexOf('--state') + 1]).toBe('open');
    expect(args[args.indexOf('--search') + 1]).toBe('Major release pending: 28.0.0 in:title');
    expect(args[args.indexOf('--json') + 1]).toBe('number,title');
  });

  test('the exact title of the target version is the twin', () => {
    expect(openMajorIssue(['Major release pending: 28.0.0'], '28.0.0')).toEqual({
      open: true,
      twin: 'Major release pending: 28.0.0',
    });
  });

  test("another version's issue is not a twin, and a longer version is not one either", () => {
    // `28.0.01` starts with `28.0.0` and is still a different major.
    expect(openMajorIssue(['Major release pending: 28.0.01'], '28.0.0')).toEqual({ open: false });
    expect(openMajorIssue(['Major release pending: 29.0.0'], '28.0.0')).toEqual({ open: false });
    expect(openMajorIssue(['Major release pending: 28.0.0'], '28.0.1')).toEqual({ open: false });
  });

  test('the ask title is not a pending-major twin: the two subjects stay disjoint', () => {
    expect(openMajorIssue(['Release 28.0.0'], '28.0.0')).toEqual({ open: false });
  });

  test('no open issues is not open', () => {
    expect(openMajorIssue([], '28.0.0')).toEqual({ open: false });
  });
});

describe('unit · release-subject · the bump-PR twin', () => {
  test('the query is the release-due query over number,title rows, open PRs only', () => {
    const args = askPrArgs('27.10.1');
    expect(args[args.indexOf('--state') + 1]).toBe('open');
    expect(args[args.indexOf('--search') + 1]).toBe('release 27.10.1 in:title');
    expect(args[args.indexOf('--json') + 1]).toBe('number,title');
  });

  test('every release-PR title this repo has used is the twin', () => {
    for (const title of ['chore: release 27.10.1', 'chore: release 27.10.1 (#770)']) {
      expect({ title, ...openReleaseBump([title], '27.10.1') }).toEqual({
        title,
        open: true,
        twin: title,
      });
    }
    // What `scripts/release.ts` commits were titled before the conventional-commit prefix.
    expect(openReleaseBump(['release: 6.0.0'], '6.0.0')).toEqual({
      open: true,
      twin: 'release: 6.0.0',
    });
  });

  test('a PR that is not a release subject is no twin', () => {
    for (const title of [
      'docs: a thing',
      'chore: release notes wording',
      'chore: release 27.10',
      'chore: release 27.10.1-beta (#9)',
      'fix(core): release 27.10.1',
    ]) {
      expect({ title, ...openReleaseBump([title], '27.10.1') }).toEqual({ title, open: false });
    }
  });

  // The search is case-insensitive, so it hands back ask titles too. They must not read as twins.
  test('an ask title is not a bump twin: the two readers stay disjoint', () => {
    expect(openReleaseBump(['Release 27.10.1'], '27.10.1')).toEqual({ open: false });
    expect(openReleaseBump(['release 27.10.1'], '27.10.1')).toEqual({ open: false });
  });

  test('a longer version that starts with the target is not a twin: 27.10.10 ≠ 27.10.1', () => {
    expect(openReleaseBump(['chore: release 27.10.10'], '27.10.1')).toEqual({ open: false });
    expect(openReleaseBump(['chore: release 1.0.0'], '27.10.1')).toEqual({ open: false });
  });

  test('no open PRs is not open', () => {
    expect(openReleaseBump([], '27.10.1')).toEqual({ open: false });
  });

  test('rows in, PRs out; a malformed row drops and a string number is not the row promised', () => {
    expect(parsePrIssues('[{"number":812,"title":"chore: release 1.0.1"}]')).toEqual([
      { number: 812, title: 'chore: release 1.0.1' },
    ]);
    expect(parsePrIssues('[{"number":812,"title":"chore: release 1.0.1"},{"oops":true}]')).toEqual([
      { number: 812, title: 'chore: release 1.0.1' },
    ]);
    // A string number is not the row the CLI promised.
    expect(parsePrIssues('[{"number":"812","title":"chore: release 1.0.1"}]')).toEqual([]);
  });

  test('anything but the rows is no PR at all — the lookup is best effort', () => {
    expect(parsePrIssues('gh: (NotFound) …')).toEqual([]);
    expect(parsePrIssues('')).toEqual([]);
    expect(parsePrIssues('{"number":812,"title":"chore: release 1.0.1"}')).toEqual([]);
    expect(parsePrIssues('[{}]')).toEqual([]);
  });

  test('prTwin returns the whole row whose title won, and nothing else', () => {
    expect(prTwin([{ number: 812, title: 'chore: release 27.10.1 (#770)' }], '27.10.1')).toEqual({
      number: 812,
      title: 'chore: release 27.10.1 (#770)',
    });
    expect(prTwin([{ number: 813, title: 'Release 27.10.1' }], '27.10.1')).toBeUndefined();
    expect(prTwin([{ number: 814, title: 'chore: release 27.10.10' }], '27.10.1')).toBeUndefined();
    expect(prTwin([], '27.10.1')).toBeUndefined();
  });
});

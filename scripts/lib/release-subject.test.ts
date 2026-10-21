// The two release subjects, one per reader: a commit subject `RELEASE_SUBJECT`, an ask title
// `ASK_SUBJECT`. A release is a whole version in either form, and a subject that only starts like one
// is not — nor is one that reads as the other's. `askTwin` is that dedupe over open issue rows:
// exactly one title wins, and the whole {number,title} row comes back.

import { describe, expect, test } from 'bun:test';
import { ASK_SUBJECT, askTwin, RELEASE_SUBJECT } from './release-subject';

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

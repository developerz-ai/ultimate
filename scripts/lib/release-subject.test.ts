// The release-commit subject both `release-due.ts` and `deploy-proof-due.ts` read: a release is a
// whole version in either form, and a subject that only starts like one is not.

import { describe, expect, test } from 'bun:test';
import { RELEASE_SUBJECT } from './release-subject';

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
});

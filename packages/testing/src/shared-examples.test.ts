// A shared block has to run once per subject, see the CURRENT subject each time, and report under
// a name that says which subject failed. These assert all three by running real nested tests.

import { beforeAll, describe, expect, test } from 'bun:test';
import { behavesLike, sharedExamples } from './shared-examples';
import { testName } from './test-types';

interface Denier {
  readonly name: string;
  denies(role: string): boolean;
}

const anAuthenticatedAction = sharedExamples<Denier>('an authenticated action', (subject) => {
  test('denies an anonymous actor', () => {
    expect(subject().denies('anonymous')).toBe(true);
  });

  test('admits a member', () => {
    expect(subject().denies('member')).toBe(false);
  });
});

const publishPost: Denier = { name: 'publishPost', denies: (role) => role === 'anonymous' };
const deletePost: Denier = { name: 'deletePost', denies: (role) => role !== 'member' };

// The point of the whole file: one rule, written once, holding two subjects. A third action that
// forgot to deny anonymous is one line away from being caught.
describe(testName('unit', 'publishPost'), () => {
  behavesLike(anAuthenticatedAction, () => publishPost);
});

describe(testName('unit', 'deletePost'), () => {
  behavesLike(anAuthenticatedAction, () => deletePost);
});

// A value parameter would have frozen the subject at declaration time, which is exactly the case a
// `beforeAll`-built subject hits: the block below is registered while `late` is still 'before'.
let late = 'before';

const aLateSubject = sharedExamples<string>('a late subject', (subject) => {
  test('reads the subject the beforeAll installed, not the one at declaration', () => {
    expect(subject()).toBe('installed');
  });
});

describe(testName('unit', 'a subject built in beforeAll'), () => {
  beforeAll(() => {
    late = 'installed';
  });
  behavesLike(aLateSubject, () => late);
});

let runs = 0;
const aCountedSubject = sharedExamples<number>('a counted subject', () => {
  runs += 1;
});

// Two uses, registered before the assertion below runs — `behavesLike` calls `describe`, so it
// belongs at declaration scope and never inside a test body.
behavesLike(aCountedSubject, () => 1);
behavesLike(aCountedSubject, () => 2);

describe(testName('unit', 'sharedExamples'), () => {
  test('keeps its name for the describe wrapper to use', () => {
    expect(anAuthenticatedAction.name).toBe('an authenticated action');
  });

  test('the body runs once per behavesLike call', () => {
    expect(runs).toBe(2);
  });
});

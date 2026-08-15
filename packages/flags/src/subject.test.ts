// A subject is what a flag decides ABOUT. The tests that must be able to fail are the resolution
// ones: a kind the evaluation context does not carry has to raise, because the alternative — a
// fallback to the actor, or to the declared default — is an answer that looks like it worked.

import { describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import type { FlagSubjects } from './subject';
import { BUILT_IN_SUBJECT_KINDS, subjectIdOf } from './subject';

const caught = (run: () => unknown): unknown => {
  try {
    run();
  } catch (thrown) {
    return thrown;
  }
  return undefined;
};

const actor = userActor({ id: 'user-1', orgId: 'org-a' });

describe('unit · subjectIdOf', () => {
  test('resolves the two built-in kinds off the actor, which already carries both', () => {
    expect(
      subjectIdOf({ key: 'a.flag', kind: 'actor', actor, subjects: undefined, via: 'orgs' }),
    ).toBe('user-1');
    expect(
      subjectIdOf({ key: 'a.flag', kind: 'org', actor, subjects: undefined, via: 'orgs' }),
    ).toBe('org-a');
  });

  test('resolves an app kind from the subjects passed at the call site', () => {
    const subjects = { bank: 'bank_integration:bbva' };
    expect(subjectIdOf({ key: 'a.flag', kind: 'bank', actor, subjects, via: 'subjects' })).toBe(
      'bank_integration:bbva',
    );
  });

  test('throws naming the missing kind when the context does not carry it', () => {
    const thrown = caught(() =>
      subjectIdOf({ key: 'a.flag', kind: 'bank', actor, subjects: {}, via: 'subjects' }),
    );
    expect(thrown).toBeUltimateError('X_FLAG_SUBJECT_REQUIRED');
    expect((thrown as { cause: string }).cause).toContain('bank');
  });

  test('throws when the actor carries no orgId, rather than answering off the actor id', () => {
    expect(
      caught(() =>
        subjectIdOf({
          key: 'a.flag',
          kind: 'org',
          actor: userActor({ id: 'user-2' }),
          subjects: undefined,
          via: 'orgs',
        }),
      ),
    ).toBeUltimateError('X_FLAG_SUBJECT_REQUIRED');
  });

  test('an empty id is absent, not a subject — it would otherwise hash to a real bucket', () => {
    expect(
      caught(() =>
        subjectIdOf({
          key: 'a.flag',
          kind: 'bank',
          actor,
          subjects: { bank: '' },
          via: 'subjects',
        }),
      ),
    ).toBeUltimateError('X_FLAG_SUBJECT_REQUIRED');
  });

  test('a built-in kind is never read from the map — the actor is its one source', () => {
    // Passing `org` at the call site is dead data, not a second way to supply the tenant. It
    // cannot produce a wrong answer: with no `actor.orgId` this raises, and the fix line says so.
    const thrown = caught(() =>
      subjectIdOf({
        key: 'a.flag',
        kind: 'org',
        actor: userActor({ id: 'user-2' }),
        subjects: { org: 'org-z' },
        via: 'orgs',
      }),
    );
    expect(thrown).toBeUltimateError('X_FLAG_SUBJECT_REQUIRED');
  });

  test('the fix names the edit that resolves it, and the edit differs by kind', () => {
    const orgless = userActor({ id: 'user-2' });
    const orgFix = caught(() =>
      subjectIdOf({ key: 'a.flag', kind: 'org', actor: orgless, subjects: {}, via: 'orgs' }),
    ) as { fix: string };
    expect(orgFix.fix).toContain('orgId');

    const bankFix = caught(() =>
      subjectIdOf({ key: 'a.flag', kind: 'bank', actor, subjects: {}, via: 'subjects' }),
    ) as { fix: string };
    expect(bankFix.fix).toContain('isEnabled("a.flag"');
    // A computed key, so a kind that is not an identifier still parses — see errors.test.ts.
    expect(bankFix.fix).toContain('{ ["bank"]:');
    expect(bankFix.fix).toContain('bank');
  });

  test('a kind named after an Object.prototype member is absent, not inherited', () => {
    // `subjects.toString` walks the prototype chain and finds a function. Without an own-property
    // check the resolver returns it instead of raising, and the failure downstream is a weird one
    // — a function where an id belongs — rather than the clean error this package designed.
    for (const inherited of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
      expect(
        caught(() =>
          subjectIdOf({ key: 'a.flag', kind: inherited, actor, subjects: {}, via: 'subjects' }),
        ),
      ).toBeUltimateError('X_FLAG_SUBJECT_REQUIRED');
    }
  });

  test('an own value that is not a string is absent — an id is a string or it is nothing', () => {
    const notAString: unknown = { bank: 42 };
    expect(
      caught(() =>
        subjectIdOf({
          key: 'a.flag',
          kind: 'bank',
          actor,
          subjects: notAString as FlagSubjects,
          via: 'subjects',
        }),
      ),
    ).toBeUltimateError('X_FLAG_SUBJECT_REQUIRED');
  });

  test('actor and org are the built-ins, and nothing else is', () => {
    expect([...BUILT_IN_SUBJECT_KINDS]).toEqual(['actor', 'org']);
  });
});

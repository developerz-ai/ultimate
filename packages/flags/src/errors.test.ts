import { describe, expect, test } from 'bun:test';
import { hasErrorCode } from '@ultimat3/core';
import {
  FLAGS_ERROR_CODES,
  FLAGS_ERROR_TITLES,
  flagDuplicate,
  flagExpired,
  flagExpiryInvalid,
  flagSubjectRequired,
  flagTargetingInvalid,
  flagUnknown,
} from './errors';

describe('unit · @ultimat3/flags errors', () => {
  test('every declared code is namespaced and screaming snake case', () => {
    for (const code of FLAGS_ERROR_CODES) {
      expect(code).toMatch(/^X_[A-Z0-9_]+$/);
    }
  });

  test('every declared code has a title and is in the framework registry at import', () => {
    for (const code of FLAGS_ERROR_CODES) {
      expect(FLAGS_ERROR_TITLES[code].length).toBeGreaterThan(0);
      expect(hasErrorCode(code)).toBe(true);
    }
  });

  test('every factory carries its code, a concrete cause and a fix naming a call or a key', () => {
    const errors = [
      flagDuplicate('search.rerank'),
      flagUnknown('search.rerank', ['search.rerank']),
      flagTargetingInvalid('search.rerank', 'rollout is 0.5'),
      flagSubjectRequired({ key: 'search.rerank', kind: 'org', actorId: 'user-7', via: 'orgs' }),
      flagExpiryInvalid('search.rerank', undefined),
      flagExpired({
        key: 'search.rerank',
        owner: 'search',
        expiresAt: '2026-01-01',
        overdueDays: 63,
      }),
    ];
    expect(errors.map((error) => error.code).sort()).toEqual([...FLAGS_ERROR_CODES]);
    for (const error of errors) {
      expect(error).toBeUltimateError(error.code);
      expect(error.cause).toContain('search.rerank');
      expect(error.fix.length).toBeGreaterThan(0);
      expect(error.docs).toBe(`https://ultimate.dev/errors/${error.code}`);
      expect(error.meta?.['key']).toBe('search.rerank');
    }
  });

  test('the expired report names the owner and how overdue it is — a report nobody can action is noise', () => {
    const error = flagExpired({
      key: 'search.rerank',
      owner: 'search',
      expiresAt: '2026-01-01',
      overdueDays: 63,
    });
    expect(error.cause).toContain('63');
    expect(error.cause).toContain('search');
    expect(error.fix).toContain("kind: 'permanent'");
  });
});

/**
 * Axiom 4: a `fix:` is an instruction, and an instruction that does not parse is not one. The
 * subject kind and the actor id are app-supplied, so neither can be pasted into a JS literal
 * unquoted — treasury's own ids are `bank_integration:<name>`, and a `bank-integration` kind is
 * one hyphen away from an invalid object key.
 */
describe('unit · the subject fix is executable JavaScript', () => {
  /** `new Function` parses without running, which is exactly the question being asked. */
  const parses = (snippet: string): boolean => {
    try {
      new Function('actor', 'isEnabled', 'userActor', snippet);
      return true;
    } catch {
      return false;
    }
  };

  const snippetOf = (fix: string, call: string): string => {
    const found = fix.match(new RegExp(`${call}\\([^—]*\\}\\)`))?.[0];
    expect(found).toBeDefined();
    return found ?? '';
  };

  test('a kind that is not a valid identifier still yields a parseable call', () => {
    const error = flagSubjectRequired({
      key: 'scraper.persist-profile',
      kind: 'bank-integration',
      actorId: 'user-7',
      via: 'subjects',
    });
    expect(parses(snippetOf(error.fix, 'isEnabled'))).toBe(true);
  });

  test('a key or actor id carrying a quote does not break the fix', () => {
    const record = flagSubjectRequired({
      key: 'flag\'with"quotes',
      kind: 'bank-integration',
      actorId: 'actor\'with"quotes',
      via: 'subjects',
    });
    expect(parses(snippetOf(record.fix, 'isEnabled'))).toBe(true);

    const org = flagSubjectRequired({
      key: 'flag\'with"quotes',
      kind: 'org',
      actorId: 'actor\'with"quotes',
      via: 'orgs',
    });
    expect(parses(snippetOf(org.fix, 'userActor'))).toBe(true);
  });
});

describe('an error constructor never loses its refusal to a hostile value', () => {
  // JSON.stringify throws on a bigint or a cycle, and RUNS a toJSON the value carries. Before this
  // guard, three of these replaced X_FLAG_EXPIRY_INVALID with an unrelated throw, so a caller
  // matching on the code caught nothing. Found by the entity slice hitting the same class.
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;

  const hostile: readonly (readonly [string, unknown])[] = [
    ['bigint', 10n],
    ['cyclic object', cyclic],
    ['symbol', Symbol('nope')],
    [
      'throwing toJSON',
      {
        toJSON: () => {
          throw new Error('boom');
        },
      },
    ],
    [
      'throwing toString',
      {
        toString: () => {
          throw new Error('boom');
        },
      },
    ],
    ['undefined', undefined],
  ];

  for (const [label, given] of hostile) {
    test(`${label} still yields X_FLAG_EXPIRY_INVALID`, () => {
      const error = flagExpiryInvalid('beta.feature', given);
      expect(error.code, label).toBe('X_FLAG_EXPIRY_INVALID');
      expect(error.cause, label).toContain('beta.feature');
      expect(error.fix, label).toContain("defineFlag({ key: 'beta.feature' })");
    });
  }
});

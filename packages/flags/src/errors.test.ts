import { describe, expect, test } from 'bun:test';
import { hasErrorCode } from '@ultimat3/core';
import {
  FLAGS_ERROR_CODES,
  FLAGS_ERROR_TITLES,
  flagDuplicate,
  flagExpired,
  flagExpiryInvalid,
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

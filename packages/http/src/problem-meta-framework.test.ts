// The framework's own public `meta` keys: one reviewed table, held to rules a test enforces — a
// framework code, a 4xx refusal addressed to the caller, keys an app's declaration could also
// carry, and none whose name says secret. What `toProblem` does with them is the second describe.
import { afterEach, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { toProblem } from './error-facts';
import { ERROR_STATUS } from './error-map';
import {
  metaKeyRefusal,
  problemMetaKeysFor,
  registerProblemMeta,
  resetProblemMeta,
} from './problem-meta';
import { FRAMEWORK_PROBLEM_META } from './problem-meta-framework';

/** A name that says what it holds is not a caller's: credentials, internals, raw input. */
const SECRET_SHAPED =
  /secret|token|password|passwd|credential|cookie|session|key$|hash|salt|sql|stack|excerpt|body|path|email|ip$/i;

const statusOf = (code: string): number | undefined =>
  Object.hasOwn(ERROR_STATUS, code) ? ERROR_STATUS[code as keyof typeof ERROR_STATUS] : undefined;

describe('FRAMEWORK_PROBLEM_META', () => {
  test('names X_METER_EXCEEDED’s meter, limit and resetsAt — and never its retryAfterSeconds', () => {
    expect(FRAMEWORK_PROBLEM_META.get('X_METER_EXCEEDED')).toEqual(['meter', 'limit', 'resetsAt']);
    expect(problemMetaKeysFor('X_METER_EXCEEDED')).toEqual(['meter', 'limit', 'resetsAt']);
  });

  test('every row is a framework code answered 4xx: a 5xx’s meta is the operator’s alone', () => {
    for (const code of FRAMEWORK_PROBLEM_META.keys()) {
      const status = statusOf(code);
      expect({ code, status: status !== undefined && status >= 400 && status < 500 }).toEqual({
        code,
        status: true,
      });
    }
  });

  test('every key passes the rule an app’s keys pass, and none is secret-shaped', () => {
    for (const [code, keys] of FRAMEWORK_PROBLEM_META) {
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect({ code, key, refusal: metaKeyRefusal(key) }).toEqual({
          code,
          key,
          refusal: undefined,
        });
        expect({ code, key, secretShaped: SECRET_SHAPED.test(key) }).toEqual({
          code,
          key,
          secretShaped: false,
        });
      }
    }
  });

  test('an app still cannot re-declare a framework row — the table is not negotiable', () => {
    expect(() => registerProblemMeta({ X_METER_EXCEEDED: ['meter', 'subject'] })).toThrow(
      'X_PROBLEM_META_INVALID',
    );
    expect(problemMetaKeysFor('X_METER_EXCEEDED')).toEqual(['meter', 'limit', 'resetsAt']);
  });

  test('every other framework code still carries nothing', () => {
    expect(problemMetaKeysFor('X_RATE_LIMITED')).toBeUndefined();
    expect(problemMetaKeysFor('X_BODY_INVALID')).toBeUndefined();
  });
});

describe('toProblem, for a framework row', () => {
  afterEach(resetProblemMeta);

  const exceeded = (meta: Record<string, unknown>) =>
    new UltimateError({
      code: 'X_METER_EXCEEDED',
      cause: 'the "posts" meter allows 100 calls per day (UTC)',
      fix: 'x actions show createPost --json',
      meta,
    });

  test('carries exactly the declared keys; an undeclared one never crosses', () => {
    const problem = toProblem(
      exceeded({
        meter: 'posts',
        limit: 100,
        resetsAt: '2026-11-07T00:00:00.000Z',
        retryAfterSeconds: 3600,
        subject: 'org:tenant-secret-id',
      }),
    );
    expect(problem.status).toBe(429);
    expect(problem.meta).toEqual({
      meter: 'posts',
      limit: 100,
      resetsAt: '2026-11-07T00:00:00.000Z',
    });
    expect(JSON.stringify(problem)).not.toContain('tenant-secret-id');
    expect(JSON.stringify(problem)).not.toContain('retryAfterSeconds');
  });
});

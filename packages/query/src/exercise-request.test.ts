// The read's contract step honours an entry's `request`: a read scoped by a cookie the browser
// sends fails without it and answers with it. Action's `exercise-request.test.ts`, twinned.

import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { isUltimateError } from '@ultimat3/core';
import { useRequestCookie } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { exerciseQuery } from './exercise';
import { query } from './query';
import { from } from './source';

const MEMBER: Actor = {
  kind: 'user',
  id: 'u-9',
  orgId: 'org-9',
  roles: ['member'],
  scopes: [],
  permissions: [],
};

const seen: (string | null)[] = [];

/** The sessions this browser holds, read off the cookie that names the current one. */
const currentSessions = query({
  input: t.object({}),
  policy: allow(),
  sql: () => {
    seen.push(useRequestCookie('sid'));
    return from<{ id: string }>('sessions', [{ id: 's' }]);
  },
}).named('exreqCurrentSessions');

describe('the read contract step and an entry request', () => {
  test('with no request declared sql() has none: X_CONTRACT_DEFECT on X_NO_REQUEST', async () => {
    let failure: unknown;
    try {
      await exerciseQuery(currentSessions, { actor: MEMBER, runs: 1 });
    } catch (error) {
      failure = error;
    }
    expect(isUltimateError(failure) && [failure.code, failure.meta?.['failure']]).toEqual([
      'X_CONTRACT_DEFECT',
      expect.objectContaining({ code: 'X_NO_REQUEST' }),
    ]);
  });

  test('a function request is built for the reader and read inside sql()', async () => {
    seen.length = 0;
    const report = await exerciseQuery(currentSessions, {
      actor: MEMBER,
      runs: 2,
      request: (actor) => ({ cookies: { sid: `sid-of-${actor?.id}` } }),
    });
    expect({ reached: report.reached, seen }).toEqual({
      reached: 2,
      seen: ['sid-of-u-9', 'sid-of-u-9'],
    });
  });
});

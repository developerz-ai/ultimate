// The pass calls an action as an HTTP request would reach it: a handler that reads the request (a
// session action setting its cookie) finds one, as the actor the pass chose — and an entry's
// `request` puts the cookies a cookie-held step needs on it (`@ultimat3/http`'s `withRequestAs`).

import { describe, expect, test } from 'bun:test';
import { action, invoke, t } from '@ultimat3/action';
import { registerActions } from '@ultimat3/action/loader';
import type { Actor } from '@ultimat3/core';
import { isUltimateError, UltimateError, useContext } from '@ultimat3/core';
import { useRequestContext, useRequestCookie } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { withExerciseRequest } from './exercise-request';
import { testName } from './test-types';

const MEMBER: Actor = {
  kind: 'user',
  id: 'u-1',
  orgId: 'org-1',
  roles: ['member'],
  scopes: [],
  permissions: [],
};

/** A second factor finished off a cookie the first step set: no cookie, no step. */
const exrqFinishSignIn = action({
  input: t.object({ code: t.string.min(1).max(12) }),
  output: t.object({ ok: t.boolean }),
  policy: allow(),
  async handle() {
    if (useRequestCookie('exrq_pending') === null) {
      throw new UltimateError({
        code: 'X_NOT_FOUND',
        cause: 'no pending sign-in on this request',
        fix: 'start the sign-in first',
      });
    }
    return { ok: true };
  },
});
registerActions({ exrqFinishSignIn });

const failureOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return expect.unreachable('the call resolved');
};

describe(testName('unit', 'exercise request'), () => {
  test('a handler reading the request finds one, carrying the chosen actor', async () => {
    const seen = await withExerciseRequest('createSession', MEMBER, async () => {
      const request = useRequestContext('createSession');
      request.headers.append('set-cookie', 'sid=1');
      return { actor: useContext().actor, cookie: request.headers.get('set-cookie') };
    });
    expect(seen).toEqual({ actor: expect.objectContaining({ id: 'u-1' }), cookie: 'sid=1' });
  });

  test('no actor is the anonymous one, never null on the context', async () => {
    const kind = await withExerciseRequest('health', null, async () => useContext().actor.kind);
    expect(kind).toBe('anonymous');
  });

  test('a cookie-held step is unreached with no request declared, reached with one', async () => {
    const call = () => invoke(exrqFinishSignIn, { code: '123456' }, { surface: 'http' });
    const without = await failureOf(() => withExerciseRequest('exrqFinishSignIn', null, call));
    expect(isUltimateError(without) && without.code).toBe('X_NOT_FOUND');
    const request = { cookies: { exrq_pending: 'p-1' } };
    expect(await withExerciseRequest('exrqFinishSignIn', null, call, request)).toEqual({
      ok: true,
    });
  });
});

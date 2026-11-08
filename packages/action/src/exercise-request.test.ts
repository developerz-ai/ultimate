// The contract step honours an entry's `request`: a handler finishing a cookie-held step fails
// without it and answers with it — the same entry `x exercise` reads.

import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { isUltimateError } from '@ultimat3/core';
import { useRequestCookie, useRequestHeader } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { exerciseAction } from './exercise';

const MEMBER: Actor = {
  kind: 'user',
  id: 'u-7',
  orgId: 'org-7',
  roles: ['member'],
  scopes: [],
  permissions: [],
};

// Uncoded on purpose: a handler's coded 4xx is still a reached run, so only a defect tells a run
// that saw the cookie from one that did not.
// The handler's foreign failure is the test's INPUT, built once and handed over, not a verdict.
const NO_PENDING = new TypeError('no pending sign-in on this request');
const noPending = (): never => {
  throw NO_PENDING;
};
let lastVia: string | null = null;

/** A second factor finished off the cookie the first step set, for the actor that started it. */
const finishSignIn = action({
  input: t.object({ code: t.string.min(1).max(12) }),
  output: t.object({ ok: t.boolean, via: t.string.nullable() }),
  policy: allow(),
  handle: ({ ctx }) => {
    if (useRequestCookie('pending') !== `for-${ctx.actor.id}`) return noPending();
    lastVia = useRequestHeader('x-exercise-via');
    return { ok: true, via: lastVia };
  },
}).named('exreqFinishSignIn');

describe('the contract step and an entry request', () => {
  test('with no request declared the call has none: the cookie read is X_NO_REQUEST', async () => {
    let failure: unknown;
    try {
      await exerciseAction(finishSignIn, { actor: MEMBER, runs: 2 });
    } catch (error) {
      failure = error;
    }
    const failed = isUltimateError(failure) ? failure.meta?.['failure'] : undefined;
    expect([isUltimateError(failure) && failure.code, failed]).toEqual([
      'X_CONTRACT_DEFECT',
      expect.objectContaining({ code: 'X_NO_REQUEST' }),
    ]);
  });

  test('a request without the cookie reaches the handler, which fails: X_CONTRACT_DEFECT', async () => {
    let failure: unknown;
    try {
      await exerciseAction(finishSignIn, { actor: MEMBER, runs: 2, request: { cookies: {} } });
    } catch (error) {
      failure = error;
    }
    expect(isUltimateError(failure) && [failure.code, failure.meta?.['failure']]).toEqual([
      'X_CONTRACT_DEFECT',
      undefined,
    ]);
  });

  test('reached with a declared request: cookies and headers are the inbound request', async () => {
    const report = await exerciseAction(finishSignIn, {
      actor: MEMBER,
      runs: 2,
      request: { cookies: { pending: 'for-u-7' }, headers: { 'x-exercise-via': 'contract' } },
    });
    expect({ reached: report.reached, lastVia }).toEqual({ reached: 2, lastVia: 'contract' });
  });

  test('reached with a function request, built for the actor each run acts as', async () => {
    const seen: (string | undefined)[] = [];
    const report = await exerciseAction(finishSignIn, {
      actor: MEMBER,
      runs: 2,
      request: async (actor) => {
        seen.push(actor?.id);
        return { cookies: { pending: `for-${actor?.id}` } };
      },
    });
    expect({ reached: report.reached, seen }).toEqual({ reached: 2, seen: ['u-7', 'u-7'] });
  });
});

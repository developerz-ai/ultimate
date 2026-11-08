// `withRequestAs`: a test-time call's request, carrying what an exercise entry declares — cookies
// read back exactly, headers as sent, a function built per call for that call's actor — and a
// request no browser could send refused by name.

import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { isUltimateError, useContext } from '@ultimat3/core';
import { useRequestCookie, useRequestHeader } from './context';
import type { ExerciseRequest } from './request-as';
import { withRequestAs } from './request-as';

const MEMBER: Actor = {
  kind: 'user',
  id: 'u-1',
  orgId: 'org-1',
  roles: ['member'],
  scopes: [],
  permissions: [],
};

const failureOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return expect.unreachable('the call resolved');
};

describe('withRequestAs', () => {
  test('no request is a request with no cookie and no header, the actor seated', async () => {
    const seen = await withRequestAs('health', MEMBER, undefined, async () => ({
      cookie: useRequestHeader('cookie'),
      actor: useContext().actor.id,
    }));
    expect(seen).toEqual({ cookie: null, actor: 'u-1' });
  });

  test('declared cookies and headers are the inbound request, a value round-tripping', async () => {
    const seen = await withRequestAs(
      'revokeOtherSessions',
      MEMBER,
      { cookies: { sid: 's-1', spaced: 'a b;c' }, headers: { 'x-exercise-origin': 'app' } },
      async () => ({
        sid: useRequestCookie('sid'),
        spaced: useRequestCookie('spaced'),
        origin: useRequestHeader('x-exercise-origin'),
      }),
    );
    expect(seen).toEqual({ sid: 's-1', spaced: 'a b;c', origin: 'app' });
  });

  test('a function form is awaited before the call, as the call’s actor', async () => {
    const seen: string[] = [];
    const cookie = await withRequestAs(
      'oauthReturn',
      MEMBER,
      async (actor) => {
        seen.push(`${actor?.id}:${useContext().actor.id}`);
        return { cookies: { sid: `session-of-${actor?.id}` } };
      },
      async () => useRequestCookie('sid'),
    );
    expect({ cookie, seen }).toEqual({ cookie: 'session-of-u-1', seen: ['u-1:u-1'] });
  });

  test.each<[string, ExerciseRequest]>([
    ['a cookie name outside the token set', { cookies: { 'bad name': 'v' } }],
    ['a cookie header beside cookies', { headers: { Cookie: 'sid=1' } }],
    ['a header name Headers refuses', { headers: { 'bad header': 'v' } }],
    ['a header value with a line break', { headers: { 'x-a': 'one\r\ntwo' } }],
  ])('%s is X_EXERCISE_REQUEST_INVALID, its fix naming the entry', async (_label, request) => {
    const failure = await failureOf(() =>
      withRequestAs('oauthReturn', MEMBER, request, async () => 'ran'),
    );
    expect(isUltimateError(failure) && [failure.code, failure.fix.includes('oauthReturn')]).toEqual(
      ['X_EXERCISE_REQUEST_INVALID', true],
    );
  });
});

// The pass calls an action as an HTTP request would reach it: a handler that reads the request (a
// session action setting its cookie) finds one, as the actor the pass chose.

import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { useContext } from '@ultimat3/core';
import { useRequestContext } from '@ultimat3/http';
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
});

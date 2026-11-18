// The server half of a queued write's binding, over the real pipeline: a replay naming a principal
// runs only under that principal's session, and is refused before anything of the action runs.

import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import {
  CLIENT_REPLAY_SCOPE_HEADER,
  clientScopeId,
  principalScopeName,
  userActor,
} from '@ultimat3/core';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { toRoute } from './http';

const alice = userActor({ id: 'alice' });
const bob = userActor({ id: 'bob' });

const keyOf = (actor: Actor): string => {
  const scope = clientScopeId(actor);
  return principalScopeName(scope === '' ? null : scope);
};

function post(actor: Actor | null, named: string | undefined) {
  const runs = { handled: 0 };
  const target = action({
    input: t.object({ n: t.number }),
    output: t.object({ ok: t.boolean }),
    policy: allow('public'),
    handle: () => {
      runs.handled += 1;
      return { ok: true };
    },
  }).named('likePost');
  const server = httpServer({
    routes: [toRoute(target)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => actor },
  });
  const answer = server.fetch(
    new Request('http://dev.test/api/posts/like', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://dev.test',
        ...(named === undefined ? {} : { [CLIENT_REPLAY_SCOPE_HEADER]: named }),
      },
      body: JSON.stringify({ n: 1 }),
    }),
  );
  return { answer, runs };
}

describe('a replay that names its principal', () => {
  test('runs under that principal', async () => {
    const { answer, runs } = post(alice, keyOf(alice));
    expect((await answer).status).toBe(200);
    expect(runs.handled).toBe(1);
  });

  test('under another signed-in session is 409 X_REPLAY_PRINCIPAL_MISMATCH, and nothing ran', async () => {
    const { answer, runs } = post(bob, keyOf(alice));
    const response = await answer;
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string; fix: string };
    expect(body.code).toBe('X_REPLAY_PRINCIPAL_MISMATCH');
    expect(body.fix).toContain('pageOutbox().replay()');
    expect(runs.handled).toBe(0);
  });

  test('never renders either principal into the refusal', async () => {
    const text = await (await post(bob, keyOf(alice)).answer).text();
    expect(text).not.toContain(clientScopeId(alice));
    expect(text).not.toContain(clientScopeId(bob));
  });

  test('a signed-in queue is refused under an anonymous session on a public action', async () => {
    const { answer, runs } = post(null, keyOf(alice));
    expect((await answer).status).toBe(409);
    expect(runs.handled).toBe(0);
  });

  test('an anonymous queue is refused under a signed-in session, and runs under none', async () => {
    const signedIn = post(alice, 'anon');
    expect((await signedIn.answer).status).toBe(409);
    expect(signedIn.runs.handled).toBe(0);
    const anonymous = post(null, 'anon');
    expect((await anonymous.answer).status).toBe(200);
    expect(anonymous.runs.handled).toBe(1);
  });

  test('a blank name is no principal and is refused, never read as absent', async () => {
    const { answer, runs } = post(alice, '');
    expect((await answer).status).toBe(409);
    expect(runs.handled).toBe(0);
  });
});

test('a write that names nobody is untouched: every online call and every older tab', async () => {
  const { answer, runs } = post(alice, undefined);
  expect((await answer).status).toBe(200);
  expect(runs.handled).toBe(1);
});

// The consent decision is a PERSON's. An OAuth-connected agent holds its person's role, so the
// grant alone would let it approve a second connection for itself; the rule refuses every actor
// that is not a user, whatever it holds.

import { expect, test } from 'bun:test';
import { agentActor, userActor } from '@ultimat3/core';
import { evaluate } from '@ultimat3/policy';
import { oauthConsent } from './policy';

const decide = (actor: ReturnType<typeof userActor>): boolean =>
  // A DIRECT grant, not the `member` role: role definitions are process-global (see
  // `friends/policy.test.ts`), and this rule is about the actor's kind, not its grants.
  evaluate(oauthConsent, { input: {}, actor: { ...actor, permissions: ['oauth:consent'] } })
    .allowed;

test('unit · a signed-in person may answer a consent request', () => {
  expect(decide(userActor({ id: 'u1' }))).toBe(true);
});

test('unit · an agent holding the same grant may not', () => {
  expect(
    decide(agentActor({ id: 'oauth:c1', onBehalfOf: { actorKind: 'user', actorId: 'u1' } })),
  ).toBe(false);
});

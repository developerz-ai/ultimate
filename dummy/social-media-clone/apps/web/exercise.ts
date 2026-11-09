// What `x exercise` cannot guess about the social demo: who an actor is (a `users` row), the input
// the minimal draw plus seeded ids cannot reach, and why a primitive cannot run in the pass at all.
// Each entry is the value a `.contract({ exercise })` takes, so a test and the pass share a shape.

import { schema } from '@social-media-clone/db';
import { defineExercise } from '@ultimat3/testing';
import { MCP_SCOPE, mcpOAuth } from './app/oauth/server';

/**
 * A live authorization request for a client registered just now, as the consent form posts it back:
 * the draw's `request` is no query any client sent, so without one both decisions stop at
 * `X_OAUTH_REQUEST_INVALID` before their handler's body.
 */
const consentRequest = async (): Promise<{ request: string }> => {
  const redirect = 'http://127.0.0.1:33418/callback';
  const { client } = await mcpOAuth.registerClient({ name: 'Exercise', redirectUris: [redirect] });
  const request = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: redirect,
    code_challenge: 'c'.repeat(43),
    code_challenge_method: 'S256',
    scope: MCP_SCOPE,
  });
  return { request: request.toString() };
};

export const exercise = defineExercise(
  {
    approveConnection: { input: consentRequest },
    denyConnection: { input: consentRequest },
    // `instant` is a bare string (`tasks/instant.ts`): the draw's `sample` is no instant at all.
    sweepOrphanMedia: { actor: null, input: () => ({ before: '2026-01-01T00:00:00.000Z' }) },

    createAccount: {
      off: 'ends by setting the session cookie on an HTTP response; there is no request',
    },
    createSession: { off: 'signs in with a password; the seed writes no credential to match' },
    destroySession: { off: 'clears the session cookie on an HTTP response; there is no request' },
    respondFriend: {
      off: 'only the addressee answers, and the pass cannot tell which side of a request is which',
    },
    liveThread: {
      off: 'reads a thread its actor takes part in, through participants: a join no id field names',
    },
    resetDemo: { off: 'refuses any database that does not hold the demo seed, by design' },
  },
  { actor: schema.users },
);

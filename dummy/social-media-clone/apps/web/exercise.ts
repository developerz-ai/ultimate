// What `x exercise` cannot guess about the social demo: who an actor is (a `users` row), the input
// the minimal draw plus seeded ids cannot reach, and why a primitive cannot run in the pass at all.
// Each entry is the value a `.contract({ exercise })` takes, so a test and the pass share a shape.

import { db, schema } from '@social-media-clone/db';
import { useContext } from '@ultimat3/core';
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

/**
 * A thread the viewer takes part in, opened for it: a seeded conversation has participants the
 * pass drew, never the actor, and a non-participant is refused before any read (`threadFor`).
 */
const ownThread = async (): Promise<{ id: string }> => {
  const viewer = useContext().actor.id;
  const conversation = await db.conversations.insert({ kind: 'direct', title: null });
  await db.participants.insert({ conversationId: conversation.id, userId: viewer });
  return { id: conversation.id };
};

/** The viewer's own profile: its handle is a column, never a key a param could be bound to. */
const ownHandle = async (): Promise<{ handle: string }> => {
  const viewer = await db.users.where({ id: useContext().actor.id }).one();
  return { handle: viewer?.handle ?? 'exercise-nobody' };
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
  {
    actor: schema.users,
    routes: {
      '/messages/:id': { params: ownThread },
      '/u/:handle': { params: ownHandle },
      // A consent screen reads the authorization request in its URL: one a client just sent.
      '/oauth/consent': {
        search: async () => (await consentRequest()).request,
        empty:
          'the pass names no DATABASE_URL, so the OAuth store is in memory: the read sends no SQL',
      },
      '/signin': { empty: 'reads only the last refused sign-in from its own request: no row' },
      '/signup': { empty: 'reads only the last refused sign-up from its own request: no row' },
    },
  },
);

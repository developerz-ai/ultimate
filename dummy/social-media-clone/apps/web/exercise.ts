// What `x exercise` cannot guess about the social demo: who an actor is (a `users` row), the input
// the minimal draw plus seeded ids cannot reach, and why a primitive cannot run in the pass at all.
// Each entry is the value a `.contract({ exercise })` takes, so a test and the pass share a shape.

import { schema } from '@social-media-clone/db';
import { defineExercise } from '@ultimat3/testing';

export const exercise = defineExercise(
  {
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

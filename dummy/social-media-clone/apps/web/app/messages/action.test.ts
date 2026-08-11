// unit — the send path, end to end through `invoke`: input parse, row loader, policy, handler.
// The store is the in-process memory driver every `x dev` and every test shares.
//
// Failure cases first. A non-participant must be refused by the ACTION and not merely by the page,
// and a blank body must be refused by the entity invariant rather than by a second `trim()` guard
// that only one of the two write paths runs.

import { db } from '@social-media-clone/db';
import { createContext, isUltimateError, userActor } from '@ultimat3/core';
import type { Actor } from '@ultimat3/policy';
import { expect, unitTest } from '@ultimat3/testing';
import { sendMessage } from './action';
import * as repo from './repo';

const ADA = '00000000-0000-4000-8000-0000000000a1';
const BRUNO = '00000000-0000-4000-8000-0000000000b1';
const MARA = '00000000-0000-4000-8000-0000000000c1';
const ROOM = '00000000-0000-4000-8000-0000000000f2';

const member = (id: string): Actor => ({
  ...userActor({ id }),
  permissions: ['message:read', 'message:send'],
});

const seeded = (async () => {
  await db.conversations.insert({ id: ROOM, kind: 'direct' });
  await repo.addParticipant(ROOM, ADA);
  await repo.addParticipant(ROOM, BRUNO);
})();

/** Every code an Ultimate error carries, or the raw value — never a swallowed failure. */
const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return 'no error';
  } catch (error) {
    return isUltimateError(error) ? error.code : String(error);
  }
};

// Named here because every projection needs a stable name and this file does not boot the app.
// At boot `registerActions` stamps the same name onto the same object.
const target = sendMessage.named('sendMessage');

const call = (actor: Actor | null, input: { conversationId: string; body: string }) =>
  target(input, { ctx: createContext({ actor: actor ?? undefined }), actor, surface: 'http' });

unitTest('a non-participant is refused, even holding message:send', async () => {
  await seeded;
  expect(await codeOf(call(member(MARA), { conversationId: ROOM, body: 'let me in' }))).toBe(
    'X_FORBIDDEN',
  );
  // And nothing was written: a denial that still inserts is not a denial.
  expect((await repo.threadPage(ROOM)).length).toBe(0);
});

unitTest('a conversation nobody is in refuses exactly the same way', async () => {
  await seeded;
  const absent = '00000000-0000-4000-8000-0000000000f9';
  expect(await codeOf(call(member(ADA), { conversationId: absent, body: 'hello?' }))).toBe(
    'X_FORBIDDEN',
  );
});

unitTest('an anonymous caller is X_UNAUTHENTICATED, not X_FORBIDDEN', async () => {
  await seeded;
  expect(await codeOf(call(null, { conversationId: ROOM, body: 'hi' }))).toBe('X_UNAUTHENTICATED');
});

unitTest(
  'a blank body is refused by the entity invariant, not by a second copy of the rule',
  async () => {
    await seeded;
    // Three spaces: a `min(1)` on the input schema would wave this through, which is exactly why
    // the action declares no minimum and `messages.message_body_present` (trimmed, minLength 1) is
    // the one declaration — enforced here and as a Postgres CHECK from the same line.
    expect(await codeOf(call(member(ADA), { conversationId: ROOM, body: '   ' }))).toBe(
      'X_INVARIANT_VIOLATED',
    );
    expect((await repo.threadPage(ROOM)).length).toBe(0);
  },
);

unitTest('a participant sends, and every OTHER participant gets one notification', async () => {
  await seeded;
  const sent = await call(member(ADA), { conversationId: ROOM, body: 'first' });
  expect(sent.body).toBe('first');
  expect(sent.authorId).toBe(ADA);

  const inbox = await db.notifications.where({ userId: BRUNO }).orderBy('id').limit(10).all();
  expect(inbox.length).toBe(1);
  expect(inbox[0]?.kind).toBe('message');
  // The author does not notify themselves — the row set is "everyone but me", not "everyone".
  expect((await db.notifications.where({ userId: ADA }).limit(10).all()).length).toBe(0);
});

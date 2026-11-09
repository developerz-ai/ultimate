// unit — the inbox read is served at `GET /_x/query/inbox` with the channel params as its input, so
// it must refuse exactly what the channel refuses: a signed-in member naming somebody else's
// `userId` read their notifications (and, through `actorId`, who interacts with them) — plan 101 R9.

import { ctxOf, isUltimateError, userActor } from '@ultimat3/core';
import type { Actor } from '@ultimat3/policy';
import { expect, unitTest } from '@ultimat3/testing';
import { ownInbox } from '../policy';
import * as repo from '../repo';
import { inboxChannel } from '../topics';
import { inbox } from './inbox';

const ADA = '00000000-0000-4000-8000-0000000000a7';
const MARA = '00000000-0000-4000-8000-0000000000c7';

const member = (id: string): Actor => ({
  ...userActor({ id }),
  permissions: ['notification:read', 'notification:mark-read'],
});

// Named here because every projection needs a stable name and this file does not boot the app.
const target = inbox.named('inbox');

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return 'no error';
  } catch (error) {
    return isUltimateError(error) ? error.code : String(error);
  }
};

unitTest("a member asking for another user's inbox is refused, and reads nothing", async () => {
  await repo.insertNotification({ userId: MARA, kind: 'message', actorId: ADA });
  const ada = member(ADA);
  const code = await codeOf(
    target({ userId: MARA }, { ctx: ctxOf({ actor: ada }), actor: ada, surface: 'http' }),
  );
  expect(code).toBe('X_FORBIDDEN');
});

unitTest('the owner reads their own inbox through the same read', async () => {
  const row = await repo.insertNotification({ userId: ADA, kind: 'post-liked', actorId: MARA });
  const ada = member(ADA);
  const rows = await target(
    { userId: ADA },
    { ctx: ctxOf({ actor: ada }), actor: ada, surface: 'http' },
  );
  expect(rows.map((r) => r.id)).toContain(row.id);
  expect(rows.every((r) => r.userId === ADA)).toBe(true);
});

unitTest('the catch-up read and the channel decide with ONE policy object', () => {
  expect(inbox.policy).toBe(ownInbox);
  expect(inboxChannel.policy).toBe(ownInbox);
});
